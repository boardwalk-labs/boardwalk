// SPDX-License-Identifier: Apache-2.0

// Conformance: program-level human-in-the-loop (durable suspension).
//
// A workflow that calls humanInput() SUSPENDS — it releases its process and parks in
// `awaiting_input` until a person responds through the control plane. The answer resolves the
// pending journal entry; the run resumes (a fresh process replays the journal) and the
// humanInput() call returns the validated response. The model is never involved.

import { afterEach, describe, expect, it } from "vitest";
import { createEngine, disposeEngines, pause, statusesOf, waitForStatus } from "./harness.js";

afterEach(disposeEngines);

const APPROVAL_PROGRAM = `
  import { humanInput, output } from "@boardwalk-labs/workflow";
  export const meta = { slug: "approval", triggers: [{ kind: "manual" }] };
  const decision = await humanInput({
    key: "approve",
    prompt: "Approve sending?",
    input: { kind: "choice", options: ["Approve", "Reject"] },
  });
  output({ decision });
`;

describe("conformance: human-in-the-loop", () => {
  it("suspends on humanInput(), parks until answered, then resumes with the validated response", async () => {
    const { engine } = createEngine();
    engine.deployWorkflow({ program: APPROVAL_PROGRAM });

    const run = engine.startRun("approval");
    await waitForStatus(engine, run.id, "awaiting_input");

    // Parked, not running: a pending gate exists and the run does not progress on its own.
    const pending = engine.listInputRequests({ runId: run.id, statuses: ["pending"] });
    expect(pending).toHaveLength(1);
    expect(pending[0]?.key).toBe("approve");
    expect(pending[0]?.prompt).toBe("Approve sending?");
    await pause(150);
    expect(engine.store.getRun(run.id)?.status).toBe("awaiting_input");

    // A person answers through the control plane; the run resumes and completes.
    engine.respondToInput(run.id, "approve", { value: "Approve", isOther: false });
    await waitForStatus(engine, run.id, "completed");

    const done = engine.store.getRun(run.id);
    expect(done?.output).toEqual({ decision: { value: "Approve", isOther: false } });
    // The lifecycle stream records the suspend + the gate + the resolution + the resume.
    const statuses = statusesOf(engine, run.id);
    expect(statuses).toContain("awaiting_input");
    expect(statuses.at(-1)).toBe("completed");
    const kinds = engine.store.listEvents(run.id).map((row) => row.event.kind);
    expect(kinds).toContain("suspended");
    expect(kinds).toContain("human_input_requested");
    expect(kinds).toContain("human_input_resolved");
    expect(kinds).toContain("resumed");
  }, 20_000);

  it("validates the response against the input spec and rejects an out-of-options answer", async () => {
    const { engine } = createEngine();
    engine.deployWorkflow({ program: APPROVAL_PROGRAM });
    const run = engine.startRun("approval");
    await waitForStatus(engine, run.id, "awaiting_input");

    // "Maybe" is not an offered option and isOther is false → VALIDATION; the run stays parked.
    expect(() =>
      engine.respondToInput(run.id, "approve", { value: "Maybe", isOther: false }),
    ).toThrow(/not one of the offered options/);
    expect(engine.store.getRun(run.id)?.status).toBe("awaiting_input");

    // A correct answer then resumes it.
    engine.respondToInput(run.id, "approve", { value: "Reject", isOther: false });
    await waitForStatus(engine, run.id, "completed");
    expect(engine.store.getRun(run.id)?.output).toEqual({
      decision: { value: "Reject", isOther: false },
    });
  }, 20_000);

  it("a second response loses: the first answer wins, the duplicate is a conflict", async () => {
    const { engine } = createEngine();
    engine.deployWorkflow({ program: APPROVAL_PROGRAM });
    const run = engine.startRun("approval");
    await waitForStatus(engine, run.id, "awaiting_input");

    engine.respondToInput(run.id, "approve", { value: "Approve", isOther: false });
    // The gate is no longer pending; a second response (any) cannot find it.
    expect(() =>
      engine.respondToInput(run.id, "approve", { value: "Reject", isOther: false }),
    ).toThrow(/No pending human-input request/);
    await waitForStatus(engine, run.id, "completed");
  }, 20_000);

  it("replay is silent: pre-suspend console output is not duplicated on resume", async () => {
    const { engine } = createEngine();
    engine.deployWorkflow({
      program: `
        import { humanInput, output } from "@boardwalk-labs/workflow";
        export const meta = { slug: "logged", triggers: [{ kind: "manual" }] };
        console.log("BEFORE-GATE");
        const note = await humanInput({ key: "note", prompt: "Note", input: { kind: "text" } });
        console.log("AFTER-GATE");
        output(note);
      `,
    });

    const run = engine.startRun("logged");
    await waitForStatus(engine, run.id, "awaiting_input");
    engine.respondToInput(run.id, "note", { value: "ok" });
    await waitForStatus(engine, run.id, "completed");

    // The program re-ran from the top on resume, but BEFORE-GATE (emitted pre-suspend) must appear
    // exactly once; AFTER-GATE (new, post-resume) appears once.
    const stdout = engine.store
      .listEvents(run.id)
      .filter((row) => row.event.kind === "program_output")
      .map((row) => (row.event.kind === "program_output" ? row.event.text : ""))
      .join("");
    expect(stdout.match(/BEFORE-GATE/g) ?? []).toHaveLength(1);
    expect(stdout.match(/AFTER-GATE/g) ?? []).toHaveLength(1);
  }, 20_000);

  it("free text via a text gate round-trips", async () => {
    const { engine } = createEngine();
    engine.deployWorkflow({
      program: `
        import { humanInput, output } from "@boardwalk-labs/workflow";
        export const meta = { slug: "note", triggers: [{ kind: "manual" }] };
        const note = await humanInput({ key: "note", prompt: "Add a note", input: { kind: "text" } });
        output(note);
      `,
    });
    const run = engine.startRun("note");
    await waitForStatus(engine, run.id, "awaiting_input");
    engine.respondToInput(run.id, "note", { value: "ship it" });
    await waitForStatus(engine, run.id, "completed");
    expect(engine.store.getRun(run.id)?.output).toEqual({ value: "ship it" });
  }, 20_000);
});

// SPDX-License-Identifier: Apache-2.0

// Conformance: program-level human-in-the-loop.
//
// A workflow that calls humanInput() HOLDS its process in `awaiting_input` until a person
// responds through the control plane. The answer is validated against the gate's input spec and
// handed to the live process — the humanInput() call returns it in place, locals intact. The
// model is never involved. The answered request row is durable: a crash-restarted program
// re-reaching the same key gets the stored answer instead of re-asking.

import { afterEach, describe, expect, it } from "vitest";
import {
  createEngine,
  disposeEngines,
  pause,
  statusesOf,
  waitForStatus,
  descriptor,
} from "./harness.js";

afterEach(disposeEngines);

const APPROVAL = {
  descriptor: descriptor({ slug: "approval", triggers: [{ kind: "manual" }] }),
  program: `
  import { humanInput } from "@boardwalk-labs/workflow";
  export default async function run() {
    const decision = await humanInput({
      key: "approve",
      prompt: "Approve sending?",
      input: { kind: "choice", options: ["Approve", "Reject"] },
    });
    return { decision };
  }
`,
};

describe("conformance: human-in-the-loop", () => {
  it("holds on humanInput() until answered, then continues with the validated response", async () => {
    const { engine } = createEngine();
    engine.deployWorkflow(APPROVAL);

    const run = engine.startRun("approval");
    await waitForStatus(engine, run.id, "awaiting_input");

    // Held, not progressing: a pending gate exists and the run waits for a person.
    const pending = engine.listInputRequests({ runId: run.id, statuses: ["pending"] });
    expect(pending).toHaveLength(1);
    expect(pending[0]?.key).toBe("approve");
    expect(pending[0]?.prompt).toBe("Approve sending?");
    await pause(150);
    expect(engine.store.getRun(run.id)?.status).toBe("awaiting_input");

    // A person answers through the control plane; the held call returns and the run completes.
    engine.respondToInput(run.id, "approve", { value: "Approve", isOther: false });
    await waitForStatus(engine, run.id, "completed");

    const done = engine.store.getRun(run.id);
    expect(done?.output).toEqual({ decision: { value: "Approve", isOther: false } });
    // The lifecycle stream records the hold + the gate + the resolution.
    const statuses = statusesOf(engine, run.id);
    expect(statuses).toContain("awaiting_input");
    expect(statuses.at(-1)).toBe("completed");
    const kinds = engine.store.listEvents(run.id).map((row) => row.event.kind);
    expect(kinds).toContain("human_input_requested");
    expect(kinds).toContain("human_input_resolved");
  }, 20_000);

  it("validates the response against the input spec and rejects an out-of-options answer", async () => {
    const { engine } = createEngine();
    engine.deployWorkflow(APPROVAL);
    const run = engine.startRun("approval");
    await waitForStatus(engine, run.id, "awaiting_input");

    // "Maybe" is not an offered option and isOther is false → VALIDATION; the run stays parked.
    expect(() =>
      engine.respondToInput(run.id, "approve", { value: "Maybe", isOther: false }),
    ).toThrow(/not one of the offered options/);
    expect(engine.store.getRun(run.id)?.status).toBe("awaiting_input");

    // A correct answer then releases the hold.
    engine.respondToInput(run.id, "approve", { value: "Reject", isOther: false });
    await waitForStatus(engine, run.id, "completed");
    expect(engine.store.getRun(run.id)?.output).toEqual({
      decision: { value: "Reject", isOther: false },
    });
  }, 20_000);

  it("a second response loses: the first answer wins, the duplicate is a conflict", async () => {
    const { engine } = createEngine();
    engine.deployWorkflow(APPROVAL);
    const run = engine.startRun("approval");
    await waitForStatus(engine, run.id, "awaiting_input");

    engine.respondToInput(run.id, "approve", { value: "Approve", isOther: false });
    // The gate is no longer pending; a second response (any) cannot find it.
    expect(() =>
      engine.respondToInput(run.id, "approve", { value: "Reject", isOther: false }),
    ).toThrow(/No pending human-input request/);
    await waitForStatus(engine, run.id, "completed");
  }, 20_000);

  it("console output around a gate appears exactly once — the process never re-runs", async () => {
    const { engine } = createEngine();
    engine.deployWorkflow({
      descriptor: descriptor({ slug: "logged", triggers: [{ kind: "manual" }] }),
      program: `
        import { humanInput } from "@boardwalk-labs/workflow";
        export default async function run(input, context) {
          console.log("BEFORE-GATE");
          const note = await humanInput({ key: "note", prompt: "Note", input: { kind: "text" } });
          console.log("AFTER-GATE");
          return (note);
        }
      `,
    });

    const run = engine.startRun("logged");
    await waitForStatus(engine, run.id, "awaiting_input");
    engine.respondToInput(run.id, "note", { value: "ok" });
    await waitForStatus(engine, run.id, "completed");

    // The process held straight through the gate: each line streams exactly once, with no
    // replay machinery involved.
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
      descriptor: descriptor({ slug: "note", triggers: [{ kind: "manual" }] }),
      program: `
        import { humanInput } from "@boardwalk-labs/workflow";
        export default async function run(input, context) {
          const note = await humanInput({ key: "note", prompt: "Add a note", input: { kind: "text" } });
          return (note);
        }
      `,
    });
    const run = engine.startRun("note");
    await waitForStatus(engine, run.id, "awaiting_input");
    engine.respondToInput(run.id, "note", { value: "ship it" });
    await waitForStatus(engine, run.id, "completed");
    expect(engine.store.getRun(run.id)?.output).toEqual({ value: "ship it" });
  }, 20_000);
});

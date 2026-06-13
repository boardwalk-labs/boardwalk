// Conformance: run lifecycle (SPEC §3; MASTER_SPEC §2.4).
//
// The base contract every engine must honor for the simplest possible runs: a completing run
// walks queued → pending → running → (output) → completed with a monotonic cursor stream, the
// declared output round-trips exactly, and a failing program lands on `failed` with the error
// carried in BOTH the run row and the terminal run_status event.

import { afterEach, describe, expect, it } from "vitest";
import {
  createEngine,
  disposeEngines,
  expectMonotonicCursors,
  kindsOf,
  statusesOf,
} from "./harness.js";

afterEach(disposeEngines);

const ECHO_PROGRAM = `
import { input, output } from "@boardwalk-labs/workflow";
export const meta = { name: "echo", triggers: [{ kind: "manual" }] };
output({ echoed: input });
`;

describe("conformance: run lifecycle", () => {
  it("a completed run emits queued→pending→running→output→completed with monotonic cursors", async () => {
    const { engine } = createEngine();
    engine.deployWorkflow({ program: ECHO_PROGRAM });

    const queued = engine.startRun("echo", { input: { n: 7 } });
    const done = await engine.waitForRun(queued.id);

    expect(done.status).toBe("completed");
    expect(done.startedAt).not.toBeNull();
    expect(done.endedAt).not.toBeNull();
    expect(kindsOf(engine, done.id)).toEqual([
      "run_status", // queued
      "run_status", // pending
      "run_status", // running
      "output",
      "run_status", // completed
    ]);
    expect(statusesOf(engine, done.id)).toEqual(["queued", "pending", "running", "completed"]);
    expectMonotonicCursors(engine.store.listEvents(done.id));
  }, 20_000);

  it("the declared output round-trips exactly (nested objects, arrays, null)", async () => {
    const { engine } = createEngine();
    engine.deployWorkflow({ program: ECHO_PROGRAM });
    const input = { n: 7, tags: ["a", "b"], nested: { ok: true, none: null } };

    const run = engine.startRun("echo", { input });
    const done = await engine.waitForRun(run.id);

    expect(done.output).toEqual({ echoed: input });
  }, 20_000);

  it("a failing program lands on failed with the error in the terminal run_status event", async () => {
    const { engine } = createEngine();
    engine.deployWorkflow({
      program: `
        export const meta = { name: "boom", triggers: [{ kind: "manual" }] };
        throw new Error("conformance kaboom: the dataset is empty");
      `,
    });

    const run = engine.startRun("boom");
    const done = await engine.waitForRun(run.id);

    expect(done.status).toBe("failed");
    expect(done.error).not.toBeNull();
    expect(done.error?.code.length).toBeGreaterThan(0);
    expect(done.error?.message).toContain("conformance kaboom");

    const last = engine.store.listEvents(run.id).at(-1)?.event;
    expect(last?.kind).toBe("run_status");
    if (last?.kind === "run_status") {
      expect(last.status).toBe("failed");
      expect(last.error?.message).toContain("conformance kaboom");
    }
  }, 20_000);

  it("a verdict output() before a throw is preserved on the failed run (verdict-then-throw)", async () => {
    const { engine } = createEngine();
    engine.deployWorkflow({
      program: `
        import { output } from "@boardwalk-labs/workflow";
        export const meta = { name: "verdict", triggers: [{ kind: "manual" }] };
        output({ healthy: false, reason: "deadline passed" });
        throw new Error("target was not healthy in time");
      `,
    });

    const run = engine.startRun("verdict");
    const done = await engine.waitForRun(run.id);

    expect(done.status).toBe("failed");
    expect(done.output).toEqual({ healthy: false, reason: "deadline passed" });
    expect(done.error?.message).toContain("not healthy");

    // The output event lands BEFORE the failed status (the verdict reads before the failure).
    expect(kindsOf(engine, done.id)).toEqual([
      "run_status", // queued
      "run_status", // pending
      "run_status", // running
      "output",
      "run_status", // failed
    ]);
  }, 20_000);
});

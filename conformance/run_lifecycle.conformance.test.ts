// SPDX-License-Identifier: Apache-2.0

// Conformance: run lifecycle (SPEC §3).
//
// The base contract every engine must honor for the simplest possible runs: a completing run
// walks queued → pending → running → (output) → completed with a monotonic cursor stream, the
// declared output round-trips exactly, and a failing program lands on `failed` with the error
// carried in BOTH the run row and the terminal run_status event.

import { afterEach, describe, expect, it } from "vitest";
import {
  createEngine,
  descriptor,
  disposeEngines,
  expectMonotonicCursors,
  kindsOf,
  statusesOf,
} from "./harness.js";

afterEach(disposeEngines);

const ECHO = {
  descriptor: descriptor({ slug: "echo", triggers: [{ kind: "manual" }] }),
  program: `
export default async function run(input) {
  return { echoed: input };
}
`,
};

describe("conformance: run lifecycle", () => {
  it("a completed run emits queued→pending→running→output→completed with monotonic cursors", async () => {
    const { engine } = createEngine();
    engine.deployWorkflow(ECHO);

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
    engine.deployWorkflow(ECHO);
    const input = { n: 7, tags: ["a", "b"], nested: { ok: true, none: null } };

    const run = engine.startRun("echo", { input });
    const done = await engine.waitForRun(run.id);

    expect(done.output).toEqual({ echoed: input });
  }, 20_000);

  it("a failing program lands on failed with the error in the terminal run_status event", async () => {
    const { engine } = createEngine();
    engine.deployWorkflow({
      descriptor: descriptor({ slug: "boom", triggers: [{ kind: "manual" }] }),
      program: `
        export default async function run() {
          throw new Error("conformance kaboom: the dataset is empty");
        }
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

  it("a void run() completes with a null output and NO output event", async () => {
    const { engine } = createEngine();
    engine.deployWorkflow({
      descriptor: descriptor({ slug: "void", triggers: [{ kind: "manual" }] }),
      program: `
        export default async function run() {
          // side effects only; nothing returned
        }
      `,
    });

    const run = engine.startRun("void");
    const done = await engine.waitForRun(run.id);

    expect(done.status).toBe("completed");
    expect(done.output).toBeNull();
    // A void return is not an author-declared output — no output event on the stream.
    expect(kindsOf(engine, done.id)).toEqual([
      "run_status", // queued
      "run_status", // pending
      "run_status", // running
      "run_status", // completed
    ]);
  }, 20_000);
});

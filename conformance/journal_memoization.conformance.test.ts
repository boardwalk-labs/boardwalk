// SPDX-License-Identifier: Apache-2.0

// Conformance: durable-seam memoization (the journal).
//
// A re-executed run (crash-restart, or — later — a resume) replays from the top, but each
// journaled seam (agent / step) returns its recorded result instead of recomputing. This is
// the substrate durable suspension is built on; it also makes crash recovery cheaper for free.
// The proof: a leaf/step that completed before a crash is NOT run again on the restart pass.

import { afterEach, describe, expect, it } from "vitest";
import { createEngine, disposeEngines, localInference, startFakeProvider } from "./harness.js";

afterEach(disposeEngines);

describe("conformance: journal memoization", () => {
  it("a completed agent() leaf is replayed from the journal — a crash-restart does not re-call the model", async () => {
    const provider = await startFakeProvider();
    provider.respondWith("the-summary", { in: 5, out: 3 });
    try {
      const { engine } = createEngine({ inference: localInference(provider) });
      // First pass: agent() runs (one model call) and is journaled, then the program writes the
      // marker and hard-crashes. Second pass: the marker exists, so agent() must be a journal HIT
      // (no second model call) and the run completes with the memoized result.
      engine.deployWorkflow({
        program: `
          import { existsSync, writeFileSync } from "node:fs";
          import { agent, output } from "@boardwalk-labs/workflow";
          export const meta = { slug: "memoize", triggers: [{ kind: "manual" }] };
          const summary = await agent("summarize the thing");
          if (!existsSync("marker")) { writeFileSync("marker", "1"); process.exit(7); }
          output(summary);
        `,
      });

      const run = engine.startRun("memoize");
      const done = await engine.waitForRun(run.id);

      expect(done.status).toBe("completed");
      expect(done.output).toBe("the-summary");
      expect(done.restarts).toBe(1);
      // The model was called EXACTLY once — the restart pass replayed the journaled leaf.
      expect(provider.requests).toHaveLength(1);
    } finally {
      await provider.close();
    }
  }, 20_000);

  it("step.run runs its function once — the result is memoized across the crash-restart", async () => {
    const { engine } = createEngine();
    // The step's function appends to a workspace file each time it runs. The workspace survives
    // the crash, so if step.run re-ran on the restart the file would have two marks; memoization
    // means it ran once.
    engine.deployWorkflow({
      program: `
        import { existsSync, writeFileSync, appendFileSync, readFileSync } from "node:fs";
        import { step, output } from "@boardwalk-labs/workflow";
        export const meta = { slug: "memo-step", triggers: [{ kind: "manual" }] };
        const n = await step.run("count", () => { appendFileSync("calls", "x"); return 42; });
        if (!existsSync("marker")) { writeFileSync("marker", "1"); process.exit(7); }
        const calls = readFileSync("calls", "utf8").length;
        output({ n, calls });
      `,
    });

    const run = engine.startRun("memo-step");
    const done = await engine.waitForRun(run.id);

    expect(done.status).toBe("completed");
    expect(done.output).toEqual({ n: 42, calls: 1 });
    expect(done.restarts).toBe(1);
  }, 20_000);

  it("a nondeterministic seam shape on replay fails with a determinism error", async () => {
    const { engine } = createEngine();
    // First pass journals a step at seq 1, then crashes. Second pass reaches a DIFFERENT step
    // name at seq 1 (the program branches on the marker) — the fingerprint mismatch is caught.
    engine.deployWorkflow({
      program: `
        import { existsSync, writeFileSync } from "node:fs";
        import { step, output } from "@boardwalk-labs/workflow";
        export const meta = { slug: "nondet", triggers: [{ kind: "manual" }] };
        const first = !existsSync("marker");
        if (first) writeFileSync("marker", "1");
        await step.run(first ? "alpha" : "beta", () => 1);
        if (first) process.exit(7);
        output("unreachable");
      `,
    });

    const run = engine.startRun("nondet");
    const done = await engine.waitForRun(run.id);

    expect(done.status).toBe("failed");
    expect(done.error?.message).toMatch(/[Nn]ondeterministic replay at seam 1/);
  }, 20_000);
});

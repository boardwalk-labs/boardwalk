// Conformance: concurrency modes (SPEC §3 + §2.1).
//
// Concurrency gates DISPATCH, not queueing: under `serial`, a second run stays `queued` until
// the first reaches a terminal status; with no declaration (unlimited), runs of the same
// workflow execute in parallel.

import { afterEach, describe, expect, it } from "vitest";
import type { RunRow } from "../src/index.js";
import { createEngine, disposeEngines, waitFor } from "./harness.js";

afterEach(disposeEngines);

describe("conformance: concurrency", () => {
  it("serial: the second run stays queued until the first is terminal", async () => {
    const { engine } = createEngine();
    engine.deployWorkflow({
      program: `
        import { output, sleep } from "@boardwalk-labs/workflow";
        export const meta = {
          name: "one-by-one",
          triggers: [{ kind: "manual" }],
          concurrency: { mode: "serial" },
        };
        await sleep(500);
        output("done");
      `,
    });

    const a = engine.startRun("one-by-one");
    const b = engine.startRun("one-by-one");
    // While A holds the serial slot, B must still be queued.
    expect(engine.store.getRun(b.id)?.status).toBe("queued");

    const [aDone, bDone] = await Promise.all([
      engine.waitForRun(a.id),
      // B isn't dispatched until a later scheduler pass; drive ticks until the gate opens.
      (async (): Promise<RunRow> => {
        await waitFor(() => {
          engine.tick();
          return engine.store.getRun(b.id)?.status !== "queued";
        }, "run B to leave the serial queue");
        return engine.waitForRun(b.id);
      })(),
    ]);

    expect(aDone.status).toBe("completed");
    expect(bDone.status).toBe("completed");
    // A finished strictly before B started — the observable meaning of "serial".
    expect(aDone.endedAt).not.toBeNull();
    expect(bDone.startedAt).not.toBeNull();
    expect(bDone.startedAt ?? 0).toBeGreaterThanOrEqual(aDone.endedAt ?? Infinity);
  }, 20_000);

  it("unlimited (the default): runs of the same workflow execute in parallel", async () => {
    const { engine } = createEngine();
    engine.deployWorkflow({
      program: `
        import { output, sleep } from "@boardwalk-labs/workflow";
        export const meta = { name: "parallel-ok", triggers: [{ kind: "manual" }] };
        await sleep(800);
        output("done");
      `,
    });

    const a = engine.startRun("parallel-ok");
    const b = engine.startRun("parallel-ok");
    // Both runs hold `running` AT THE SAME TIME — overlap, not interleaving.
    await waitFor(
      () =>
        engine.store.getRun(a.id)?.status === "running" &&
        engine.store.getRun(b.id)?.status === "running",
      "both runs to be running simultaneously",
    );

    const [aDone, bDone] = await Promise.all([engine.waitForRun(a.id), engine.waitForRun(b.id)]);
    expect(aDone.status).toBe("completed");
    expect(bDone.status).toBe("completed");
  }, 20_000);
});

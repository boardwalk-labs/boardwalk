// Conformance: cancellation (SPEC §3).
//
// Cancelling a RUNNING run walks cancelling → cancelled (the cooperative window is real, so
// the transitional status is observable) and stamps endedAt. Cancelling a QUEUED run — one
// the concurrency gate hasn't dispatched — lands on cancelled directly, with no process ever
// spawned and no `cancelling` interlude.

import { afterEach, describe, expect, it } from "vitest";
import { createEngine, disposeEngines, pause, statusesOf, waitForStatus } from "./harness.js";

afterEach(disposeEngines);

describe("conformance: cancellation", () => {
  it("cancels a running sleeper: cancelling → cancelled, endedAt set", async () => {
    const { engine } = createEngine();
    engine.deployWorkflow({
      program: `
        import { sleep } from "@boardwalk-labs/workflow";
        export const meta = { name: "long-sleeper", triggers: [{ kind: "manual" }] };
        await sleep(60_000);
      `,
    });

    const run = engine.startRun("long-sleeper");
    await waitForStatus(engine, run.id, "running");
    await pause(300); // let the child actually enter the sleep

    await engine.cancelRun(run.id);
    const done = await engine.waitForRun(run.id);

    expect(done.status).toBe("cancelled");
    expect(done.endedAt).not.toBeNull();
    expect(statusesOf(engine, run.id)).toEqual([
      "queued",
      "pending",
      "running",
      "cancelling",
      "cancelled",
    ]);
  }, 20_000);

  it("cancels a queued run directly (no cancelling interlude)", async () => {
    const { engine } = createEngine();
    // A serial workflow keeps the second run parked in `queued` while the first one holds
    // the slot — the only way to cancel a genuinely undispatched run.
    engine.deployWorkflow({
      program: `
        import { output, sleep } from "@boardwalk-labs/workflow";
        export const meta = {
          name: "serial-sleeper",
          triggers: [{ kind: "manual" }],
          concurrency: { mode: "serial" },
        };
        await sleep(5_000);
        output("done");
      `,
    });

    const first = engine.startRun("serial-sleeper");
    const second = engine.startRun("serial-sleeper");
    expect(engine.store.getRun(second.id)?.status).toBe("queued");

    await engine.cancelRun(second.id);
    const cancelled = engine.store.getRun(second.id);
    expect(cancelled?.status).toBe("cancelled");
    expect(cancelled?.endedAt).not.toBeNull();
    expect(statusesOf(engine, second.id)).toEqual(["queued", "cancelled"]);

    // Wind the first run down too so the engine closes cleanly.
    await engine.cancelRun(first.id);
    expect((await engine.waitForRun(first.id)).status).toBe("cancelled");
  }, 20_000);
});

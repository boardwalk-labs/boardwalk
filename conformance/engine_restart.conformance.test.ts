// SPDX-License-Identifier: Apache-2.0

// Conformance: sleep-through-ENGINE-restart (SPEC §3) — hold-and-pay + crash-safety.
//
// Kill the ENGINE while a run is held in `sleep`: the orphaned child exits, and a NEW engine
// booted over the same data dir must sweep the run up and drive it to completion — restarted
// from the top per hold-and-pay semantics (sleep holds a process; there is no checkpoint to
// resume from). The persisted event stream must stay cursor-monotonic across the engine
// boundary, so a consumer's resume position survives the restart.

import { afterEach, describe, expect, it } from "vitest";
import {
  createEngine,
  disposeEngines,
  expectMonotonicCursors,
  makeDataDir,
  pause,
  statusesOf,
  waitForStatus,
} from "./harness.js";

afterEach(disposeEngines);

describe("conformance: engine restart while a run sleeps", () => {
  it("a new engine over the same dataDir sweeps the run and lands it on completed", async () => {
    const dataDir = makeDataDir();

    const first = createEngine({ dataDir });
    first.engine.deployWorkflow({
      program: `
        import { output, sleep } from "@boardwalk-labs/workflow";
        export const meta = { slug: "long-sleeper", triggers: [{ kind: "manual" }] };
        await sleep(3_000);
        output("slept");
      `,
    });
    const run = first.engine.startRun("long-sleeper");
    // Why the swallowed promise: closing an engine mid-run abandons its in-flight supervision
    // (its store is gone); the run's fate belongs to the NEXT engine's boot sweep. Attaching
    // a handler keeps the abandoned supervision from surfacing as an unhandled rejection.
    void first.engine.waitForRun(run.id).catch(() => undefined);

    await waitForStatus(first.engine, run.id, "running");
    await pause(300); // let the child actually enter the sleep
    first.engine.close(); // children get SIGTERM; the orphan exits
    await pause(500); // give the orphaned child time to die before a new engine takes over

    const second = createEngine({ dataDir });
    const swept = second.engine.start();
    expect(swept.resumed).toContain(run.id);

    const done = await second.engine.waitForRun(run.id);
    expect(done.status).toBe("completed");
    expect(done.output).toBe("slept");

    // Restart-from-the-top is visible in the lifecycle stream: two pending/running passes.
    expect(statusesOf(second.engine, run.id)).toEqual([
      "queued",
      "pending",
      "running",
      "pending",
      "running",
      "completed",
    ]);
    // Cursor monotonicity holds across the engine-restart boundary (no duplicate cursors).
    expectMonotonicCursors(second.engine.store.listEvents(run.id));
  }, 30_000);
});

// SPDX-License-Identifier: Apache-2.0

// Conformance: sleep release (durable suspension by timer).
//
// A short sleep HOLDS the process (a release + replay would cost more than it saves). A long
// sleep SUSPENDS: the process is released, the run parks in `sleeping` with a wake time, and the
// scheduler resumes it once that time is due — a fresh process replays the journal and the sleep
// returns. Same machinery as human-in-the-loop, a timer instead of an answer.

import { afterEach, describe, expect, it } from "vitest";
import { createEngine, disposeEngines, manualClock, waitForStatus } from "./harness.js";

afterEach(disposeEngines);

describe("conformance: sleep release", () => {
  it("a long sleep suspends (releases the process) and resumes when the timer is due", async () => {
    const mc = manualClock(1_750_000_000_000);
    const { engine } = createEngine({ clock: mc.clock });
    engine.deployWorkflow({
      program: `
        import { sleep, output } from "@boardwalk-labs/workflow";
        export const meta = { slug: "napper", triggers: [{ kind: "manual" }] };
        await sleep(60_000);
        output("awake");
      `,
    });

    const run = engine.startRun("napper");
    await waitForStatus(engine, run.id, "sleeping");
    expect(engine.store.getRun(run.id)?.wakeAt).toBe(1_750_000_000_000 + 60_000);

    // Not yet due: a tick does not wake it.
    engine.tick();
    expect(engine.store.getRun(run.id)?.status).toBe("sleeping");

    // Past the wake time: the scheduler's wake pass resumes it.
    mc.advance(60_001);
    engine.tick();
    await waitForStatus(engine, run.id, "completed");

    expect(engine.store.getRun(run.id)?.output).toBe("awake");
    const kinds = engine.store.listEvents(run.id).map((row) => row.event.kind);
    expect(kinds).toContain("suspended");
    expect(kinds).toContain("resumed");
  }, 20_000);

  it("a short sleep holds in-process — it does not suspend", async () => {
    const { engine } = createEngine();
    engine.deployWorkflow({
      program: `
        import { sleep, output } from "@boardwalk-labs/workflow";
        export const meta = { slug: "quicknap", triggers: [{ kind: "manual" }] };
        await sleep(20);
        output("done");
      `,
    });

    const run = engine.startRun("quicknap");
    const done = await engine.waitForRun(run.id);

    expect(done.status).toBe("completed");
    expect(done.output).toBe("done");
    const kinds = engine.store.listEvents(run.id).map((row) => row.event.kind);
    expect(kinds).not.toContain("suspended");
  }, 20_000);
});

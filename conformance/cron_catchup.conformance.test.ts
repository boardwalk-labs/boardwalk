// SPDX-License-Identifier: Apache-2.0

// Conformance: cron catch-up policy (SPEC §3 + §2.1).
//
// Fires missed while no engine was running are NEVER silent and NEVER a thundering herd: the
// default is skip-with-a-logged-notice; deploy config `catch_up: "once"` coalesces any number
// of missed fires into exactly one run. Time is driven through the public clock option and
// engine.tick() — the suite reopens an engine "hours later" without waiting hours.

import { afterEach, describe, expect, it } from "vitest";
import { createEngine, disposeEngines, makeDataDir, manualClock, statusesOf } from "./harness.js";

afterEach(disposeEngines);

// A minute-aligned anchor keeps "advance one minute → exactly one due fire" exact.
const T0 = Date.UTC(2026, 0, 6, 12, 0, 0, 0);
const HOURS = 3_600_000;

const CRON_PROGRAM = `
import { output } from "@boardwalk-labs/workflow";
export const meta = { name: "tick-tock", triggers: [{ kind: "cron", expr: "* * * * *" }] };
output("fired");
`;

/** Phase 1 of both cases: fire the cron exactly once, then leave the engine "dead". */
async function fireOnceAndClose(
  dataDir: string,
  config: Record<string, string> | undefined,
): Promise<string> {
  const clock = manualClock(T0);
  const { engine } = createEngine({ dataDir, clock: clock.clock });
  engine.deployWorkflow({ program: CRON_PROGRAM, ...(config !== undefined ? { config } : {}) });

  engine.tick(); // first sight: anchors at now, no retroactive fires
  expect(engine.store.listRuns()).toHaveLength(0);

  clock.advance(60_000);
  engine.tick(); // one boundary crossed → exactly one fire
  const runs = engine.store.listRuns();
  expect(runs).toHaveLength(1);
  expect(runs[0]?.triggerKind).toBe("cron");
  const fired = await engine.waitForRun(runs[0]?.id ?? "");
  expect(fired.status).toBe("completed");

  engine.close();
  return fired.id;
}

describe("conformance: cron catch-up on engine restart", () => {
  it("default policy skips missed fires with a logged notice (no run storm, never silent)", async () => {
    const dataDir = makeDataDir();
    const firstRunId = await fireOnceAndClose(dataDir, undefined);

    // Reopen HOURS later (off the minute boundary, so "what was missed" is unambiguous).
    const notices: string[] = [];
    const clock = manualClock(T0 + 60_000 + 2 * HOURS + 30_000);
    const { engine } = createEngine({
      dataDir,
      clock: clock.clock,
      log: (line) => notices.push(line),
    });
    engine.tick();

    // ~120 fires were missed; none ran, and the skip was announced.
    expect(engine.store.listRuns()).toHaveLength(1);
    expect(engine.store.getRun(firstRunId)?.status).toBe("completed");
    expect(notices.join("\n")).toContain("missed");
    expect(notices.join("\n")).toContain("skip");
  }, 30_000);

  it('catch_up: "once" coalesces all missed fires into exactly one run', async () => {
    const dataDir = makeDataDir();
    const firstRunId = await fireOnceAndClose(dataDir, { catch_up: "once" });

    const notices: string[] = [];
    const clock = manualClock(T0 + 60_000 + 2 * HOURS + 30_000);
    const { engine } = createEngine({
      dataDir,
      clock: clock.clock,
      log: (line) => notices.push(line),
    });
    engine.tick();

    // Exactly ONE catch-up run for ~120 missed fires — coalesced, not replayed.
    const runs = engine.store.listRuns();
    expect(runs).toHaveLength(2);
    const catchUp = runs.find((r) => r.id !== firstRunId);
    expect(catchUp?.triggerKind).toBe("cron");
    expect(notices.join("\n")).toContain("once");

    const done = await engine.waitForRun(catchUp?.id ?? "");
    expect(done.status).toBe("completed");
    expect(done.output).toBe("fired");
    expect(statusesOf(engine, done.id)).toEqual(["queued", "pending", "running", "completed"]);

    // And the next tick fires nothing extra — the catch-up advanced the schedule anchor.
    engine.tick();
    expect(engine.store.listRuns()).toHaveLength(2);
  }, 30_000);
});

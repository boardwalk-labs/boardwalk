// SPDX-License-Identifier: Apache-2.0

// Conformance: budgets terminate (SPEC §3) — enforced, not advisory.
//
// Breaching budget.* FAILS the run with BUDGET_EXCEEDED and a message naming the breached
// budget — never a silent truncation. Duration is wall-clock; tokens/USD come from the usage
// each agent() leaf reports, so the fake provider scripts the breach.
//
// The sleeps here are sub-threshold (they HOLD the process, representing active compute) so the
// budget kill lands on a live process. A supra-threshold sleep would SUSPEND (release the
// process) — correct behavior, but not what these cases exercise.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createEngine,
  disposeEngines,
  localInference,
  manualClock,
  startFakeProvider,
  waitForStatus,
  type FakeProvider,
} from "./harness.js";

let provider: FakeProvider;
beforeAll(async () => {
  provider = await startFakeProvider();
});
afterAll(async () => {
  await provider.close();
});
afterEach(disposeEngines);

describe("conformance: budgets terminate the run", () => {
  it("max_duration_seconds kills a sleeper, naming the budget", async () => {
    const { engine } = createEngine();
    engine.deployWorkflow({
      program: `
        import { sleep } from "@boardwalk-labs/workflow";
        export const meta = {
          slug: "overruns",
          triggers: [{ kind: "manual" }],
          budget: { max_duration_seconds: 1 },
        };
        await sleep(3_000);
      `,
    });

    const done = await engine.waitForRun(engine.startRun("overruns").id);
    expect(done.status).toBe("failed");
    expect(done.error?.code).toBe("BUDGET_EXCEEDED");
    expect(done.error?.message).toContain("max_duration_seconds");
  }, 20_000);

  it("a SUSPENDED sleep does NOT burn max_duration_seconds (active compute only)", async () => {
    // The parity contract: max_duration_seconds caps ACTIVE COMPUTE, so a long sleep that RELEASES
    // the process (supra-threshold) must not consume it. This run sleeps 120s — far past a 30s cap —
    // yet completes, because the suspended interval is idle, not compute. (The OLD wall-clock-from-
    // start behavior would budget-kill it on wake: 120s elapsed > 30s.) The cap is set comfortably
    // above each segment's real spawn time so the wall-clock budget timer never fires under the
    // manual clock; only the active-vs-wall accounting is under test.
    const mc = manualClock(1_700_000_000_000);
    const { engine } = createEngine({ clock: mc.clock });
    engine.deployWorkflow({
      program: `
        import { sleep, output } from "@boardwalk-labs/workflow";
        export const meta = {
          slug: "long-napper",
          triggers: [{ kind: "manual" }],
          budget: { max_duration_seconds: 30 },
        };
        await sleep(120_000);
        output("rested");
      `,
    });

    const run = engine.startRun("long-napper");
    await waitForStatus(engine, run.id, "sleeping", 30_000);
    mc.advance(120_001);
    engine.tick();
    // Generous wait: the resumed segment re-spawns a child, which under heavy CI process contention
    // can be slow; the assertion is that it COMPLETES (not budget-killed), not that it's fast.
    await waitForStatus(engine, run.id, "completed", 60_000);
    expect(engine.store.getRun(run.id)?.output).toBe("rested");
  }, 75_000);

  it("deadline_seconds kills a run that WAITS past the wall-clock cap (idle counts)", async () => {
    // deadline_seconds is the orthogonal cap: wall-clock from the start, INCLUDING suspended idle.
    // The same 60s sleep that survives max_duration_seconds above breaches a 30s deadline.
    const mc = manualClock(1_700_000_000_000);
    const { engine } = createEngine({ clock: mc.clock });
    engine.deployWorkflow({
      program: `
        import { sleep, output } from "@boardwalk-labs/workflow";
        export const meta = {
          slug: "stale-waiter",
          triggers: [{ kind: "manual" }],
          budget: { deadline_seconds: 30 },
        };
        await sleep(60_000);
        output("too late");
      `,
    });

    const run = engine.startRun("stale-waiter");
    await waitForStatus(engine, run.id, "sleeping", 30_000);
    mc.advance(60_001);
    engine.tick();
    await waitForStatus(engine, run.id, "failed", 30_000);
    const done = engine.store.getRun(run.id);
    expect(done?.error?.code).toBe("BUDGET_EXCEEDED");
    expect(done?.error?.message).toContain("deadline_seconds");
  }, 45_000);

  it("max_usd kills the run from the leaf's reported usage", async () => {
    const { engine } = createEngine({ inference: localInference(provider) });
    // 10M input tokens at any plausible rate ≫ $0.01; the sleep after the leaf is where the
    // kill must land (the breach terminates mid-run, not at process exit).
    provider.respondWith("expensive", { in: 10_000_000, out: 0 });
    engine.deployWorkflow({
      program: `
        import { agent, sleep } from "@boardwalk-labs/workflow";
        export const meta = {
          slug: "overspender",
          triggers: [{ kind: "manual" }],
          budget: { max_usd: 0.01 },
        };
        await agent("burn money", { model: "test-model" });
        await sleep(3_000);
      `,
    });

    const done = await engine.waitForRun(engine.startRun("overspender").id);
    expect(done.status).toBe("failed");
    expect(done.error?.code).toBe("BUDGET_EXCEEDED");
    expect(done.error?.message).toContain("max_usd");
  }, 30_000);

  it("max_tokens kills the run from the leaf's reported usage", async () => {
    const { engine } = createEngine({ inference: localInference(provider) });
    provider.respondWith("chatty", { in: 600, out: 600 });
    engine.deployWorkflow({
      program: `
        import { agent, sleep } from "@boardwalk-labs/workflow";
        export const meta = {
          slug: "token-hog",
          triggers: [{ kind: "manual" }],
          budget: { max_tokens: 1000 },
        };
        await agent("talk a lot", { model: "test-model" });
        await sleep(3_000);
      `,
    });

    const done = await engine.waitForRun(engine.startRun("token-hog").id);
    expect(done.status).toBe("failed");
    expect(done.error?.code).toBe("BUDGET_EXCEEDED");
    expect(done.error?.message).toContain("max_tokens");
  }, 30_000);
});

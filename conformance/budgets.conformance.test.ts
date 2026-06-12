// Conformance: budgets terminate (SPEC §3; MASTER_SPEC §2.4 "budgets terminate",
// CODE_QUALITY §4.3 "enforced, not advisory").
//
// Breaching budget.* FAILS the run with BUDGET_EXCEEDED and a message naming the breached
// budget — never a silent truncation. Duration is wall-clock; tokens/USD come from the usage
// each agent() leaf reports, so the fake provider scripts the breach.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createEngine,
  disposeEngines,
  localInference,
  startFakeProvider,
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
          name: "overruns",
          triggers: [{ kind: "manual" }],
          budget: { max_duration_seconds: 1 },
        };
        await sleep(30_000);
      `,
    });

    const done = await engine.waitForRun(engine.startRun("overruns").id);
    expect(done.status).toBe("failed");
    expect(done.error?.code).toBe("BUDGET_EXCEEDED");
    expect(done.error?.message).toContain("max_duration_seconds");
  }, 20_000);

  it("max_usd kills the run from the leaf's reported usage", async () => {
    const { engine } = createEngine({ inference: localInference(provider) });
    // 10M input tokens at any plausible rate ≫ $0.01; the sleep after the leaf is where the
    // kill must land (the breach terminates mid-run, not at process exit).
    provider.respondWith("expensive", { in: 10_000_000, out: 0 });
    engine.deployWorkflow({
      program: `
        import { agent, sleep } from "@boardwalk-labs/workflow";
        export const meta = {
          name: "overspender",
          triggers: [{ kind: "manual" }],
          budget: { max_usd: 0.01 },
        };
        await agent("burn money", { model: "test-model" });
        await sleep(30_000);
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
          name: "token-hog",
          triggers: [{ kind: "manual" }],
          budget: { max_tokens: 1000 },
        };
        await agent("talk a lot", { model: "test-model" });
        await sleep(30_000);
      `,
    });

    const done = await engine.waitForRun(engine.startRun("token-hog").id);
    expect(done.status).toBe("failed");
    expect(done.error?.code).toBe("BUDGET_EXCEEDED");
    expect(done.error?.message).toContain("max_tokens");
  }, 30_000);
});

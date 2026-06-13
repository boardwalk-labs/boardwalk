// Conformance: workflows.call / workflows.run (SPEC §3).
//
// Durable composition: a parent holds for the child's output via workflows.call; the call is
// idempotent, so a crashed-and-restarted parent RE-ATTACHES to the child it already spawned
// (the child executes exactly once); workflows.run fires a child and returns its run id
// without holding for the result.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { isTerminal } from "../src/index.js";
import { createEngine, disposeEngines } from "./harness.js";

afterEach(disposeEngines);

describe("conformance: workflows.call / workflows.run", () => {
  it("the parent receives the child's declared output", async () => {
    const { engine } = createEngine();
    engine.deployWorkflow({
      program: `
        import { input, output } from "@boardwalk-labs/workflow";
        export const meta = { name: "double", triggers: [{ kind: "manual" }] };
        output({ doubled: input.n * 2 });
      `,
    });
    engine.deployWorkflow({
      program: `
        import { output, workflows } from "@boardwalk-labs/workflow";
        export const meta = { name: "caller", triggers: [{ kind: "manual" }] };
        output(await workflows.call("double", { n: 21 }));
      `,
    });

    const run = engine.startRun("caller");
    const done = await engine.waitForRun(run.id);

    expect(done.status).toBe("completed");
    expect(done.output).toEqual({ doubled: 42 });
  }, 30_000);

  it("re-attaches idempotently across a parent crash — the child executes exactly once", async () => {
    const { engine, dataDir } = createEngine();
    // The child appends to a file OUTSIDE its per-run workspace, so executions are countable
    // across runs and restarts.
    engine.deployWorkflow({
      program: `
        import { appendFileSync } from "node:fs";
        import { input, output } from "@boardwalk-labs/workflow";
        export const meta = { name: "child-counter", triggers: [{ kind: "manual" }] };
        appendFileSync(input.countFile, "x");
        output("child-result");
      `,
    });
    // Parent: call the child, then crash once AFTER the call returned. The restarted pass
    // re-runs the same workflows.call site and must re-attach instead of re-executing.
    engine.deployWorkflow({
      program: `
        import { existsSync, writeFileSync } from "node:fs";
        import { input, output, workflows } from "@boardwalk-labs/workflow";
        export const meta = { name: "crashy-parent", triggers: [{ kind: "manual" }] };
        const result = await workflows.call("child-counter", { countFile: input.countFile });
        if (!existsSync("crashed-once")) { writeFileSync("crashed-once", "1"); process.exit(9); }
        output({ childSaid: result });
      `,
    });

    const countFile = join(dataDir, "child-count.txt");
    const run = engine.startRun("crashy-parent", { input: { countFile } });
    const done = await engine.waitForRun(run.id);

    expect(done.status).toBe("completed");
    expect(done.restarts).toBe(1);
    expect(done.output).toEqual({ childSaid: "child-result" });
    expect(readFileSync(countFile, "utf8")).toBe("x"); // exactly one child execution
    const children = engine.store.listRuns().filter((r) => r.parentRunId === run.id);
    expect(children).toHaveLength(1);
    expect(children[0]?.status).toBe("completed");
  }, 30_000);

  it("workflows.run returns the child's run id without holding for its result", async () => {
    const { engine } = createEngine();
    engine.deployWorkflow({
      program: `
        import { output, sleep } from "@boardwalk-labs/workflow";
        export const meta = { name: "slow-child", triggers: [{ kind: "manual" }] };
        await sleep(1_200);
        output("late");
      `,
    });
    engine.deployWorkflow({
      program: `
        import { output, workflows } from "@boardwalk-labs/workflow";
        export const meta = { name: "fire-and-forget", triggers: [{ kind: "manual" }] };
        output({ childRunId: await workflows.run("slow-child", {}) });
      `,
    });

    const run = engine.startRun("fire-and-forget");
    const done = await engine.waitForRun(run.id);
    expect(done.status).toBe("completed");

    const { childRunId } = z.object({ childRunId: z.string().min(1) }).parse(done.output);
    const childAtParentEnd = engine.store.getRun(childRunId);
    expect(childAtParentEnd).not.toBeNull();
    expect(childAtParentEnd?.parentRunId).toBe(run.id);
    // The parent finished while the child (sleeping 1.2s) was still in flight — proof the
    // call did not hold.
    expect(childAtParentEnd !== null && isTerminal(childAtParentEnd.status)).toBe(false);

    const child = await engine.waitForRun(childRunId);
    expect(child.status).toBe("completed");
    expect(child.output).toBe("late");
  }, 30_000);
});

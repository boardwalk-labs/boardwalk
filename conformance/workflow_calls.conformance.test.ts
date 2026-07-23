// SPDX-License-Identifier: Apache-2.0

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
import { createEngine, descriptor, disposeEngines, kindsOf, waitForStatus } from "./harness.js";

afterEach(disposeEngines);

describe("conformance: workflows.call / workflows.run", () => {
  it("the parent receives the child's returned output", async () => {
    const { engine } = createEngine();
    engine.deployWorkflow({
      descriptor: descriptor({ slug: "double", triggers: [{ kind: "manual" }] }),
      program: `
        export default async function run(input) {
          return { doubled: input.n * 2 };
        }
      `,
    });
    engine.deployWorkflow({
      descriptor: descriptor({ slug: "caller", triggers: [{ kind: "manual" }] }),
      program: `
        import { workflows } from "@boardwalk-labs/workflow";
        export default async function run() {
          return await workflows.call("double", { n: 21 });
        }
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
      descriptor: descriptor({ slug: "child-counter", triggers: [{ kind: "manual" }] }),
      program: `
        import { appendFileSync } from "node:fs";
        export default async function run(input) {
          appendFileSync(input.countFile, "x");
          return "child-result";
        }
      `,
    });
    // Parent: call the child, then crash once AFTER the call returned. The restarted pass
    // re-runs the same workflows.call site and must re-attach instead of re-executing.
    engine.deployWorkflow({
      descriptor: descriptor({ slug: "crashy-parent", triggers: [{ kind: "manual" }] }),
      program: `
        import { existsSync, writeFileSync } from "node:fs";
        import { workflows } from "@boardwalk-labs/workflow";
        export default async function run(input) {
          const result = await workflows.call("child-counter", { countFile: input.countFile });
          if (!existsSync("crashed-once")) { writeFileSync("crashed-once", "1"); process.exit(9); }
          return { childSaid: result };
        }
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

  it("a slow child flips the parent to waiting_for_child while the parent HOLDS for the result", async () => {
    // The parent's process holds through the whole child wait (this engine has no snapshot
    // substrate to release it to); its status flips to `waiting_for_child` so the control
    // surface shows what it is doing, then back on the child's finalize.
    const { engine } = createEngine();
    engine.deployWorkflow({
      descriptor: descriptor({ slug: "slow-child", triggers: [{ kind: "manual" }] }),
      program: `
        import { sleep } from "@boardwalk-labs/workflow";
        export default async function run() {
          await sleep(600);
          return "child-done";
        }
      `,
    });
    engine.deployWorkflow({
      descriptor: descriptor({ slug: "waiter", triggers: [{ kind: "manual" }] }),
      program: `
        import { workflows } from "@boardwalk-labs/workflow";
        export default async function run() {
          return { said: await workflows.call("slow-child", {}) };
        }
      `,
    });

    const run = engine.startRun("waiter");

    // While the child sleeps, the parent reports waiting_for_child — and the child really is
    // still in flight at that moment.
    await waitForStatus(engine, run.id, "waiting_for_child");
    const childWhileWaiting = engine.store.listRuns().filter((r) => r.parentRunId === run.id);
    expect(childWhileWaiting).toHaveLength(1);
    expect(childWhileWaiting[0] !== undefined && isTerminal(childWhileWaiting[0].status)).toBe(
      false,
    );

    // The child finishes its sleep and finalizes; the parent's held call returns its output.
    await waitForStatus(engine, run.id, "completed");
    const done = engine.store.getRun(run.id);
    expect(done?.output).toEqual({ said: "child-done" });
    expect(done?.restarts).toBe(0); // holding is not a crash
    // No suspension lifecycle: the parent held its process the whole time.
    expect(kindsOf(engine, run.id)).not.toContain("suspended");
    expect(kindsOf(engine, run.id)).not.toContain("resumed");
    // Exactly one child run, and it completed.
    const children = engine.store.listRuns().filter((r) => r.parentRunId === run.id);
    expect(children).toHaveLength(1);
    expect(children[0]?.status).toBe("completed");
  }, 30_000);

  it("workflows.run returns the child's run id without holding for its result", async () => {
    const { engine } = createEngine();
    engine.deployWorkflow({
      descriptor: descriptor({ slug: "slow-child", triggers: [{ kind: "manual" }] }),
      program: `
        import { sleep } from "@boardwalk-labs/workflow";
        export default async function run() {
          await sleep(1_200);
          return "late";
        }
      `,
    });
    engine.deployWorkflow({
      descriptor: descriptor({ slug: "fire-and-forget", triggers: [{ kind: "manual" }] }),
      program: `
        import { workflows } from "@boardwalk-labs/workflow";
        export default async function run() {
          return { childRunId: await workflows.run("slow-child", {}) };
        }
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

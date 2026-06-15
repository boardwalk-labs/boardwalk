// SPDX-License-Identifier: Apache-2.0

// Conformance: restart-on-crash (SPEC §3).
//
// A run process that dies mid-program restarts FROM THE TOP — no checkpoint, no replay — with
// the workspace left exactly as the crashed pass left it. Restarts are bounded: exhausting
// the budget fails the run with CRASHED.

import { afterEach, describe, expect, it } from "vitest";
import { createEngine, disposeEngines, statusesOf } from "./harness.js";

afterEach(disposeEngines);

describe("conformance: crash-restart", () => {
  it("process.exit mid-program restarts from the top; the workspace survives the restart", async () => {
    const { engine } = createEngine();
    // First pass: no marker → write it, hard-crash. Second pass: the marker written by the
    // crashed pass is still there (workspace survived) → complete.
    engine.deployWorkflow({
      program: `
        import { existsSync, writeFileSync } from "node:fs";
        import { output } from "@boardwalk-labs/workflow";
        export const meta = { slug: "flaky", triggers: [{ kind: "manual" }] };
        if (!existsSync("marker")) { writeFileSync("marker", "1"); process.exit(7); }
        output("recovered");
      `,
    });

    const run = engine.startRun("flaky");
    const done = await engine.waitForRun(run.id);

    expect(done.status).toBe("completed");
    expect(done.output).toBe("recovered");
    expect(done.restarts).toBe(1);
    // The lifecycle stream shows BOTH passes: pending/running appear twice.
    expect(statusesOf(engine, run.id)).toEqual([
      "queued",
      "pending",
      "running",
      "pending",
      "running",
      "completed",
    ]);
  }, 20_000);

  it("exhausting the restart budget fails the run with CRASHED", async () => {
    const { engine } = createEngine({ maxRestarts: 1 });
    engine.deployWorkflow({
      program: `
        export const meta = { slug: "always-crashes", triggers: [{ kind: "manual" }] };
        process.exit(3);
      `,
    });

    const run = engine.startRun("always-crashes");
    const done = await engine.waitForRun(run.id);

    expect(done.status).toBe("failed");
    expect(done.error?.code).toBe("CRASHED");
    expect(done.restarts).toBe(2); // the initial attempt + 1 restart, both crashed
  }, 20_000);
});

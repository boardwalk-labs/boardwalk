// SPDX-License-Identifier: Apache-2.0

// Conformance: sleep holds in-process.
//
// This engine has no snapshot substrate, so a wait of ANY length holds the run's process —
// locals survive trivially because nothing ever leaves memory. There is no suspend, no release,
// no replay: the run stays `running` through the wait and simply continues when the time has
// elapsed. (On hosted Boardwalk, the snapshot substrate suspends long waits instead — same
// program, same semantics, different economics.)

import { afterEach, describe, expect, it } from "vitest";
import { createEngine, disposeEngines, descriptor } from "./harness.js";

afterEach(disposeEngines);

describe("conformance: sleep holds in-process", () => {
  it("a sleep holds the process and the run continues with its locals intact", async () => {
    const { engine } = createEngine();
    engine.deployWorkflow({
      descriptor: descriptor({ slug: "napper", triggers: [{ kind: "manual" }] }),
      program: `
        import { sleep } from "@boardwalk-labs/workflow";
        export default async function run(input, context) {
          const before = Date.now();
          await sleep(200);
          return ({ sleptMs: Date.now() - before });
        }
      `,
    });

    const run = engine.startRun("napper");
    const done = await engine.waitForRun(run.id);

    expect(done.status).toBe("completed");
    const output = done.output as { sleptMs: number };
    expect(output.sleptMs).toBeGreaterThanOrEqual(150);
    // The whole wait happened inside one held process: no suspension lifecycle events, and the
    // run never left the running status for a sleep-specific park.
    const kinds = engine.store.listEvents(run.id).map((row) => row.event.kind);
    expect(kinds).not.toContain("suspended");
    expect(kinds).not.toContain("resumed");
    const statuses = engine.store
      .listEvents(run.id)
      .map((row) => row.event)
      .filter((e) => e.kind === "run_status")
      .map((e) => e.status);
    expect(statuses).not.toContain("sleeping");
  }, 20_000);

  it("an already-elapsed sleep({ until }) returns immediately", async () => {
    const { engine } = createEngine();
    engine.deployWorkflow({
      descriptor: descriptor({ slug: "pastnap", triggers: [{ kind: "manual" }] }),
      program: `
        import { sleep } from "@boardwalk-labs/workflow";
        export default async function run(input, context) {
          await sleep({ until: new Date(Date.now() - 60_000) });
          return ("done");
        }
      `,
    });

    const run = engine.startRun("pastnap");
    const done = await engine.waitForRun(run.id);
    expect(done.status).toBe("completed");
    expect(done.output).toBe("done");
  }, 20_000);
});

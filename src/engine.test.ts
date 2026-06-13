// SPDX-License-Identifier: Apache-2.0

// Facade tests: deploy-from-source (manifest derived from the pure-literal meta), the two
// consumption modes, and the dispatch path manual runs share with cron fires.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Engine } from "./engine.js";
import { EngineError } from "./errors.js";

// dist/ is built once by vitest.global_setup.ts — the engine spawns the compiled child entry.
const repoRoot = resolve(fileURLToPath(import.meta.url), "../..");
const childEntryPath = join(repoRoot, "dist", "run", "child.js");

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

function makeEngine(env: Record<string, string> = {}): Engine {
  const dataDir = mkdtempSync(join(tmpdir(), "bw-facade-test-"));
  const engine = new Engine({
    dataDir,
    env,
    envLabel: ".env (test)",
    childEntryPath,
    cancelGraceMs: 250,
  });
  cleanups.push(() => {
    engine.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return engine;
}

const ECHO_PROGRAM = `
import { input, output } from "@boardwalk-labs/workflow";
export const meta = {
  name: "echo",
  description: "echoes its input",
  triggers: [{ kind: "manual" }],
};
output({ echoed: input ?? null });
`;

describe("Engine facade", () => {
  it("deployWorkflow derives the manifest from the program's pure-literal meta", () => {
    const engine = makeEngine();
    const workflow = engine.deployWorkflow({ program: ECHO_PROGRAM });
    expect(workflow.name).toBe("echo");
    expect(workflow.manifest.description).toBe("echoes its input");
    expect(workflow.manifest.triggers).toEqual([{ kind: "manual" }]);
  });

  it("rejects a program whose meta is not a pure literal", () => {
    const engine = makeEngine();
    const bad = `const x = 1; export const meta = { name: "n" + x, triggers: [{ kind: "manual" }] };
       export default async function run() {}`;
    expect(() => engine.deployWorkflow({ program: bad })).toThrow();
  });

  it("redeploy by name keeps the workflow id and replaces the program", () => {
    const engine = makeEngine();
    const first = engine.deployWorkflow({ program: ECHO_PROGRAM });
    const second = engine.deployWorkflow({
      program: ECHO_PROGRAM.replace("echoes its input", "v2"),
    });
    expect(second.id).toBe(first.id);
    expect(second.manifest.description).toBe("v2");
  });

  it("startRun + waitForRun: queued row immediately, terminal row on await", async () => {
    const engine = makeEngine();
    engine.deployWorkflow({ program: ECHO_PROGRAM });
    const queued = engine.startRun("echo", { input: { n: 7 } });
    expect(["queued", "pending", "running"]).toContain(queued.status);
    const done = await engine.waitForRun(queued.id);
    expect(done.status).toBe("completed");
    expect(done.output).toEqual({ echoed: { n: 7 } });
  }, 20_000);

  it("startRun on an unknown workflow fails NOT_FOUND", () => {
    const engine = makeEngine();
    expect(() => engine.startRun("ghost")).toThrowError(EngineError);
  });

  it("runOnce — the boardwalk dev path — deploys, runs, and returns the terminal row", async () => {
    const engine = makeEngine();
    const row = await engine.runOnce({ program: ECHO_PROGRAM, input: { from: "dev" } });
    expect(row.status).toBe("completed");
    expect(row.output).toEqual({ echoed: { from: "dev" } });
  }, 20_000);

  it("streams events to onEvent subscribers and serves them back by cursor", async () => {
    const engine = makeEngine();
    const seen: string[] = [];
    engine.onEvent((row) => seen.push(row.event.kind));
    const row = await engine.runOnce({ program: ECHO_PROGRAM });
    expect(seen).toEqual(["run_status", "run_status", "run_status", "output", "run_status"]);
    expect(engine.store.listEvents(row.id).map((e) => e.event.kind)).toEqual(seen);
  }, 20_000);

  it("start() is idempotent and close() makes the engine unusable", () => {
    const engine = makeEngine();
    const first = engine.start();
    expect(first).toEqual({ resumed: [], cancelled: [] });
    expect(engine.start()).toEqual({ resumed: [], cancelled: [] });
    engine.close();
    expect(() => engine.startRun("echo")).toThrow(/closed/);
  });

  it("manual runs respect serial concurrency through the shared dispatch gate", async () => {
    const engine = makeEngine();
    engine.deployWorkflow({
      program: `
        import { output, sleep } from "@boardwalk-labs/workflow";
        export const meta = {
          name: "one-by-one",
          triggers: [{ kind: "manual" }],
          concurrency: { mode: "serial" },
        };
        await sleep(400); output("done");
      `,
    });
    const a = engine.startRun("one-by-one");
    const b = engine.startRun("one-by-one");
    // While A holds the serial slot, B must still be queued.
    expect(engine.store.getRun(b.id)?.status).toBe("queued");
    const [aDone, bDone] = await Promise.all([
      engine.waitForRun(a.id),
      // B isn't dispatched until a later tick; drive ticks until the gate releases it.
      (async (): Promise<Awaited<ReturnType<Engine["waitForRun"]>>> => {
        for (;;) {
          const row = engine.store.getRun(b.id);
          if (row !== null && row.status !== "queued") return engine.waitForRun(b.id);
          await new Promise((r) => setTimeout(r, 50));
          engine.tick();
        }
      })(),
    ]);
    expect(aDone.status).toBe("completed");
    expect(bDone.status).toBe("completed");
    // A finished strictly before B started.
    expect(aDone.endedAt).not.toBeNull();
    expect(bDone.startedAt).not.toBeNull();
    expect(bDone.startedAt ?? 0).toBeGreaterThanOrEqual(aDone.endedAt ?? Infinity);
  }, 20_000);
});

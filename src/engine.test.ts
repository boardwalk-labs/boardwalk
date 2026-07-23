// SPDX-License-Identifier: Apache-2.0

// Facade tests: deploy (descriptor + built program), package-dir deploy, the two consumption
// modes, and the dispatch path manual runs share with cron fires.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

const ECHO_DESCRIPTOR = JSON.stringify({
  slug: "echo",
  description: "echoes its input",
  triggers: [{ kind: "manual" }],
});

const ECHO_PROGRAM = `
export default async function run(input) {
  return { echoed: input ?? null };
}
`;

describe("Engine facade", () => {
  it("deployWorkflow validates the descriptor into the stored manifest", () => {
    const engine = makeEngine();
    const workflow = engine.deployWorkflow({ program: ECHO_PROGRAM, descriptor: ECHO_DESCRIPTOR });
    expect(workflow.slug).toBe("echo");
    expect(workflow.manifest.description).toBe("echoes its input");
    expect(workflow.manifest.triggers).toEqual([{ kind: "manual" }]);
    expect(workflow.version).toBe(1);
  });

  it("accepts JSONC (comments + trailing commas) in the descriptor", () => {
    const engine = makeEngine();
    const workflow = engine.deployWorkflow({
      program: ECHO_PROGRAM,
      descriptor: `{
        // the workflow's identity
        "slug": "commented",
        "triggers": [{ "kind": "manual" },],
      }`,
    });
    expect(workflow.slug).toBe("commented");
  });

  it("rejects a malformed descriptor with a VALIDATION error", () => {
    const engine = makeEngine();
    expect(() =>
      engine.deployWorkflow({
        program: ECHO_PROGRAM,
        descriptor: JSON.stringify({ slug: "bad", triggers: [], nonsense: true }),
      }),
    ).toThrowError(EngineError);
  });

  it("rejects a descriptor carrying a build-derived schema field", () => {
    const engine = makeEngine();
    expect(() =>
      engine.deployWorkflow({
        program: ECHO_PROGRAM,
        descriptor: JSON.stringify({
          slug: "typed",
          triggers: [{ kind: "manual" }],
          input_schema: { type: "object" },
        }),
      }),
    ).toThrow(/build-derived/);
  });

  it("redeploy by slug keeps the workflow id, replaces the program, bumps the version", () => {
    const engine = makeEngine();
    const first = engine.deployWorkflow({ program: ECHO_PROGRAM, descriptor: ECHO_DESCRIPTOR });
    const second = engine.deployWorkflow({
      program: ECHO_PROGRAM,
      descriptor: ECHO_DESCRIPTOR.replace("echoes its input", "v2"),
    });
    expect(second.id).toBe(first.id);
    expect(second.manifest.description).toBe("v2");
    expect(second.version).toBe(2);
  });

  it("an unchanged redeploy (the boot re-sync) does not bump the version", () => {
    const engine = makeEngine();
    const first = engine.deployWorkflow({ program: ECHO_PROGRAM, descriptor: ECHO_DESCRIPTOR });
    const second = engine.deployWorkflow({ program: ECHO_PROGRAM, descriptor: ECHO_DESCRIPTOR });
    expect(second.version).toBe(first.version);
  });

  it("deployWorkflowDir deploys a built package directory", () => {
    const engine = makeEngine();
    const dir = mkdtempSync(join(tmpdir(), "bw-pkg-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "workflow.jsonc"), ECHO_DESCRIPTOR);
    writeFileSync(join(dir, "index.mjs"), ECHO_PROGRAM);
    mkdirSync(join(dir, "skills", "greet"), { recursive: true });
    writeFileSync(join(dir, "skills", "greet", "SKILL.md"), "# greet\n");
    writeFileSync(join(dir, "AGENTS.md"), "Be terse.\n");
    const workflow = engine.deployWorkflowDir(dir);
    expect(workflow.slug).toBe("echo");
    expect(workflow.program).toBe(ECHO_PROGRAM);
  });

  it("startRun + waitForRun: queued row immediately, terminal row on await", async () => {
    const engine = makeEngine();
    engine.deployWorkflow({ program: ECHO_PROGRAM, descriptor: ECHO_DESCRIPTOR });
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

  it("runOnce — the embedded one-shot path — deploys, runs, and returns the terminal row", async () => {
    const engine = makeEngine();
    const row = await engine.runOnce({
      program: ECHO_PROGRAM,
      descriptor: ECHO_DESCRIPTOR,
      input: { from: "dev" },
    });
    expect(row.status).toBe("completed");
    expect(row.output).toEqual({ echoed: { from: "dev" } });
  }, 20_000);

  it("streams events to onEvent subscribers and serves them back by cursor", async () => {
    const engine = makeEngine();
    const seen: string[] = [];
    engine.onEvent((row) => seen.push(row.event.kind));
    const row = await engine.runOnce({ program: ECHO_PROGRAM, descriptor: ECHO_DESCRIPTOR });
    expect(seen).toEqual(["run_status", "run_status", "run_status", "output", "run_status"]);
    expect(engine.store.listEvents(row.id).map((e) => e.event.kind)).toEqual(seen);
  }, 20_000);

  it("a void run() completes with a null output and no output event", async () => {
    const engine = makeEngine();
    const row = await engine.runOnce({
      program: `export default async function run() { console.log("side effect only"); }`,
      descriptor: JSON.stringify({ slug: "void", triggers: [{ kind: "manual" }] }),
    });
    expect(row.status).toBe("completed");
    expect(row.output).toBeNull();
    const kinds = engine.store.listEvents(row.id).map((e) => e.event.kind);
    expect(kinds).not.toContain("output");
  }, 20_000);

  it("a program without a run default export fails with the actionable message", async () => {
    const engine = makeEngine();
    const row = await engine.runOnce({
      program: `console.log("module body is not a program anymore");`,
      descriptor: JSON.stringify({ slug: "no-entry", triggers: [{ kind: "manual" }] }),
    });
    expect(row.status).toBe("failed");
    expect(row.error?.code).toBe("VALIDATION");
    expect(row.error?.message).toMatch(/no `run` function default export/);
  }, 20_000);

  it("run(input, context) receives the run's context metadata", async () => {
    const engine = makeEngine();
    const row = await engine.runOnce({
      program: `
        export default async function run(input, context) {
          return {
            runId: context.runId,
            workflowVersion: context.workflowVersion,
            orgId: context.orgId,
            actorType: context.actor.type,
            triggerKind: context.trigger.kind,
            attempt: context.attempt,
            hasSignal: context.signal instanceof AbortSignal,
          };
        }
      `,
      descriptor: JSON.stringify({ slug: "ctx", triggers: [{ kind: "manual" }] }),
    });
    expect(row.status).toBe("completed");
    expect(row.output).toEqual({
      runId: row.id,
      workflowVersion: 1,
      orgId: "local",
      actorType: "user",
      triggerKind: "manual",
      attempt: 1,
      hasSignal: true,
    });
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
      descriptor: JSON.stringify({
        slug: "one-by-one",
        triggers: [{ kind: "manual" }],
        concurrency: { mode: "serial" },
      }),
      program: `
        import { sleep } from "@boardwalk-labs/workflow";
        export default async function run() {
          await sleep(400);
          return "done";
        }
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

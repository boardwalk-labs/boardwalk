// SPDX-License-Identifier: Apache-2.0

// Integration tests for the run lifecycle: they spawn the REAL compiled child entry
// (dist/run/child.js) and execute real program bundles, because the semantics under test —
// restart-from-the-top, idempotent re-attach, hold-and-pay sleep, cancellation, budgets —
// live in the parent⇄child interaction, not in any unit.
//
// Programs are the FUNCTION MODEL: a built module default-exporting `run(input, context)`;
// the return value is the run's output.

import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { workflowManifestSchema, type WorkflowManifest } from "@boardwalk-labs/workflow";
import { Store, type EventRow } from "../store/store.js";
import { RunSupervisor } from "./supervisor.js";

const repoRoot = resolve(fileURLToPath(import.meta.url), "../../..");
const childEntryPath = join(repoRoot, "dist", "run", "child.js");

interface Fixture {
  store: Store;
  supervisor: RunSupervisor;
  dataDir: string;
  events: EventRow[];
  deploy: (slug: string, program: string, meta?: Partial<WorkflowManifest>) => string;
  startRun: (slug: string, input?: unknown) => string;
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

function fixture(opts?: { env?: Record<string, string>; maxRestarts?: number }): Fixture {
  const dataDir = mkdtempSync(join(tmpdir(), "bw-engine-test-"));
  const store = new Store(join(dataDir, "engine.db"));
  const events: EventRow[] = [];
  const supervisor = new RunSupervisor({
    store,
    dataDir,
    childEntryPath,
    env: new Map(Object.entries(opts?.env ?? {})),
    envLabel: ".env (test fixture)",
    maxRestarts: opts?.maxRestarts ?? 2,
    cancelGraceMs: 250,
  });
  supervisor.onEvent((row) => events.push(row));
  cleanups.push(() => {
    supervisor.shutdown();
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const deploy = (slug: string, program: string, meta?: Partial<WorkflowManifest>): string => {
    const manifest = workflowManifestSchema.parse({
      slug,
      triggers: [{ kind: "manual" }],
      ...meta,
    });
    return store.upsertWorkflow({ slug, manifest, program }).id;
  };
  const startRun = (slug: string, input?: unknown): string => {
    const workflow = store.getWorkflow(slug);
    if (workflow === null) throw new Error(`not deployed: ${slug}`);
    const { run } = store.createRun({
      workflowId: workflow.id,
      triggerKind: "manual",
      actor: { type: "user", user_id: "local" },
      ...(input !== undefined ? { input } : {}),
    });
    supervisor.emitQueued(run.id);
    return run.id;
  };
  return { store, supervisor, dataDir, events, deploy, startRun };
}

function kinds(events: EventRow[], runId: string): string[] {
  return events.filter((e) => e.runId === runId).map((e) => e.event.kind);
}

describe("RunSupervisor", () => {
  it("runs a program to completion: output, statuses, monotonic cursors", async () => {
    const f = fixture();
    f.deploy(
      "echo",
      `export default async function run(input) {
         return { got: input };
       }`,
    );
    const runId = f.startRun("echo", { n: 42 });
    const row = await f.supervisor.supervise(runId);

    expect(row.status).toBe("completed");
    expect(row.output).toEqual({ got: { n: 42 } });
    expect(row.startedAt).not.toBeNull();
    expect(row.endedAt).not.toBeNull();

    expect(kinds(f.events, runId)).toEqual([
      "run_status", // queued
      "run_status", // pending
      "run_status", // running
      "output",
      "run_status", // completed
    ]);
    const cursors = f.events.filter((e) => e.runId === runId).map((e) => e.cursor);
    expect([...cursors].sort((a, b) => a - b)).toEqual(cursors);
    expect(new Set(cursors).size).toBe(cursors.length);
    // Persisted stream matches the live feed.
    expect(f.store.listEvents(runId).map((e) => e.event.kind)).toEqual(kinds(f.events, runId));
  }, 20_000);

  it("captures stdout/stderr as program_output events on the log channel", async () => {
    const f = fixture();
    f.deploy(
      "talkative",
      `export default async function run() {
         console.log("hello from the program");
         console.error("warning line");
       }`,
    );
    const runId = f.startRun("talkative");
    await f.supervisor.supervise(runId);

    const logs = f.store
      .listEvents(runId)
      .map((e) => e.event)
      .filter((e) => e.kind === "program_output");
    expect(
      logs.some((e) => e.stream === "stdout" && e.text.includes("hello from the program")),
    ).toBe(true);
    expect(logs.some((e) => e.stream === "stderr" && e.text.includes("warning line"))).toBe(true);
  }, 20_000);

  it("a module-body program (no run default export) fails with the actionable error", async () => {
    const f = fixture();
    f.deploy(
      "legacy-module-body",
      `console.log("the removed module-body shape");
       export const meta = { slug: "legacy-module-body", triggers: [{ kind: "manual" }] };`,
    );
    const row = await f.supervisor.supervise(f.startRun("legacy-module-body"));
    expect(row.status).toBe("failed");
    expect(row.error?.code).toBe("VALIDATION");
    expect(row.error?.message).toContain("no `run` function default export");
  }, 20_000);

  it("fails the run with the program's error", async () => {
    const f = fixture();
    f.deploy(
      "boom",
      `export default async function run() {
         throw new Error("kaput: the dataset is empty");
       }`,
    );
    const runId = f.startRun("boom");
    const row = await f.supervisor.supervise(runId);

    expect(row.status).toBe("failed");
    expect(row.error).toEqual({
      code: "PROGRAM_ERROR",
      message: "kaput: the dataset is empty",
    });
    const last = f.store.listEvents(runId).at(-1)?.event;
    expect(last?.kind).toBe("run_status");
    expect(last !== undefined && last.kind === "run_status" ? last.error?.message : "").toContain(
      "kaput",
    );
  }, 20_000);

  it("restarts a crashed run from the top, bounded; workspace survives restarts", async () => {
    const f = fixture();
    // First pass: no marker → write it, hard-crash. Second pass: marker exists → complete.
    f.deploy(
      "flaky",
      `import { existsSync, writeFileSync } from "node:fs";
       export default async function run() {
         if (!existsSync("marker")) { writeFileSync("marker", "1"); process.exit(7); }
         return "recovered";
       }`,
    );
    const runId = f.startRun("flaky");
    const row = await f.supervisor.supervise(runId);

    expect(row.status).toBe("completed");
    expect(row.output).toBe("recovered");
    expect(row.restarts).toBe(1);
    // pending → running → (crash) → pending → running
    const statuses = f.store
      .listEvents(runId)
      .map((e) => e.event)
      .filter((e) => e.kind === "run_status")
      .map((e) => e.status);
    expect(statuses).toEqual(["queued", "pending", "running", "pending", "running", "completed"]);
  }, 20_000);

  it("context.attempt counts crash-restarts (1-based)", async () => {
    const f = fixture();
    f.deploy(
      "attempt-probe",
      `import { existsSync, writeFileSync } from "node:fs";
       export default async function run(input, context) {
         if (!existsSync("crashed")) { writeFileSync("crashed", "1"); process.exit(7); }
         return { attempt: context.attempt };
       }`,
    );
    const row = await f.supervisor.supervise(f.startRun("attempt-probe"));
    expect(row.status).toBe("completed");
    expect(row.output).toEqual({ attempt: 2 });
  }, 20_000);

  it("exhausts the restart budget and fails with CRASHED", async () => {
    const f = fixture({ maxRestarts: 1 });
    f.deploy("always-crashes", `export default async function run() { process.exit(3); }`);
    const runId = f.startRun("always-crashes");
    const row = await f.supervisor.supervise(runId);

    expect(row.status).toBe("failed");
    expect(row.error?.code).toBe("CRASHED");
    expect(row.restarts).toBe(2); // initial attempt + 1 restart, both crashed
  }, 20_000);

  it("resolves declared secrets fail-closed; undeclared and missing both fail with pointers", async () => {
    const f = fixture({ env: { GH_TOKEN: "tok-123" } });
    f.deploy(
      "uses-secret",
      `import { secrets } from "@boardwalk-labs/workflow";
       export default async function run() {
         return (await secrets.get("GH_TOKEN")).length;
       }`,
      { permissions: { secrets: [{ name: "GH_TOKEN" }] } },
    );
    const ok = await f.supervisor.supervise(f.startRun("uses-secret"));
    expect(ok.status).toBe("completed");
    expect(ok.output).toBe(7);

    f.deploy(
      "undeclared-secret",
      `import { secrets } from "@boardwalk-labs/workflow";
       export default async function run() {
         await secrets.get("GH_TOKEN");
       }`,
    );
    const undeclared = await f.supervisor.supervise(f.startRun("undeclared-secret"));
    expect(undeclared.status).toBe("failed");
    expect(undeclared.error?.message).toContain("not declared in permissions.secrets");

    f.deploy(
      "missing-secret",
      `import { secrets } from "@boardwalk-labs/workflow";
       export default async function run() {
         await secrets.get("ABSENT");
       }`,
      { permissions: { secrets: [{ name: "ABSENT" }] } },
    );
    const missing = await f.supervisor.supervise(f.startRun("missing-secret"));
    expect(missing.status).toBe("failed");
    expect(missing.error?.code).toBe("SECRET_MISSING");
  }, 30_000);

  it("redacts a secret value from a program error in the run row AND event stream", async () => {
    const f = fixture({ env: { API_TOKEN: "canary-secret-abc123" } });
    f.deploy(
      "leaky-error",
      `import { secrets } from "@boardwalk-labs/workflow";
       export default async function run() {
         const token = await secrets.get("API_TOKEN");
         throw new Error("request to upstream failed with token=" + token);
       }`,
      { permissions: { secrets: [{ name: "API_TOKEN" }] } },
    );
    const row = await f.supervisor.supervise(f.startRun("leaky-error"));
    expect(row.status).toBe("failed");
    expect(row.error?.message).not.toContain("canary-secret-abc123");
    expect(row.error?.message).toContain("[redacted:API_TOKEN]");
    // And nowhere in the persisted stream either.
    expect(JSON.stringify(f.store.listEvents(row.id))).not.toContain("canary-secret-abc123");
  }, 20_000);

  it("workflows.call awaits the child's output and re-attaches idempotently across a parent crash", async () => {
    const f = fixture();
    f.deploy(
      "child-counter",
      `import { appendFileSync } from "node:fs";
       export default async function run(input) {
         appendFileSync(input.countFile, "x");
         return "child-result";
       }`,
    );
    // Parent: call the child, then crash once AFTER the call returned; the restarted pass
    // must re-attach (created=false) instead of executing the child a second time.
    f.deploy(
      "parent",
      `import { workflows } from "@boardwalk-labs/workflow";
       import { existsSync, writeFileSync } from "node:fs";
       export default async function run(input) {
         const result = await workflows.call("child-counter", { countFile: input.countFile });
         if (!existsSync("crashed-once")) { writeFileSync("crashed-once", "1"); process.exit(9); }
         return { childSaid: result };
       }`,
    );
    const countFile = join(f.dataDir, "count.txt");
    const runId = f.startRun("parent", { countFile });
    const row = await f.supervisor.supervise(runId);

    expect(row.status).toBe("completed");
    expect(row.output).toEqual({ childSaid: "child-result" });
    expect(readFileSync(countFile, "utf8")).toBe("x"); // the child executed exactly once
    const childRuns = f.store.listRuns().filter((r) => r.parentRunId === runId);
    expect(childRuns).toHaveLength(1);
    expect(childRuns[0]?.status).toBe("completed");
    // The child's actor is the synthetic workflow principal, never a human.
    expect(childRuns[0]?.actor?.type).toBe("workflow");
  }, 30_000);

  it("sleep holds the process (hold-and-pay), locals survive", async () => {
    const f = fixture();
    f.deploy(
      "sleeper",
      `import { sleep } from "@boardwalk-labs/workflow";
       export default async function run() {
         const local = "kept-" + Math.floor(1000 * Math.random());
         const before = Date.now();
         await sleep(400);
         return { heldMs: Date.now() - before, local: local.startsWith("kept-") };
       }`,
    );
    const row = await f.supervisor.supervise(f.startRun("sleeper"));
    expect(row.status).toBe("completed");
    const out = z.object({ heldMs: z.number(), local: z.boolean() }).parse(row.output);
    expect(out.heldMs).toBeGreaterThanOrEqual(380);
    expect(out.local).toBe(true);
    expect(row.restarts).toBe(0); // held, not restarted — no checkpoint/replay anywhere
  }, 20_000);

  it("cancels a running run: cancelling → cancelled, process killed", async () => {
    const f = fixture();
    f.deploy(
      "long-sleeper",
      `import { sleep } from "@boardwalk-labs/workflow";
       export default async function run() {
         await sleep(60_000);
       }`,
    );
    const runId = f.startRun("long-sleeper");
    const done = f.supervisor.supervise(runId);
    await waitFor(() => f.store.getRun(runId)?.status === "running");
    // Give the child a beat to actually enter the sleep.
    await new Promise((r) => setTimeout(r, 300));

    await f.supervisor.cancel(runId);
    const row = await done;
    expect(row.status).toBe("cancelled");
    const statuses = f.store
      .listEvents(runId)
      .map((e) => e.event)
      .filter((e) => e.kind === "run_status")
      .map((e) => e.status);
    expect(statuses).toEqual(["queued", "pending", "running", "cancelling", "cancelled"]);
  }, 20_000);

  it("terminates on budget.max_compute_seconds with BUDGET_EXCEEDED", async () => {
    const f = fixture();
    f.deploy(
      "overruns",
      `import { sleep } from "@boardwalk-labs/workflow";
       export default async function run() {
         await sleep(60_000);
       }`,
      { budget: { max_compute_seconds: 1 } },
    );
    const row = await f.supervisor.supervise(f.startRun("overruns"));
    expect(row.status).toBe("failed");
    expect(row.error?.code).toBe("BUDGET_EXCEEDED");
    expect(row.error?.message).toContain("max_compute_seconds");
  }, 20_000);

  it("usage.get() reports live spend and the manifest caps", async () => {
    const f = fixture();
    f.deploy(
      "self-governing",
      `import { usage } from "@boardwalk-labs/workflow";
       export default async function run() {
         const snapshot = await usage.get();
         return {
           usdCap: snapshot.usd.cap,
           tokensCap: snapshot.tokens.cap,
           computeCap: snapshot.compute_seconds.cap,
           computeSpentIsLive: snapshot.compute_seconds.spent >= 0,
         };
       }`,
      { budget: { max_usd: 5, max_tokens: 100_000 } },
    );
    const row = await f.supervisor.supervise(f.startRun("self-governing"));
    expect(row.status).toBe("completed");
    expect(row.output).toEqual({
      usdCap: 5,
      tokensCap: 100_000,
      computeCap: null,
      computeSpentIsLive: true,
    });
  }, 20_000);

  it("shell() resolves the completed command — exit code included, never thrown", async () => {
    const f = fixture();
    f.deploy(
      "sheller",
      `import { shell } from "@boardwalk-labs/workflow";
       import { writeFileSync } from "node:fs";
       export default async function run() {
         writeFileSync("hello.txt", "written by the program");
         const ok = await shell("cat hello.txt");
         const bad = await shell("exit 3");
         return { out: ok.stdout, okCode: ok.exitCode, badCode: bad.exitCode };
       }`,
    );
    const row = await f.supervisor.supervise(f.startRun("sheller"));
    expect(row.status).toBe("completed");
    expect(row.output).toEqual({ out: "written by the program", okCode: 0, badCode: 3 });
  }, 20_000);

  it("unsupported capabilities fail CLOSED with actionable messages", async () => {
    const f = fixture();
    f.deploy(
      "wants-idtoken",
      `import { auth } from "@boardwalk-labs/workflow";
       export default async function run() {
         await auth.idToken("sts.amazonaws.com");
       }`,
    );
    const idToken = await f.supervisor.supervise(f.startRun("wants-idtoken"));
    expect(idToken.status).toBe("failed");
    expect(idToken.error?.code).toBe("UNSUPPORTED");
    expect(idToken.error?.message).toContain("auth.idToken");

    f.deploy(
      "wants-browser",
      `import { computer } from "@boardwalk-labs/workflow";
       export default async function run() {
         await computer.openBrowser();
       }`,
    );
    const browser = await f.supervisor.supervise(f.startRun("wants-browser"));
    expect(browser.status).toBe("failed");
    expect(browser.error?.code).toBe("UNSUPPORTED");
    expect(browser.error?.message).toContain("no browser backend");

    f.deploy(
      "wants-schedule",
      `import { workflows } from "@boardwalk-labs/workflow";
       export default async function run() {
         await workflows.schedule("wants-schedule", {}, { cron: "0 9 * * *" });
       }`,
    );
    const schedule = await f.supervisor.supervise(f.startRun("wants-schedule"));
    expect(schedule.status).toBe("failed");
    expect(schedule.error?.code).toBe("UNSUPPORTED");
    expect(schedule.error?.message).toContain("workflows.schedule");
  }, 30_000);

  it("emits phase markers and writes artifacts through the host bridge", async () => {
    const f = fixture();
    f.deploy(
      "artifacty",
      `import { phase, artifacts } from "@boardwalk-labs/workflow";
       export default async function run() {
         phase("collect");
         const ref = await artifacts.write("report.txt", "text/plain", "line one");
         phase("publish", { id: "publish-phase" });
         return { url: ref.url, name: ref.name };
       }`,
    );
    const runId = f.startRun("artifacty");
    const row = await f.supervisor.supervise(runId);

    expect(row.status).toBe("completed");
    const out = z.object({ url: z.string(), name: z.string() }).parse(row.output);
    expect(out.name).toBe("report.txt");
    expect(out.url).toMatch(/^file:\/\//);

    const stored = f.store.listArtifacts(runId);
    expect(stored).toHaveLength(1);
    expect(readFileSync(stored[0]?.path ?? "", "utf8")).toBe("line one");

    const phases = f.store
      .listEvents(runId)
      .map((e) => e.event)
      .filter((e) => e.kind === "phase");
    expect(phases.map((p) => p.name)).toEqual(["collect", "publish"]);
    expect(phases[0]?.id).toBe("phase-1"); // engine-assigned, in marker order
    expect(phases[1]?.id).toBe("publish-phase"); // author-supplied wins
  }, 20_000);

  it("recovers engine-orphaned runs on boot: active runs restart, cancelling finalizes", async () => {
    const f = fixture();
    f.deploy("echo", `export default async function run() { return "ran"; }`);
    // Simulate a dead engine: rows left behind in non-terminal states, no processes anywhere.
    const orphanRunning = f.startRun("echo");
    const orphanCancelling = f.startRun("echo");
    f.store.updateRunStatus(orphanRunning, "running", { startedAt: Date.now() });
    f.store.updateRunStatus(orphanCancelling, "cancelling");

    const { resumed, cancelled } = f.supervisor.recoverOnBoot();
    expect(cancelled).toEqual([orphanCancelling]);
    expect(resumed).toContain(orphanRunning);

    const row = await f.supervisor.supervise(orphanRunning);
    expect(row.status).toBe("completed");
    expect(row.output).toBe("ran");
    expect(f.store.getRun(orphanCancelling)?.status).toBe("cancelled");
  }, 20_000);

  it("boot recovery restarts a held-status row from the top — its process died with the engine", async () => {
    const f = fixture();
    f.deploy(
      "slow-kid",
      `import { sleep } from "@boardwalk-labs/workflow";
       export default async function run() {
         await sleep(150);
         return "kid-done";
       }`,
    );
    f.deploy(
      "waiter",
      `import { workflows } from "@boardwalk-labs/workflow";
       export default async function run() {
         return { said: await workflows.call("slow-kid", {}) };
       }`,
    );

    // Simulate an engine that died mid-hold: the row says waiting_for_child, but no process
    // exists (a live hold would have an active entry; this one has none).
    const parentId = f.startRun("waiter");
    f.store.updateRunStatus(parentId, "waiting_for_child");

    const { resumed } = f.supervisor.recoverOnBoot();
    expect(resumed).toContain(parentId);

    // The re-dispatched parent restarts from the top, runs the child, and completes. (Re-attach
    // idempotency across a crash is covered by the workflows.call crash test above.)
    await waitFor(() => f.store.getRun(parentId)?.status === "completed");
    expect(f.store.getRun(parentId)?.output).toEqual({ said: "kid-done" });
    expect(f.store.listRuns().filter((r) => r.parentRunId === parentId)).toHaveLength(1);
  }, 30_000);

  it("interpolates whole-value secret refs into manifest env for the child process", async () => {
    const f = fixture({ env: { API_KEY: "secret-value-42" } });
    f.deploy(
      "env-user",
      `export default async function run() {
         return process.env.MY_KEY ?? "unset";
       }`,
      {
        permissions: { secrets: [{ name: "API_KEY" }] },
        env: { MY_KEY: "${{ secrets.API_KEY }}", PLAIN: "plain-value" },
      },
    );
    const row = await f.supervisor.supervise(f.startRun("env-user"));
    expect(row.status).toBe("completed");
    expect(row.output).toBe("secret-value-42");
  }, 20_000);

  // The cross-engine half of the cwd contract (docs/WORKSPACE_PERSISTENCE.md I1 + §9). The engine has
  // chdir'd to the workspace since dev-on-engine, and EVERY persist test below leans on it (they all
  // write relative paths) — but nothing asserted it, on either engine. That gap is what let the hosted
  // runner ship with cwd `/` (fleet) and `/app` (Fargate) while dev stayed correct, so the same
  // program silently lost its state only when hosted. The runner asserts the same invariant in
  // program_runner.test.ts; these two must not drift apart again.
  describe("the workspace IS the working directory (WORKSPACE_PERSISTENCE.md I1)", () => {
    // The run's workspace, per prepareRunDir's layout. Resolved: macOS `tmpdir()` is a symlink
    // (/var → /private/var) and `process.cwd()` reports the REAL path, so an unresolved expectation
    // compares a symlink to its target and fails for the wrong reason.
    const workspaceOf = (dataDir: string, runId: string): string =>
      realpathSync(join(dataDir, "runs", runId, "workspace"));

    it("runs author code with cwd === the run's workspace dir (and context.workspaceDir)", async () => {
      const f = fixture();
      f.deploy(
        "cwd-probe",
        `export default async function run(input, context) {
           return { cwd: process.cwd(), fromContext: context.workspaceDir };
         }`,
      );
      const runId = f.startRun("cwd-probe", {});
      const row = await f.supervisor.supervise(runId);
      const out = z.object({ cwd: z.string(), fromContext: z.string() }).parse(row.output);
      expect(out.cwd).toBe(workspaceOf(f.dataDir, runId));
      expect(realpathSync(out.fromContext)).toBe(workspaceOf(f.dataDir, runId));
    }, 30_000);

    it("lands a program's RELATIVE write in the workspace, not wherever the engine was started", async () => {
      const f = fixture();
      f.deploy(
        "rel-write",
        `import { writeFileSync } from "node:fs";
         export default async function run() {
           writeFileSync("landed-here.txt", "x");
         }`,
      );
      const runId = f.startRun("rel-write", {});
      await f.supervisor.supervise(runId);
      expect(existsSync(join(workspaceOf(f.dataDir, runId), "landed-here.txt"))).toBe(true);
    }, 30_000);

    it("keeps the program bundle OUT of the workspace (I2)", async () => {
      const f = fixture();
      f.deploy(
        "iso",
        `import { writeFileSync } from "node:fs";
         export default async function run() { writeFileSync("only.txt", "x"); }`,
      );
      const runId = f.startRun("iso", {});
      await f.supervisor.supervise(runId);
      // The engine lays the program down as a SIBLING of the workspace (runs/<id>/program), so a
      // persist can never sweep the bundle into the durable state. The runner asserts the same.
      expect(readdirSync(workspaceOf(f.dataDir, runId))).toEqual(["only.txt"]);
    }, 30_000);
  });

  describe("workspace.persist", () => {
    // Reads state/value.txt if present, writes input.write to it, returns what it read.
    const COUNTER_PROGRAM = `
      import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
      export default async function run(input) {
        const previous = existsSync("state/value.txt") ? readFileSync("state/value.txt", "utf8") : null;
        mkdirSync("state", { recursive: true });
        writeFileSync("state/value.txt", input.write);
        return { read: previous };
      }
    `;

    it("declared dirs round-trip across runs (hydrate at start, persist at success)", async () => {
      const f = fixture();
      f.deploy("stateful", COUNTER_PROGRAM, { workspace: { persist: ["state"] } });

      const first = await f.supervisor.supervise(f.startRun("stateful", { write: "alpha" }));
      expect(first.status).toBe("completed");
      expect(first.output).toEqual({ read: null });

      const second = await f.supervisor.supervise(f.startRun("stateful", { write: "beta" }));
      expect(second.output).toEqual({ read: "alpha" });

      const third = await f.supervisor.supervise(f.startRun("stateful", { write: "gamma" }));
      expect(third.output).toEqual({ read: "beta" });
    }, 30_000);

    // A FAILED run DOES persist — every terminal path does (docs/WORKSPACE_PERSISTENCE.md §5).
    // This test asserted the opposite, because the engine used to persist on success only. That
    // became unenforceable the moment `sleep` existed (a suspending run persists mid-flight, so a
    // later failure can't un-write it), it disagreed with hosted for the same program, and it is
    // backwards for the loops persistence exists to serve: a failed attempt's memory is exactly what
    // the next attempt needs. Poisoned state is cured by RESET, not by dropping writes.
    it("a FAILED run persists its workspace — every terminal path does", async () => {
      const f = fixture();
      f.deploy("stateful", COUNTER_PROGRAM, { workspace: { persist: ["state"] } });
      await f.supervisor.supervise(f.startRun("stateful", { write: "keep-me" }));

      // Redeploy the SAME workflow (same durable root) with a program that writes then dies.
      f.deploy(
        "stateful",
        `import { mkdirSync, writeFileSync } from "node:fs";
         export default async function run() {
           mkdirSync("state", { recursive: true });
           writeFileSync("state/value.txt", "written-before-throwing");
           throw new Error("dies after writing");
         }`,
        { workspace: { persist: ["state"] } },
      );
      const failed = await f.supervisor.supervise(f.startRun("stateful", {}));
      expect(failed.status).toBe("failed");

      // Restore the reader program; the failed run's write is the new durable baseline.
      f.deploy("stateful", COUNTER_PROGRAM, { workspace: { persist: ["state"] } });
      const after = await f.supervisor.supervise(f.startRun("stateful", { write: "next" }));
      expect(after.output).toEqual({ read: "written-before-throwing" });
    }, 30_000);

    // `cancelled` and `budget` share the SAME persist statement as `failed` (it is hoisted above the
    // switch, guarded only against `crashed`), so the test above pins them too. Racing a real cancel
    // through the store's `cancelling` status would add flake, not coverage.

    it("persist: true round-trips the whole workspace", async () => {
      const f = fixture();
      f.deploy(
        "whole-workspace",
        `import { existsSync, readFileSync, writeFileSync } from "node:fs";
         export default async function run() {
           const seen = existsSync("anywhere.txt") ? readFileSync("anywhere.txt", "utf8") : null;
           writeFileSync("anywhere.txt", "wrote-once");
           return { seen };
         }`,
        { workspace: { persist: true } },
      );
      const first = await f.supervisor.supervise(f.startRun("whole-workspace"));
      expect(first.output).toEqual({ seen: null });
      const second = await f.supervisor.supervise(f.startRun("whole-workspace"));
      expect(second.output).toEqual({ seen: "wrote-once" });
    }, 30_000);

    it("a crash-restart keeps the crashed pass's workspace (no re-hydration)", async () => {
      const f = fixture();
      // Seed the durable store with value "A" via a successful run.
      f.deploy("resumer", COUNTER_PROGRAM, { workspace: { persist: ["state"] } });
      await f.supervisor.supervise(f.startRun("resumer", { write: "A" }));

      // Crash AFTER overwriting the persisted file. The restarted pass must see "B" (the
      // crashed pass's write) — re-hydration would reset it to "A".
      f.deploy(
        "resumer",
        `import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
         export default async function run() {
           if (!existsSync("crashed-once")) {
             mkdirSync("state", { recursive: true });
             writeFileSync("state/value.txt", "B");
             writeFileSync("crashed-once", "1");
             process.exit(5);
           }
           return { resumedWith: readFileSync("state/value.txt", "utf8") };
         }`,
        { workspace: { persist: ["state"] } },
      );
      const row = await f.supervisor.supervise(f.startRun("resumer", {}));
      expect(row.status).toBe("completed");
      expect(row.restarts).toBe(1);
      expect(row.output).toEqual({ resumedWith: "B" });
    }, 30_000);
  });
});

async function waitFor(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

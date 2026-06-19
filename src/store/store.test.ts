// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { validateMeta } from "@boardwalk-labs/workflow";
import type { RunEvent, WorkflowManifest } from "@boardwalk-labs/workflow";
import { EngineError } from "../errors.js";
import { isUlid } from "../ids.js";
import { Store } from "./store.js";

const BASE_T = 1_750_000_000_000;

let cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  cleanups = [];
});

/** A fresh in-memory store whose clock ticks 1ms per call — deterministic ordering. */
function openStore(): Store {
  let t = BASE_T;
  const store = new Store(":memory:", { now: () => ++t });
  cleanups.push(() => {
    store.close();
  });
  return store;
}

/** A file-backed store so a second raw connection can corrupt rows behind the Store's back. */
function openFileStore(): { store: Store; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "boardwalk-store-"));
  const path = join(dir, "engine.db");
  const store = new Store(path);
  cleanups.push(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { store, path };
}

function corruptColumn(path: string, sql: string): void {
  const raw = new DatabaseSync(path);
  raw.exec(sql);
  raw.close();
}

function makeManifest(name: string): WorkflowManifest {
  return validateMeta({ slug: name, triggers: [{ kind: "manual" }] });
}

function seedWorkflow(store: Store, name = "merge-conflict-resolver"): { id: string } {
  return store.upsertWorkflow({ slug: name, manifest: makeManifest(name), program: "export {};" });
}

function seedRun(store: Store, workflowId: string): { id: string } {
  return store.createRun({ workflowId, triggerKind: "manual" }).run;
}

function logEvent(runId: string, seq: number): RunEvent {
  return {
    runId,
    turnId: "turn-0",
    seq,
    t: BASE_T,
    kind: "program_output",
    stream: "stdout",
    text: `line ${seq}`,
  };
}

function expectEngineError(fn: () => unknown, code: EngineError["code"]): EngineError {
  let thrown: unknown;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(EngineError);
  if (!(thrown instanceof EngineError)) throw new Error("unreachable: asserted above");
  expect(thrown.code).toBe(code);
  return thrown;
}

describe("Store: workflows", () => {
  it("inserts a workflow and round-trips manifest + config exactly", () => {
    const store = openStore();
    const manifest = makeManifest("resolver");
    const config = { channel: "#oncall", retries: 3, flags: { dryRun: false } };
    const row = store.upsertWorkflow({
      slug: "resolver",
      manifest,
      program: "export const x = 1;",
      config,
    });
    expect(isUlid(row.id)).toBe(true);
    expect(row.slug).toBe("resolver");
    expect(row.manifest).toEqual(manifest);
    expect(row.config).toEqual(config);
    expect(row.program).toBe("export const x = 1;");
    expect(row.createdAt).toBe(row.updatedAt);
    expect(store.getWorkflow("resolver")).toEqual(row);
    expect(store.getWorkflowById(row.id)).toEqual(row);
  });

  it("defaults config to an empty object", () => {
    const store = openStore();
    const row = store.upsertWorkflow({
      slug: "wf",
      manifest: makeManifest("wf"),
      program: "export {};",
    });
    expect(row.config).toEqual({});
  });

  it("updates by slug: id and created_at stable, updated_at bumps, content replaced", () => {
    const store = openStore();
    const first = store.upsertWorkflow({
      slug: "wf",
      manifest: makeManifest("wf"),
      program: "// v1",
    });
    const second = store.upsertWorkflow({
      slug: "wf",
      manifest: makeManifest("wf"),
      program: "// v2",
      config: { version: 2 },
    });
    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt).toBeGreaterThan(first.updatedAt);
    expect(second.program).toBe("// v2");
    expect(second.config).toEqual({ version: 2 });
    expect(store.listWorkflows()).toHaveLength(1);
  });

  it("rejects an invalid manifest with VALIDATION instead of persisting it", () => {
    const store = openStore();
    const invalid = { ...makeManifest("wf"), name: "" };
    expectEngineError(
      () => store.upsertWorkflow({ slug: "wf", manifest: invalid, program: "" }),
      "VALIDATION",
    );
    expect(store.getWorkflow("wf")).toBeNull();
  });

  it("returns null for unknown workflows and lists by slug", () => {
    const store = openStore();
    expect(store.getWorkflow("nope")).toBeNull();
    expect(store.getWorkflowById("nope")).toBeNull();
    seedWorkflow(store, "zeta");
    seedWorkflow(store, "alpha");
    expect(store.listWorkflows().map((w) => w.slug)).toEqual(["alpha", "zeta"]);
  });
});

describe("Store: runs", () => {
  it("creates a queued run with zeroed tallies and round-trips input", () => {
    const store = openStore();
    const workflow = seedWorkflow(store);
    const input = { pr: 42, files: ["a.ts", "b.ts"] };
    const { run, created } = store.createRun({
      workflowId: workflow.id,
      triggerKind: "webhook",
      input,
    });
    expect(created).toBe(true);
    expect(isUlid(run.id)).toBe(true);
    expect(run).toEqual({
      id: run.id,
      workflowId: workflow.id,
      status: "queued",
      triggerKind: "webhook",
      input,
      output: null,
      error: null,
      parentRunId: null,
      idempotencyKey: null,
      restarts: 0,
      tokensIn: 0,
      tokensOut: 0,
      usdMicros: 0,
      createdAt: run.createdAt,
      startedAt: null,
      endedAt: null,
      wakeAt: null,
    });
    expect(store.getRun(run.id)).toEqual(run);
  });

  it("stores omitted input as null", () => {
    const store = openStore();
    const workflow = seedWorkflow(store);
    expect(seedRun(store, workflow.id)).toMatchObject({ input: null });
  });

  it("throws NOT_FOUND for an unknown workflow or parent run", () => {
    const store = openStore();
    const workflow = seedWorkflow(store);
    expectEngineError(
      () => store.createRun({ workflowId: "missing", triggerKind: "manual" }),
      "NOT_FOUND",
    );
    expectEngineError(
      () =>
        store.createRun({ workflowId: workflow.id, triggerKind: "manual", parentRunId: "missing" }),
      "NOT_FOUND",
    );
  });

  it("re-attaches on the same (parent, idempotencyKey) and creates on a different key", () => {
    const store = openStore();
    const workflow = seedWorkflow(store);
    const parent = seedRun(store, workflow.id);
    const first = store.createRun({
      workflowId: workflow.id,
      triggerKind: "manual",
      parentRunId: parent.id,
      idempotencyKey: "call-site-1",
    });
    expect(first.created).toBe(true);
    const reattached = store.createRun({
      workflowId: workflow.id,
      triggerKind: "manual",
      parentRunId: parent.id,
      idempotencyKey: "call-site-1",
    });
    expect(reattached.created).toBe(false);
    expect(reattached.run.id).toBe(first.run.id);
    const other = store.createRun({
      workflowId: workflow.id,
      triggerKind: "manual",
      parentRunId: parent.id,
      idempotencyKey: "call-site-2",
    });
    expect(other.created).toBe(true);
    expect(other.run.id).not.toBe(first.run.id);
  });

  it("re-attaches by idempotency key with no parent run (NULL parent)", () => {
    const store = openStore();
    const workflow = seedWorkflow(store);
    const first = store.createRun({
      workflowId: workflow.id,
      triggerKind: "webhook",
      idempotencyKey: "delivery-9",
    });
    const second = store.createRun({
      workflowId: workflow.id,
      triggerKind: "webhook",
      idempotencyKey: "delivery-9",
    });
    expect(second.created).toBe(false);
    expect(second.run.id).toBe(first.run.id);
  });

  it("updates status with outcome fields in one write and round-trips them", () => {
    const store = openStore();
    const workflow = seedWorkflow(store);
    const run = seedRun(store, workflow.id);
    store.updateRunStatus(run.id, "running", { startedAt: BASE_T + 100 });
    expect(store.getRun(run.id)).toMatchObject({ status: "running", startedAt: BASE_T + 100 });
    const output = { merged: true, conflicts: [] };
    store.updateRunStatus(run.id, "completed", { output, endedAt: BASE_T + 200 });
    expect(store.getRun(run.id)).toMatchObject({
      status: "completed",
      output,
      endedAt: BASE_T + 200,
    });
    const error = { code: "PROGRAM_ERROR", message: "boom" };
    store.updateRunStatus(run.id, "failed", { error });
    expect(store.getRun(run.id)?.error).toEqual(error);
  });

  it("throws NOT_FOUND when updating an unknown run", () => {
    const store = openStore();
    expectEngineError(() => store.updateRunStatus("missing", "running"), "NOT_FOUND");
  });

  it("increments restarts and returns the new count", () => {
    const store = openStore();
    const workflow = seedWorkflow(store);
    const run = seedRun(store, workflow.id);
    expect(store.incrementRestarts(run.id)).toBe(1);
    expect(store.incrementRestarts(run.id)).toBe(2);
    expect(store.getRun(run.id)?.restarts).toBe(2);
    expectEngineError(() => store.incrementRestarts("missing"), "NOT_FOUND");
  });

  it("accumulates usage across partial reports", () => {
    const store = openStore();
    const workflow = seedWorkflow(store);
    const run = seedRun(store, workflow.id);
    store.addRunUsage(run.id, { tokensIn: 100, tokensOut: 20 });
    store.addRunUsage(run.id, { tokensIn: 50, usdMicros: 1234 });
    expect(store.getRunUsage(run.id)).toEqual({ tokensIn: 150, tokensOut: 20, usdMicros: 1234 });
    expect(store.getRun(run.id)).toMatchObject({ tokensIn: 150, tokensOut: 20, usdMicros: 1234 });
  });

  it("rejects non-integer usage and unknown runs", () => {
    const store = openStore();
    const workflow = seedWorkflow(store);
    const run = seedRun(store, workflow.id);
    expectEngineError(() => store.addRunUsage(run.id, { usdMicros: 1.5 }), "VALIDATION");
    expectEngineError(() => store.addRunUsage("missing", { tokensIn: 1 }), "NOT_FOUND");
    expectEngineError(() => store.getRunUsage("missing"), "NOT_FOUND");
  });

  it("lists runs newest first with workflow/status filters and limit/offset", () => {
    const store = openStore();
    const wfA = seedWorkflow(store, "wf-a");
    const wfB = seedWorkflow(store, "wf-b");
    const run1 = seedRun(store, wfA.id);
    const run2 = seedRun(store, wfB.id);
    const run3 = seedRun(store, wfA.id);
    store.updateRunStatus(run2.id, "running");
    store.updateRunStatus(run3.id, "completed");

    expect(store.listRuns().map((r) => r.id)).toEqual([run3.id, run2.id, run1.id]);
    expect(store.listRuns({ workflowId: wfA.id }).map((r) => r.id)).toEqual([run3.id, run1.id]);
    expect(store.listRuns({ statuses: ["running", "completed"] }).map((r) => r.id)).toEqual([
      run3.id,
      run2.id,
    ]);
    expect(store.listRuns({ workflowId: wfA.id, statuses: ["queued"] }).map((r) => r.id)).toEqual([
      run1.id,
    ]);
    expect(store.listRuns({ statuses: [] })).toEqual([]);
    expect(store.listRuns({ limit: 1 }).map((r) => r.id)).toEqual([run3.id]);
    expect(store.listRuns({ limit: 2, offset: 1 }).map((r) => r.id)).toEqual([run2.id, run1.id]);
  });
});

describe("Store: run events", () => {
  it("appends and lists events in cursor order, round-tripping the payload exactly", () => {
    const store = openStore();
    const workflow = seedWorkflow(store);
    const run = seedRun(store, workflow.id);
    const rows = [
      { cursor: 1, event: logEvent(run.id, 1) },
      { cursor: 2, event: logEvent(run.id, 2) },
    ];
    store.appendEvents(run.id, rows);
    expect(store.listEvents(run.id)).toEqual([
      { runId: run.id, cursor: 1, event: rows[0]?.event },
      { runId: run.id, cursor: 2, event: rows[1]?.event },
    ]);
  });

  it("lists ascending even when batches arrive out of order, honoring afterCursor and limit", () => {
    const store = openStore();
    const workflow = seedWorkflow(store);
    const run = seedRun(store, workflow.id);
    store.appendEvents(run.id, [{ cursor: 5, event: logEvent(run.id, 5) }]);
    store.appendEvents(run.id, [
      { cursor: 2, event: logEvent(run.id, 2) },
      { cursor: 9, event: logEvent(run.id, 9) },
    ]);
    expect(store.listEvents(run.id).map((e) => e.cursor)).toEqual([2, 5, 9]);
    expect(store.listEvents(run.id, { afterCursor: 2 }).map((e) => e.cursor)).toEqual([5, 9]);
    expect(store.listEvents(run.id, { afterCursor: 2, limit: 1 }).map((e) => e.cursor)).toEqual([
      5,
    ]);
    expect(store.listEvents("missing")).toEqual([]);
  });

  it("reports maxCursor (0 when the run has no events)", () => {
    const store = openStore();
    const workflow = seedWorkflow(store);
    const run = seedRun(store, workflow.id);
    expect(store.maxCursor(run.id)).toBe(0);
    store.appendEvents(run.id, [{ cursor: 7, event: logEvent(run.id, 7) }]);
    expect(store.maxCursor(run.id)).toBe(7);
  });

  it("inserts NOTHING when a batch contains a duplicate cursor (transactional append)", () => {
    const store = openStore();
    const workflow = seedWorkflow(store);
    const run = seedRun(store, workflow.id);
    expectEngineError(
      () =>
        store.appendEvents(run.id, [
          { cursor: 1, event: logEvent(run.id, 1) },
          { cursor: 2, event: logEvent(run.id, 2) },
          { cursor: 1, event: logEvent(run.id, 3) },
        ]),
      "CONFLICT",
    );
    expect(store.listEvents(run.id)).toEqual([]);
    expect(store.maxCursor(run.id)).toBe(0);
  });

  it("throws CONFLICT on a cursor that already exists and keeps the original event", () => {
    const store = openStore();
    const workflow = seedWorkflow(store);
    const run = seedRun(store, workflow.id);
    const original = logEvent(run.id, 1);
    store.appendEvents(run.id, [{ cursor: 1, event: original }]);
    expectEngineError(
      () => store.appendEvents(run.id, [{ cursor: 1, event: logEvent(run.id, 99) }]),
      "CONFLICT",
    );
    expect(store.listEvents(run.id)).toEqual([{ runId: run.id, cursor: 1, event: original }]);
  });

  it("rejects unknown runs, bad cursors, and treats an empty batch as a no-op", () => {
    const store = openStore();
    const workflow = seedWorkflow(store);
    const run = seedRun(store, workflow.id);
    expectEngineError(
      () => store.appendEvents("missing", [{ cursor: 1, event: logEvent("missing", 1) }]),
      "NOT_FOUND",
    );
    expectEngineError(
      () => store.appendEvents(run.id, [{ cursor: 0, event: logEvent(run.id, 1) }]),
      "VALIDATION",
    );
    expectEngineError(
      () => store.appendEvents(run.id, [{ cursor: 1.5, event: logEvent(run.id, 1) }]),
      "VALIDATION",
    );
    store.appendEvents(run.id, []);
    expect(store.maxCursor(run.id)).toBe(0);
  });
});

describe("Store: cron fires", () => {
  it("records fires and returns the latest fire time per trigger", () => {
    const store = openStore();
    const workflow = seedWorkflow(store);
    const runA = seedRun(store, workflow.id);
    const runB = seedRun(store, workflow.id);
    expect(store.lastCronFire(workflow.id, 0)).toBeNull();
    store.recordCronFire({
      workflowId: workflow.id,
      triggerIndex: 0,
      fireTime: 1000,
      runId: runA.id,
    });
    store.recordCronFire({
      workflowId: workflow.id,
      triggerIndex: 0,
      fireTime: 2000,
      runId: runB.id,
    });
    expect(store.lastCronFire(workflow.id, 0)).toBe(2000);
    // A different trigger index on the same workflow is an independent series.
    expect(store.lastCronFire(workflow.id, 1)).toBeNull();
  });

  it("throws CONFLICT on a duplicate (workflow, trigger, fireTime) — the exactly-once guard", () => {
    const store = openStore();
    const workflow = seedWorkflow(store);
    const runA = seedRun(store, workflow.id);
    const runB = seedRun(store, workflow.id);
    store.recordCronFire({
      workflowId: workflow.id,
      triggerIndex: 0,
      fireTime: 1000,
      runId: runA.id,
    });
    expectEngineError(
      () =>
        store.recordCronFire({
          workflowId: workflow.id,
          triggerIndex: 0,
          fireTime: 1000,
          runId: runB.id,
        }),
      "CONFLICT",
    );
  });

  it("throws NOT_FOUND when the workflow or run does not exist", () => {
    const store = openStore();
    const workflow = seedWorkflow(store);
    expectEngineError(
      () =>
        store.recordCronFire({ workflowId: workflow.id, triggerIndex: 0, fireTime: 1, runId: "x" }),
      "NOT_FOUND",
    );
  });
});

describe("Store: artifacts", () => {
  it("round-trips an artifact including JSON metadata", () => {
    const store = openStore();
    const workflow = seedWorkflow(store);
    const run = seedRun(store, workflow.id);
    const metadata = { source: "agent", tags: ["report", "weekly"] };
    const artifact = store.createArtifact({
      runId: run.id,
      name: "report.md",
      contentType: "text/markdown",
      path: "artifacts/ab/cdef",
      size: 2048,
      metadata,
    });
    expect(isUlid(artifact.id)).toBe(true);
    expect(artifact).toEqual({
      id: artifact.id,
      runId: run.id,
      name: "report.md",
      contentType: "text/markdown",
      path: "artifacts/ab/cdef",
      size: 2048,
      metadata,
      createdAt: artifact.createdAt,
    });
    expect(store.listArtifacts(run.id)).toEqual([artifact]);
  });

  it("stores omitted metadata as null and lists only the run's artifacts in order", () => {
    const store = openStore();
    const workflow = seedWorkflow(store);
    const runA = seedRun(store, workflow.id);
    const runB = seedRun(store, workflow.id);
    const first = store.createArtifact({
      runId: runA.id,
      name: "a.txt",
      contentType: "text/plain",
      path: "p/a",
      size: 1,
    });
    const second = store.createArtifact({
      runId: runA.id,
      name: "b.txt",
      contentType: "text/plain",
      path: "p/b",
      size: 2,
    });
    store.createArtifact({
      runId: runB.id,
      name: "other.txt",
      contentType: "text/plain",
      path: "p/o",
      size: 3,
    });
    expect(first.metadata).toBeNull();
    expect(store.listArtifacts(runA.id)).toEqual([first, second]);
  });

  it("throws NOT_FOUND for an unknown run and VALIDATION for a non-integer size", () => {
    const store = openStore();
    const workflow = seedWorkflow(store);
    const run = seedRun(store, workflow.id);
    expectEngineError(
      () =>
        store.createArtifact({
          runId: "missing",
          name: "x",
          contentType: "text/plain",
          path: "p",
          size: 1,
        }),
      "NOT_FOUND",
    );
    expectEngineError(
      () =>
        store.createArtifact({
          runId: run.id,
          name: "x",
          contentType: "text/plain",
          path: "p",
          size: 1.5,
        }),
      "VALIDATION",
    );
  });
});

describe("Store: transactions", () => {
  it("rolls back everything when the function throws (no partial writes)", () => {
    const store = openStore();
    const workflow = seedWorkflow(store);
    let runId = "";
    expect(() =>
      store.transaction(() => {
        runId = seedRun(store, workflow.id).id;
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(store.getRun(runId)).toBeNull();
    expect(store.listRuns()).toEqual([]);
  });

  it("composes: a scheduler-style createRun + recordCronFire conflict leaves no run behind", () => {
    const store = openStore();
    const workflow = seedWorkflow(store);
    const priorRun = seedRun(store, workflow.id);
    store.recordCronFire({
      workflowId: workflow.id,
      triggerIndex: 0,
      fireTime: 1000,
      runId: priorRun.id,
    });
    // A second scheduler pass for the same tick: the run it optimistically created must
    // vanish with the CONFLICT — this is the exactly-once fire in practice.
    expectEngineError(
      () =>
        store.transaction(() => {
          const run = seedRun(store, workflow.id);
          store.recordCronFire({
            workflowId: workflow.id,
            triggerIndex: 0,
            fireTime: 1000,
            runId: run.id,
          });
        }),
      "CONFLICT",
    );
    expect(store.listRuns().map((r) => r.id)).toEqual([priorRun.id]);
  });

  it("joins nested transactions: inner writes commit with the outer", () => {
    const store = openStore();
    const workflow = seedWorkflow(store);
    const id = store.transaction(() => store.transaction(() => seedRun(store, workflow.id).id));
    expect(store.getRun(id)).not.toBeNull();
  });

  it("joins nested transactions: an outer throw rolls back completed inner work", () => {
    const store = openStore();
    const workflow = seedWorkflow(store);
    let runId = "";
    expect(() =>
      store.transaction(() => {
        runId = store.transaction(() => seedRun(store, workflow.id).id);
        throw new Error("outer boom");
      }),
    ).toThrow("outer boom");
    expect(store.getRun(runId)).toBeNull();
  });

  it("returns the function's value", () => {
    const store = openStore();
    expect(store.transaction(() => 42)).toBe(42);
  });
});

describe("Store: corrupted JSON columns throw INTERNAL naming table.column", () => {
  it("rejects invalid JSON in workflows.manifest", () => {
    const { store, path } = openFileStore();
    seedWorkflow(store, "wf");
    corruptColumn(path, "UPDATE workflows SET manifest = 'not json'");
    const err = expectEngineError(() => store.getWorkflow("wf"), "INTERNAL");
    expect(err.message).toContain("workflows.manifest");
  });

  it("rejects schema-invalid JSON in workflows.manifest", () => {
    const { store, path } = openFileStore();
    seedWorkflow(store, "wf");
    corruptColumn(path, `UPDATE workflows SET manifest = '{"triggers": []}'`);
    const err = expectEngineError(() => store.getWorkflow("wf"), "INTERNAL");
    expect(err.message).toContain("workflows.manifest");
  });

  it("rejects an unknown runs.status value", () => {
    const { store, path } = openFileStore();
    const workflow = seedWorkflow(store, "wf");
    const run = seedRun(store, workflow.id);
    corruptColumn(path, "UPDATE runs SET status = 'exploded'");
    const err = expectEngineError(() => store.getRun(run.id), "INTERNAL");
    expect(err.message).toContain("runs.status");
  });

  it("rejects a corrupted run_events.event payload", () => {
    const { store, path } = openFileStore();
    const workflow = seedWorkflow(store, "wf");
    const run = seedRun(store, workflow.id);
    store.appendEvents(run.id, [{ cursor: 1, event: logEvent(run.id, 1) }]);
    corruptColumn(path, `UPDATE run_events SET event = '{"kind": "mystery"}'`);
    const err = expectEngineError(() => store.listEvents(run.id), "INTERNAL");
    expect(err.message).toContain("run_events.event");
  });
});

describe("Store: run journal", () => {
  it("puts + gets a resolved entry and round-trips the result", () => {
    const store = openStore();
    const wf = seedWorkflow(store, "wf");
    const run = seedRun(store, wf.id);
    expect(store.getJournalEntry(run.id, 1)).toBeNull();
    const row = store.putJournalEntry({
      runId: run.id,
      seq: 1,
      kind: "agent",
      fingerprint: "fp-1",
      label: "summarize",
      state: "resolved",
      result: { answer: 42 },
    });
    expect(row.state).toBe("resolved");
    expect(row.result).toEqual({ answer: 42 });
    expect(row.resolvedAt).not.toBeNull();
    expect(store.getJournalEntry(run.id, 1)).toEqual(row);
  });

  it("is idempotent on (run_id, seq): the existing entry wins", () => {
    const store = openStore();
    const wf = seedWorkflow(store, "wf");
    const run = seedRun(store, wf.id);
    const first = store.putJournalEntry({
      runId: run.id,
      seq: 1,
      kind: "step",
      fingerprint: "fp",
      state: "resolved",
      result: "one",
    });
    const second = store.putJournalEntry({
      runId: run.id,
      seq: 1,
      kind: "step",
      fingerprint: "fp",
      state: "resolved",
      result: "two",
    });
    expect(second).toEqual(first);
    expect(second.result).toBe("one");
  });

  it("resolves a pending entry, and a null value is preserved as a resolved null", () => {
    const store = openStore();
    const wf = seedWorkflow(store, "wf");
    const run = seedRun(store, wf.id);
    store.putJournalEntry({
      runId: run.id,
      seq: 1,
      kind: "human_input",
      fingerprint: "fp",
      state: "pending",
    });
    store.resolveJournalEntry(run.id, 1, null);
    const row = store.getJournalEntry(run.id, 1);
    expect(row?.state).toBe("resolved");
    expect(row?.result).toBeNull();
    expectEngineError(() => store.resolveJournalEntry(run.id, 99, "x"), "NOT_FOUND");
  });

  it("lists a run's journal in seq order", () => {
    const store = openStore();
    const wf = seedWorkflow(store, "wf");
    const run = seedRun(store, wf.id);
    for (const seq of [2, 1, 3]) {
      store.putJournalEntry({
        runId: run.id,
        seq,
        kind: "agent",
        fingerprint: "f",
        state: "resolved",
        result: seq,
      });
    }
    expect(store.listJournal(run.id).map((e) => e.seq)).toEqual([1, 2, 3]);
  });
});

describe("Store: human-input requests", () => {
  function seedRequest(store: Store, runId: string, key = "approve") {
    return store.createHumanInputRequest({
      runId,
      seq: 1,
      key,
      prompt: "Approve?",
      inputSpec: { kind: "choice", options: ["Approve", "Reject"] },
      assignees: ["role:admin"],
    });
  }

  it("creates a pending request and finds it by (run, key)", () => {
    const store = openStore();
    const wf = seedWorkflow(store, "wf");
    const run = seedRun(store, wf.id);
    const req = seedRequest(store, run.id);
    expect(req.status).toBe("pending");
    expect(req.assignees).toEqual(["role:admin"]);
    expect(store.getHumanInputRequest(req.id)).toEqual(req);
    expect(store.findPendingHumanInputRequest(run.id, "approve")?.id).toBe(req.id);
    expect(store.findPendingHumanInputRequest(run.id, "nope")).toBeNull();
  });

  it("resolves atomically: the first responder wins, a second gets null", () => {
    const store = openStore();
    const wf = seedWorkflow(store, "wf");
    const run = seedRun(store, wf.id);
    const req = seedRequest(store, run.id);
    const resolved = store.resolveHumanInputRequest(
      req.id,
      { value: "Approve", isOther: false },
      "user:1",
    );
    expect(resolved?.status).toBe("resolved");
    expect(resolved?.response).toEqual({ value: "Approve", isOther: false });
    expect(resolved?.respondedBy).toBe("user:1");
    expect(store.resolveHumanInputRequest(req.id, { value: "Reject", isOther: false })).toBeNull();
  });

  it("lists requests filtered by run and status, and cancels pending ones", () => {
    const store = openStore();
    const wf = seedWorkflow(store, "wf");
    const run = seedRun(store, wf.id);
    seedRequest(store, run.id, "a");
    seedRequest(store, run.id, "b");
    expect(store.listHumanInputRequests({ runId: run.id, statuses: ["pending"] })).toHaveLength(2);
    store.cancelPendingHumanInputRequests(run.id);
    expect(store.listHumanInputRequests({ runId: run.id, statuses: ["pending"] })).toHaveLength(0);
    expect(store.listHumanInputRequests({ runId: run.id, statuses: ["cancelled"] })).toHaveLength(
      2,
    );
  });
});

describe("Store: timed wake", () => {
  it("returns only suspended runs whose wake_at is due", () => {
    const store = openStore();
    const wf = seedWorkflow(store, "wf");
    const due = seedRun(store, wf.id);
    const future = seedRun(store, wf.id);
    const running = seedRun(store, wf.id);
    store.updateRunStatus(due.id, "sleeping", { wakeAt: 1000 });
    store.updateRunStatus(future.id, "awaiting_input", { wakeAt: 9_000_000_000_000 });
    store.updateRunStatus(running.id, "running");
    const woke = store.listRunsToWake(2000).map((r) => r.id);
    expect(woke).toEqual([due.id]);
    // Clearing wake_at on resume removes it from the sweep.
    store.updateRunStatus(due.id, "pending", { wakeAt: null });
    expect(store.listRunsToWake(2000)).toHaveLength(0);
  });
});

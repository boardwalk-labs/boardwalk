// SPDX-License-Identifier: Apache-2.0

// The run supervisor — owns run-lifecycle state transitions and process supervision
// (SPEC §2.2). Layering: knows nothing about HTTP or the CLI; persistence
// goes through the Store; what workflows *do* lives in the child process.
//
// Semantics implemented here, identical in every engine:
//   - one run = one spawned process, isolated working directory
//   - hold-and-pay: sleep holds the child; nothing here checkpoints
//   - restart-on-crash: child death without a done/failed report restarts the run from the
//     top, bounded by maxRestarts, then `failed` with code CRASHED
//   - cancellation: cooperative SIGTERM, then SIGKILL after a grace window
//   - budgets terminate: max_duration_seconds is a supervisor deadline spanning restarts
//   - crash-safe: every transition is persisted before/with its event; a recovery sweep on
//     boot re-dispatches whatever a dead engine left behind
//
// Envelope authority: the child sends event BODIES; this is the only place envelopes are
// stamped and cursors allocated. On restart the cursor resumes past maxCursor so a filtered
// SSE consumer's resume position stays valid across crashes.

import { spawn, type ChildProcess } from "node:child_process";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  makeCursor,
  runEventSchema,
  TURN_CURSOR_STRIDE,
  type JsonValue,
  type RunEvent,
  type WorkflowManifest,
} from "@boardwalk-labs/workflow";
// Why from the store: the SDK defines RunStatus but doesn't re-export it from its root yet;
// the store derives the identical union from RunEvent and re-exports it.
import type { RunStatus } from "../store/store.js";
import { usageUsdMicros } from "../agent/rates.js";
import { resolveModel, type InferenceConfig } from "../agent/resolve.js";
import { MEMORY_PATH_RE } from "../agent/tools.js";
import { systemClock, type Clock } from "../clock.js";
import { EngineError, toErrorShape } from "../errors.js";
import { asJsonValue } from "../json_value.js";
import { refreshAccessToken } from "../mcp/oauth.js";
import { McpTokenStore, MCP_TOKENS_FILENAME } from "../mcp/token_store.js";
import type { EventRow, RunRow, Store, WorkflowRow } from "../store/store.js";
import { defaultIdempotencyKey } from "./idempotency.js";
import {
  callWorkflowArgsSchema,
  callWorkflowJournaledArgsSchema,
  childToParentSchema,
  getSecretArgsSchema,
  journalGetArgsSchema,
  journalPutArgsSchema,
  mcpTokenArgsSchema,
  readArtifactArgsSchema,
  resolveModelArgsSchema,
  webSearchArgsSchema,
  writeArtifactArgsSchema,
  type ChildToParent,
  type HostMethod,
  type InitMessage,
  type IpcErrorShape,
  type RunEventBody,
} from "./ipc.js";
import { runWebSearch } from "./web_search.js";
import {
  hydrateWorkspace,
  packageRoot,
  persistRoot,
  persistWorkspace,
  prepareRunDir,
  skillsDirOf,
  type RunDirs,
} from "./run_dir.js";

export interface SupervisorOptions {
  store: Store;
  /** Engine data directory; run dirs live under `<dataDir>/runs/<runId>`. */
  dataDir: string;
  /** Absolute path to the compiled child entry (dist/run/child.js). */
  childEntryPath: string;
  /** The local secret/env source (.env contents); process.env is the fallback. */
  env: ReadonlyMap<string, string>;
  /** Where secrets come from, for actionable error messages (never values). */
  envLabel: string;
  clock?: Clock;
  /** Crash restarts per run before `failed`/CRASHED. Default 2 (three attempts total). */
  maxRestarts?: number;
  /** Cooperative-cancellation window before SIGKILL. Default 10s. */
  cancelGraceMs?: number;
  /** Default model + provider table for agent() leaves. Default: built-ins only, no default model. */
  inference?: InferenceConfig;
}

type SpawnResult =
  | { kind: "done"; output: unknown; outputDeclared: boolean }
  | { kind: "failed"; error: IpcErrorShape; output: unknown; outputDeclared: boolean }
  | { kind: "crashed" }
  | { kind: "cancelled" }
  | { kind: "budget" }
  | { kind: "suspended" };

interface ActiveRun {
  promise: Promise<RunRow>;
  child: ChildProcess | null;
  cancelRequested: boolean;
  /** Set when a budget kill is in flight — names which budget, for the failure message. */
  budgetReason: string | null;
  /** Set when the child signaled a durable suspension — the exit is a park, not a crash. */
  suspendRequested: boolean;
  /** Memory dirs agent() calls used this run — auto-persisted at successful run end. */
  memoryDirs: Set<string>;
  envelope: { turn: number; seq: number };
}

const TERMINAL_STATUSES: readonly RunStatus[] = ["completed", "failed", "cancelled"];
const SUSPENDED_STATUSES: readonly RunStatus[] = [
  "sleeping",
  "awaiting_input",
  "waiting_for_child",
];

/** True when a run is parked (released its process), awaiting an external wake. */
export function isSuspended(status: RunStatus): boolean {
  return SUSPENDED_STATUSES.includes(status);
}

/** Treat an MCP access token expiring this soon as already expired — a token that dies
 *  between the broker reply and the server call would burn the child's whole 401 retry. */
const MCP_TOKEN_EXPIRY_SKEW_MS = 30_000;

/** True when a run can no longer change state. */
export function isTerminal(status: RunStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** Read the child run id off a pending workflow_call journal entry's result ({ childRunId }). */
function readChildRunId(result: JsonValue | null): string | null {
  if (typeof result !== "object" || result === null || Array.isArray(result)) return null;
  const value = result.childRunId;
  return typeof value === "string" ? value : null;
}

export class RunSupervisor {
  private readonly store: Store;
  private readonly dataDir: string;
  private readonly childEntryPath: string;
  private readonly env: ReadonlyMap<string, string>;
  private readonly envLabel: string;
  private readonly clock: Clock;
  private readonly maxRestarts: number;
  private readonly cancelGraceMs: number;
  private readonly inference: InferenceConfig;
  private readonly mcpTokens: McpTokenStore;
  private readonly active = new Map<string, ActiveRun>();
  private readonly listeners = new Set<(row: EventRow) => void>();

  constructor(opts: SupervisorOptions) {
    this.store = opts.store;
    this.dataDir = opts.dataDir;
    this.childEntryPath = opts.childEntryPath;
    this.env = opts.env;
    this.envLabel = opts.envLabel;
    this.clock = opts.clock ?? systemClock;
    this.maxRestarts = opts.maxRestarts ?? 2;
    this.cancelGraceMs = opts.cancelGraceMs ?? 10_000;
    this.inference = opts.inference ?? {};
    // Same path Engine.authorizeMcpServer writes — the interactive grant lands where runs read.
    this.mcpTokens = new McpTokenStore(join(opts.dataDir, MCP_TOKENS_FILENAME));
  }

  /** Subscribe to every stamped run event (the local feed for SSE/log UIs). */
  onEvent(listener: (row: EventRow) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Drive a run to terminal status; idempotent per run id (a second call while active returns
   * the same promise; a call on a terminal run resolves immediately). Never rejects for run
   * failures — failure is a status, not an exception. Rejects only on caller bugs (unknown id).
   */
  supervise(runId: string): Promise<RunRow> {
    const existing = this.active.get(runId);
    if (existing !== undefined) return existing.promise;

    const run = this.store.getRun(runId);
    if (run === null) {
      return Promise.reject(new EngineError("NOT_FOUND", `Unknown run: ${runId}`));
    }
    if (isTerminal(run.status)) return Promise.resolve(run);
    // A parked run is driven only by resume() (a wake or a submitted answer), never by a bare
    // supervise() — returning it as-is keeps a parent's workflows.call hold pending across the
    // child's suspend+resume instead of re-spawning it here.
    if (isSuspended(run.status)) return Promise.resolve(run);
    if (run.status === "cancelling") {
      // An interrupted cancellation (the killer died mid-kill). The process is gone — the
      // orphan exits on IPC disconnect — so finalize instead of re-executing.
      this.store.updateRunStatus(runId, "cancelled", { endedAt: this.clock.now() });
      this.stampAndStore(runId, this.resumeEnvelope(runId), {
        kind: "run_status",
        status: "cancelled",
      });
      return Promise.resolve(this.mustGetRun(runId));
    }

    const entry: ActiveRun = {
      promise: Promise.resolve(run), // replaced below
      child: null,
      cancelRequested: false,
      budgetReason: null,
      suspendRequested: false,
      memoryDirs: new Set(),
      envelope: this.resumeEnvelope(runId),
    };
    entry.promise = this.execute(run, entry)
      .catch((err: unknown) => {
        // Engine-internal failure (store error, spawn impossible). Record it; never throw
        // out of supervision — a run must always land on a terminal row. The recovery write
        // itself can throw if the store closed under a shutdown race, so it is guarded: a
        // void-dispatched supervise() must never surface an unhandled rejection.
        try {
          this.finishRun(runId, entry, "failed", { error: toErrorShape(err) });
          return this.mustGetRun(runId);
        } catch (recoveryErr) {
          console.error(`run ${runId}: failed to record terminal state`, recoveryErr);
          return run;
        }
      })
      .finally(() => this.active.delete(runId));
    this.active.set(runId, entry);
    return entry.promise;
  }

  /** Emit the `queued` lifecycle event for a freshly created run (the creator calls this once). */
  emitQueued(runId: string): void {
    const envelope = this.resumeEnvelope(runId);
    this.stampAndStore(runId, envelope, { kind: "run_status", status: "queued" });
  }

  /**
   * Cancel a run: cooperative SIGTERM, SIGKILL after the grace window. A queued/unsupervised
   * run is cancelled directly; a terminal run is a no-op.
   */
  async cancel(runId: string): Promise<void> {
    const run = this.store.getRun(runId);
    if (run === null) throw new EngineError("NOT_FOUND", `Unknown run: ${runId}`);
    if (isTerminal(run.status)) return;

    const entry = this.active.get(runId);
    if (entry === undefined) {
      // Nothing is executing it right now (queued, parked/suspended, or left over from a dead
      // engine). A suspended run has no process to signal, so finalize directly and close any
      // pending human-input gates so they can't strand.
      const envelope = this.resumeEnvelope(runId);
      if (isSuspended(run.status)) this.store.cancelPendingHumanInputRequests(runId);
      this.store.updateRunStatus(runId, "cancelled", { endedAt: this.clock.now(), wakeAt: null });
      this.stampAndStore(runId, envelope, { kind: "run_status", status: "cancelled" });
      return;
    }

    if (entry.cancelRequested) return;
    entry.cancelRequested = true;
    this.store.updateRunStatus(runId, "cancelling");
    this.stampAndStore(runId, entry.envelope, { kind: "run_status", status: "cancelling" });

    const child = entry.child;
    if (child !== null && child.exitCode === null && !child.killed) {
      child.kill("SIGTERM");
      await this.clock.sleep(this.cancelGraceMs);
      if (entry.child !== null && entry.child.exitCode === null) {
        entry.child.kill("SIGKILL");
      }
    }
    await entry.promise;
  }

  // --------------------------------------------------------------------------
  // Suspension + resume
  // --------------------------------------------------------------------------

  /**
   * Persist a durable suspension the child signaled: a pending journal entry at the seam's seq
   * plus (for a human-input gate) the request row, then flip the run to its suspended status.
   * Re-suspend (a spurious wake) reuses the existing pending request instead of creating another.
   */
  private handleSuspend(
    run: RunRow,
    entry: ActiveRun,
    msg: Extract<ChildToParent, { type: "suspend" }>,
  ): void {
    if (msg.reason === "sleep") {
      // Compute the absolute wake time with THIS clock so it agrees with the wake sweep.
      const wakeAt = this.clock.now() + (msg.durationMs ?? 0);
      this.store.transaction(() => {
        this.store.putJournalEntry({
          runId: run.id,
          seq: msg.seq,
          kind: "sleep",
          fingerprint: msg.fingerprint,
          state: "pending",
          result: { wakeAt },
        });
        this.store.updateRunStatus(run.id, "sleeping", { wakeAt });
      });
      this.stampAndStore(run.id, entry.envelope, { kind: "run_status", status: "sleeping" });
      this.stampAndStore(run.id, entry.envelope, { kind: "suspended", reason: "sleep", wakeAt });
      return;
    }
    if (msg.reason === "workflow_call") {
      // The parent parked on a still-running child. Journal the child id (pending) + flip to
      // `waiting_for_child`; the child's finalize wakes us (we re-attach + read its output).
      if (msg.childRunId === undefined) {
        throw new EngineError("INTERNAL", `workflow_call suspend missing its childRunId`);
      }
      const childRunId = msg.childRunId;
      this.store.transaction(() => {
        this.store.putJournalEntry({
          runId: run.id,
          seq: msg.seq,
          kind: "workflow_call",
          fingerprint: msg.fingerprint,
          state: "pending",
          result: { childRunId },
        });
        this.store.updateRunStatus(run.id, "waiting_for_child", { wakeAt: null });
      });
      this.stampAndStore(run.id, entry.envelope, {
        kind: "run_status",
        status: "waiting_for_child",
      });
      this.stampAndStore(run.id, entry.envelope, { kind: "suspended", reason: "child" });
      // The child may have finalized in the window before we committed `waiting_for_child` (its
      // finalize-wake then found us still running). Re-check and resume now so we can't strand.
      const child = this.store.getRun(childRunId);
      if (child !== null && isTerminal(child.status)) this.resume(run.id);
      return;
    }
    if (msg.humanInput === undefined) {
      throw new EngineError("INTERNAL", `human_input suspend missing its request payload`);
    }
    const hi = msg.humanInput;
    const inputSpec = asJsonValue(hi.inputSpec, "human_input input spec");
    // A TOOL-level gate (the model's mid-leaf `human_input`) carries the leaf's transcript
    // checkpoint — store it on a `suspended` agent journal entry so the leaf resumes where it
    // paused. A PROGRAM-level gate (the `humanInput()` hook) has no leaf to resume — its journal
    // entry is just `pending`, and the answer becomes its memoized value on resolve.
    const result = this.store.transaction(() => {
      if (msg.leafCheckpoint !== undefined) {
        this.store.putJournalEntry({
          runId: run.id,
          seq: msg.seq,
          kind: "agent",
          fingerprint: msg.fingerprint,
          state: "suspended",
          result: { checkpoint: asJsonValue(msg.leafCheckpoint, "leaf checkpoint") },
        });
      } else {
        this.store.putJournalEntry({
          runId: run.id,
          seq: msg.seq,
          kind: "human_input",
          fingerprint: msg.fingerprint,
          state: "pending",
        });
      }
      const existing = this.store.findPendingHumanInputRequest(run.id, hi.key);
      const request =
        existing ??
        this.store.createHumanInputRequest({
          runId: run.id,
          seq: msg.seq,
          key: hi.key,
          prompt: hi.prompt,
          inputSpec,
          ...(hi.assignees !== undefined ? { assignees: hi.assignees } : {}),
        });
      this.store.updateRunStatus(run.id, "awaiting_input", { wakeAt: null });
      return { request, isNew: existing === null };
    });
    // Emit BOTH the run_status transition (so status-tracking consumers see awaiting_input) and
    // the richer `suspended` marker (carrying the reason).
    this.stampAndStore(run.id, entry.envelope, { kind: "run_status", status: "awaiting_input" });
    this.stampAndStore(run.id, entry.envelope, { kind: "suspended", reason: "human_input" });
    if (result.isNew) {
      this.stampAndStore(run.id, entry.envelope, {
        kind: "human_input_requested",
        requestId: result.request.id,
        key: hi.key,
        prompt: hi.prompt,
      });
    }
  }

  /** Re-dispatch a parked run (a timed wake — long sleep / human-input timeout). Idempotent. */
  resume(runId: string): void {
    const run = this.store.getRun(runId);
    if (run === null || !isSuspended(run.status)) return;
    this.doResume(runId, this.resumeEnvelope(runId), []);
  }

  /**
   * A human answered a pending gate: emit the resolution. Re-dispatch only once EVERY gate the run
   * is waiting on is answered (whole-batch resume — a fan-out that raised N questions resumes once,
   * not N times); until then the run stays parked.
   */
  onInputResolved(runId: string, requestId: string, key: string): void {
    const run = this.store.getRun(runId);
    if (run === null || run.status !== "awaiting_input") return;
    const stillPending = this.store.listHumanInputRequests({ runId, statuses: ["pending"] });
    if (stillPending.length > 0) {
      this.stampAndStore(runId, this.resumeEnvelope(runId), {
        kind: "human_input_resolved",
        requestId,
        key,
      });
      return;
    }
    this.doResume(runId, this.resumeEnvelope(runId), [
      { kind: "human_input_resolved", requestId, key },
    ]);
  }

  private doResume(
    runId: string,
    envelope: { turn: number; seq: number },
    preEvents: readonly RunEventBody[],
  ): void {
    for (const event of preEvents) this.stampAndStore(runId, envelope, event);
    this.store.updateRunStatus(runId, "pending", { wakeAt: null });
    this.stampAndStore(runId, envelope, { kind: "resumed" });
    // execute() re-spawns the child, which replays the journal and returns the now-resolved
    // answer at the suspending seam, then continues to the next suspend point or completion.
    //
    // Race guard: a wake can land between status→awaiting_input (visible to the caller) and the
    // suspending execute() clearing its active entry. supervise() would then return that stale
    // promise and never re-dispatch, stranding the run at `pending`. If an entry is still in
    // flight, supervise AFTER it settles (its own finally deletes the entry first).
    const existing = this.active.get(runId);
    if (existing !== undefined) {
      void existing.promise.finally(() => {
        void this.supervise(runId);
      });
    } else {
      void this.supervise(runId);
    }
  }

  /**
   * Boot recovery sweep (SPEC §2.2): runs a dead engine left active are re-dispatched
   * (restart-from-the-top — the child died with the engine); interrupted cancellations are
   * finalized (the orphan child exits on IPC disconnect, so the kill already happened).
   * Engine restarts do not consume the run's crash-restart budget.
   */
  recoverOnBoot(): { resumed: string[]; cancelled: string[] } {
    const resumed: string[] = [];
    const cancelled: string[] = [];
    for (const run of this.store.listRuns({ statuses: ["cancelling"] })) {
      this.store.updateRunStatus(run.id, "cancelled", { endedAt: this.clock.now() });
      this.stampAndStore(run.id, this.resumeEnvelope(run.id), {
        kind: "run_status",
        status: "cancelled",
      });
      cancelled.push(run.id);
    }
    for (const run of this.store.listRuns({ statuses: ["queued", "pending", "running"] })) {
      resumed.push(run.id);
      void this.supervise(run.id);
    }
    // A parent parked `waiting_for_child` whose child finalized during the downtime missed its
    // finalize-wake. Resume it (it re-attaches + reads the child's memoized output). A parent whose
    // child is still in flight stays parked — that child (recovered above) wakes it on its finalize.
    for (const parent of this.store.listRuns({ statuses: ["waiting_for_child"] })) {
      const pending = this.store
        .listJournal(parent.id)
        .find((e) => e.kind === "workflow_call" && e.state === "pending");
      const childId = pending !== undefined ? readChildRunId(pending.result) : null;
      const child = childId !== null ? this.store.getRun(childId) : null;
      if (child !== null && isTerminal(child.status)) {
        resumed.push(parent.id);
        this.resume(parent.id);
      }
    }
    return { resumed, cancelled };
  }

  /** SIGTERM all children and stop. In-flight runs are recovered by the next boot's sweep. */
  shutdown(): void {
    for (const entry of this.active.values()) {
      entry.child?.kill("SIGTERM");
    }
  }

  // --------------------------------------------------------------------------
  // Execution
  // --------------------------------------------------------------------------

  private async execute(run: RunRow, entry: ActiveRun): Promise<RunRow> {
    const workflow = this.store.getWorkflowById(run.workflowId);
    if (workflow === null) {
      throw new EngineError("INTERNAL", `Run ${run.id} references a missing workflow.`);
    }
    const manifest = workflow.manifest;

    this.setStatus(run.id, entry, "pending");

    let firstStartedAt = run.startedAt;
    // Cumulative ON-CPU time across segments (the max_duration_seconds basis). Seeded from the row so
    // a resume / engine-restart continues the tally instead of granting a fresh compute budget.
    let activeMs = run.activeMs;
    // Hydrate persistent dirs only into a NEVER-started workspace: a crash-restart (and an
    // engine-restart resume) must keep the workspace as the crashed pass left it.
    let hydrated = run.startedAt !== null;
    for (;;) {
      if (entry.cancelRequested) {
        return this.finishRun(run.id, entry, "cancelled", {});
      }
      const dirs = prepareRunDir(this.dataDir, run.id, workflow.program);
      if (!hydrated) {
        hydrated = true;
        hydrateWorkspace(persistRoot(this.dataDir, workflow.id), dirs.workspaceDir);
      }
      const startedAt = firstStartedAt ?? this.clock.now();
      this.store.updateRunStatus(run.id, "running", { startedAt });
      this.stampAndStore(run.id, entry.envelope, { kind: "run_status", status: "running" });
      firstStartedAt = startedAt;

      // Two budget caps (docs/SUSPENSION.md): max_duration_seconds is ACTIVE COMPUTE (suspended idle
      // never burns it) — applied as remaining-compute from this segment's start; deadline_seconds is
      // WALL-CLOCK from the original start (idle counts). The binding deadline is the sooner of the
      // two, and which one fires drives the failure message.
      const maxComputeMs =
        manifest.budget?.max_duration_seconds !== undefined
          ? manifest.budget.max_duration_seconds * 1000
          : null;
      const deadlineMs =
        manifest.budget?.deadline_seconds !== undefined
          ? manifest.budget.deadline_seconds * 1000
          : null;
      const segmentStart = this.clock.now();
      let deadline: number | null = null;
      let budgetMessage = durationBudgetMessage(manifest);
      if (maxComputeMs !== null) {
        deadline = segmentStart + Math.max(0, maxComputeMs - activeMs);
      }
      if (deadlineMs !== null) {
        const wallDeadline = startedAt + deadlineMs;
        if (deadline === null || wallDeadline < deadline) {
          deadline = wallDeadline;
          budgetMessage = deadlineBudgetMessage(manifest);
        }
      }

      const result = await this.spawnOnce(run, entry, workflow, dirs, deadline, budgetMessage);
      // Accrue this segment's ON-CPU time (every result kind) + persist, so the tally survives a
      // suspend/resume and an engine restart (active compute, not wall-clock).
      activeMs += this.clock.now() - segmentStart;
      this.store.recordActiveMs(run.id, activeMs);

      switch (result.kind) {
        case "done": {
          if (result.outputDeclared) {
            this.stampAndStore(run.id, entry.envelope, { kind: "output", value: result.output });
          }
          // A completion racing a cancel request coerces to cancelled — `cancelling` must
          // never land on `completed` (the output event above is still preserved).
          if (entry.cancelRequested) return this.finishRun(run.id, entry, "cancelled", {});
          // Persist-back happens at SUCCESSFUL run end only (failed/cancelled runs must not
          // overwrite the durable state with a half-finished workspace). Per-agent memory
          // dirs used this run are persisted alongside the manifest's selection.
          persistWorkspace(
            persistRoot(this.dataDir, workflow.id),
            manifest.workspace?.persist,
            entry.memoryDirs,
            dirs.workspaceDir,
          );
          return this.finishRun(run.id, entry, "completed", {
            output: result.outputDeclared ? result.output : null,
          });
        }
        case "failed": {
          // A verdict output() before the throw is emitted (before the failed status) and kept
          // on the row — same as the completed path, so failed runs aren't silently output-less.
          if (result.outputDeclared) {
            this.stampAndStore(run.id, entry.envelope, { kind: "output", value: result.output });
          }
          return this.finishRun(run.id, entry, "failed", {
            error: result.error,
            ...(result.outputDeclared ? { output: result.output } : {}),
          });
        }
        case "cancelled":
          return this.finishRun(run.id, entry, "cancelled", {});
        case "suspended":
          // Parked: handleSuspend already persisted the status + a pending journal entry + the
          // wake condition. Do NOT restart or finalize — return the suspended row as-is; resume()
          // re-dispatches it when the wake condition is met (an answer, or — later — a timer).
          return this.mustGetRun(run.id);
        case "budget":
          return this.finishRun(run.id, entry, "failed", {
            error: {
              code: "BUDGET_EXCEEDED",
              message: entry.budgetReason ?? durationBudgetMessage(manifest),
            },
          });
        case "crashed": {
          const restarts = this.store.incrementRestarts(run.id);
          if (restarts > this.maxRestarts) {
            return this.finishRun(run.id, entry, "failed", {
              error: {
                code: "CRASHED",
                message: `Run process died ${String(restarts)} times; restart budget exhausted.`,
              },
            });
          }
          // Restart from the top — the documented crash semantics. Durable sub-work behind
          // workflows.call re-attaches via idempotency on the next pass.
          this.setStatus(run.id, entry, "pending");
        }
      }
    }
  }

  private spawnOnce(
    run: RunRow,
    entry: ActiveRun,
    workflow: WorkflowRow,
    dirs: RunDirs,
    deadline: number | null,
    budgetMessage: string,
  ): Promise<SpawnResult> {
    return new Promise<SpawnResult>((resolve) => {
      let settled = false;
      let budgetTimer: NodeJS.Timeout | null = null;
      const settle = (result: SpawnResult): void => {
        if (settled) return;
        settled = true;
        if (budgetTimer !== null) clearTimeout(budgetTimer);
        resolve(result);
      };

      if (deadline !== null && deadline - this.clock.now() <= 0) {
        entry.budgetReason ??= budgetMessage;
        settle({ kind: "budget" });
        return;
      }

      let child: ChildProcess;
      try {
        child = spawn(process.execPath, [this.childEntryPath], {
          cwd: dirs.workspaceDir,
          env: this.childEnv(workflow.manifest),
          stdio: ["ignore", "pipe", "pipe", "ipc"],
          serialization: "json",
        });
      } catch {
        settle({ kind: "crashed" });
        return;
      }
      entry.child = child;

      if (deadline !== null) {
        budgetTimer = setTimeout(() => {
          entry.budgetReason ??= budgetMessage;
          // Budget breach terminates immediately — enforced, not advisory.
          child.kill("SIGKILL");
        }, deadline - this.clock.now());
      }

      child.stdout?.on("data", (chunk: Buffer) => {
        this.emitBody(run.id, entry, {
          kind: "program_output",
          stream: "stdout",
          text: chunk.toString(),
        });
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        this.emitBody(run.id, entry, {
          kind: "program_output",
          stream: "stderr",
          text: chunk.toString(),
        });
      });

      child.on("message", (raw: unknown) => {
        const parsed = childToParentSchema.safeParse(raw);
        if (!parsed.success) return; // Only protocol messages are expected on this channel.
        const msg = parsed.data;
        switch (msg.type) {
          case "host_call":
            void this.handleHostCall(run, workflow, dirs, msg.method, msg.args)
              .then((value) => {
                if (child.connected) {
                  child.send({
                    type: "host_result",
                    callId: msg.callId,
                    result: { ok: true, value },
                  });
                }
              })
              .catch((err: unknown) => {
                const shape = toErrorShape(err);
                const hint = err instanceof EngineError ? err.hint : undefined;
                if (child.connected) {
                  child.send({
                    type: "host_result",
                    callId: msg.callId,
                    result: {
                      ok: false,
                      error: { ...shape, ...(hint !== undefined ? { hint } : {}) },
                    },
                  });
                }
              });
            break;
          case "emit":
            this.emitBody(run.id, entry, msg.body, msg.turnId);
            break;
          case "turn_started":
            // A new agent turn: bump the cursor stride block, then emit its opening frame —
            // naming the leaf (agentId + optional agentName) so consumers can attribute it.
            entry.envelope.turn += 1;
            entry.envelope.seq = 0;
            this.emitBody(
              run.id,
              entry,
              {
                kind: "turn_started",
                agentId: msg.agentId,
                ...(msg.agentName !== undefined ? { agentName: msg.agentName } : {}),
              },
              msg.turnId,
            );
            break;
          case "report_usage":
            this.recordUsage(run.id, entry, workflow, msg.modelRef, msg.usage);
            break;
          case "memory_used":
            // The child validated the path, but the parent persists it — re-check the shape
            // before it can ever reach a filesystem copy.
            if (MEMORY_PATH_RE.test(msg.dir) && !msg.dir.includes("\\")) {
              entry.memoryDirs.add(msg.dir);
            } else {
              console.error(`run ${run.id}: ignored malformed memory dir from child`);
            }
            break;
          case "suspend":
            // The program reached a seam that releases the process. Persist the suspension
            // (status + pending journal entry + any request), then kill the child; its exit
            // settles as "suspended" (below), so execute() neither restarts nor finalizes.
            try {
              this.handleSuspend(run, entry, msg);
              entry.suspendRequested = true;
              child.kill("SIGKILL");
            } catch (err) {
              // A malformed suspend (e.g. a corrupt spec) fails the run rather than parking it.
              settle({
                kind: "failed",
                error: toErrorShape(err),
                output: null,
                outputDeclared: false,
              });
            }
            break;
          case "done":
            // A budget breach detected mid-run (recordUsage set budgetReason) is AUTHORITATIVE even
            // if the program then ran to completion: IPC is FIFO, so the breaching report_usage was
            // handled before this `done`, and the verdict must not depend on the SIGKILL winning the
            // race against the program's natural completion. The kill is an optimization to stop work
            // early; correctness lives here.
            if (entry.budgetReason !== null) settle({ kind: "budget" });
            else settle({ kind: "done", output: msg.output, outputDeclared: msg.outputDeclared });
            break;
          case "failed":
            settle({
              kind: "failed",
              error: msg.error,
              output: msg.output,
              outputDeclared: msg.outputDeclared,
            });
            break;
        }
      });

      child.on("error", () => settle({ kind: "crashed" }));
      child.on("exit", () => {
        entry.child = null;
        if (entry.suspendRequested) settle({ kind: "suspended" });
        else if (entry.budgetReason !== null) settle({ kind: "budget" });
        else if (entry.cancelRequested) settle({ kind: "cancelled" });
        else settle({ kind: "crashed" });
      });

      const init: InitMessage = {
        type: "init",
        runId: run.id,
        programPath: dirs.programPath,
        workspaceDir: dirs.workspaceDir,
        // The deployed PACKAGE root (program + skills/ + a bundled AGENTS.md): AGENTS.md discovery
        // reads its bundled tier before the workspace tier. null ⇒ this workflow has no package.
        programDir: this.packageDirFor(workflow.id),
        skillsDir: this.skillsDirFor(workflow.id),
        input: run.input,
        config: workflow.config,
        manifest: workflow.manifest,
        // Re-runs (resume / crash-restart) replay journaled seams up to here with observability
        // suppressed; a fresh run has no journal (frontier 0) and emits everything.
        replayFrontier: this.store.maxJournalSeq(run.id),
      };
      if (child.connected) child.send(init);
    });
  }

  // --------------------------------------------------------------------------
  // Host calls (the engine side of the SDK bridge)
  // --------------------------------------------------------------------------

  /**
   * Accumulate a leaf's usage into the run row and enforce token/USD budgets — the supervisor
   * is the single budget authority, so a multi-leaf run can't out-run its caps by parallelism.
   */
  private recordUsage(
    runId: string,
    entry: ActiveRun,
    workflow: WorkflowRow,
    modelRef: string,
    usage: { inputTokens?: number | undefined; outputTokens?: number | undefined },
  ): void {
    this.store.addRunUsage(runId, {
      tokensIn: usage.inputTokens ?? 0,
      tokensOut: usage.outputTokens ?? 0,
      usdMicros: usageUsdMicros(modelRef, usage),
    });
    const budget = workflow.manifest.budget;
    if (budget === undefined) return;
    const totals = this.store.getRunUsage(runId);
    let reason: string | null = null;
    if (budget.max_tokens !== undefined && totals.tokensIn + totals.tokensOut > budget.max_tokens) {
      reason = `Run exceeded budget.max_tokens (${String(budget.max_tokens)}) and was terminated.`;
    } else if (budget.max_usd !== undefined && totals.usdMicros > budget.max_usd * 1_000_000) {
      reason = `Run exceeded budget.max_usd ($${String(budget.max_usd)}, approximate rates) and was terminated.`;
    }
    if (reason !== null && entry.budgetReason === null) {
      entry.budgetReason = reason;
      entry.child?.kill("SIGKILL");
    }
  }

  private async handleHostCall(
    run: RunRow,
    workflow: WorkflowRow,
    dirs: RunDirs,
    method: HostMethod,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    switch (method) {
      case "get_secret":
        return this.resolveSecret(workflow.manifest, getSecretArgsSchema.parse(args).name);
      case "resolve_model": {
        const a = resolveModelArgsSchema.parse(args);
        return resolveModel({
          model: a.model,
          provider: a.provider,
          config: this.inference,
          getEnv: (name) => this.env.get(name) ?? process.env[name],
        });
      }
      case "call_workflow": {
        const a = callWorkflowJournaledArgsSchema.parse(args);
        const child = this.startChildRun(run.id, a.slug, a.input, a.idempotencyKey);
        // Hold for the child's first segment. A SHORT child (one that runs straight to terminal)
        // finishes here and we return its output — cheaper than releasing + replaying this parent.
        // A LONG child (one that itself suspends — sleeps, awaits input, waits on its OWN child)
        // settles non-terminal, and THAT releases this parent too (`waiting_for_child`).
        const settled = await this.supervise(child.id);
        if (settled.status === "completed") {
          // Memoize the output so the parent's replay (and any later restart) returns it instantly.
          this.store.putJournalEntry({
            runId: run.id,
            seq: a.seq,
            kind: "workflow_call",
            fingerprint: a.fingerprint,
            state: "resolved",
            result: settled.output,
          });
          return { status: "completed", output: settled.output };
        }
        if (settled.status === "cancelled") {
          throw new EngineError("CANCELLED", `Child workflow "${a.slug}" was cancelled.`);
        }
        if (settled.status === "failed") {
          throw new EngineError(
            "PROGRAM_ERROR",
            `Child workflow "${a.slug}" failed: ${settled.error?.message ?? "unknown error"}`,
          );
        }
        // The child suspended (it is long-running): release this parent until the child finalizes.
        // The child replies io.suspend(workflow_call) → pending journal entry + `waiting_for_child`.
        return { status: "running", childRunId: child.id };
      }
      case "run_workflow": {
        const a = callWorkflowArgsSchema.parse(args);
        const child = this.startChildRun(run.id, a.slug, a.input, a.idempotencyKey);
        void this.supervise(child.id);
        return child.id;
      }
      case "mcp_token": {
        const a = mcpTokenArgsSchema.parse(args);
        return await this.resolveMcpToken(a.serverUrl, a.invalidateToken);
      }
      case "write_artifact": {
        const a = writeArtifactArgsSchema.parse(args);
        if (a.name.includes("/") || a.name.includes("\\") || a.name.includes("..")) {
          throw new EngineError(
            "VALIDATION",
            `Artifact name "${a.name}" must be a plain file name.`,
          );
        }
        const bytes = Buffer.from(a.bodyBase64, "base64");
        const path = join(dirs.artifactsDir, a.name);
        writeFileSync(path, bytes);
        const row = this.store.createArtifact({
          runId: run.id,
          name: a.name,
          contentType: a.contentType,
          path,
          size: bytes.length,
          ...(a.metadata !== undefined ? { metadata: a.metadata } : {}),
        });
        return { id: row.id, name: row.name, url: pathToFileURL(path).href };
      }
      case "read_artifact": {
        const a = readArtifactArgsSchema.parse(args);
        if (a.name.includes("/") || a.name.includes("\\") || a.name.includes("..")) {
          throw new EngineError(
            "VALIDATION",
            `Artifact name "${a.name}" must be a plain file name.`,
          );
        }
        const path = join(dirs.artifactsDir, a.name);
        if (!existsSync(path)) {
          throw new EngineError("NOT_FOUND", `No artifact named "${a.name}" in this run.`);
        }
        return { content: readFileSync(path, "utf8") };
      }
      case "web_search": {
        const a = webSearchArgsSchema.parse(args);
        const results = await runWebSearch(
          a.query,
          a.limit,
          (name) => this.env.get(name) ?? process.env[name],
        );
        return { results };
      }
      case "journal_get": {
        const a = journalGetArgsSchema.parse(args);
        const entry = this.store.getJournalEntry(run.id, a.seq);
        if (entry === null) return null;
        let result = entry.result;
        // A suspended agent leaf resumes with the person's answers joined from the request rows
        // (the single source of truth) — merged into { checkpoint, answers } for the child.
        if (entry.state === "suspended" && entry.kind === "agent") {
          const answers = this.store.resolvedAnswersForSeq(run.id, a.seq);
          const base =
            typeof entry.result === "object" &&
            entry.result !== null &&
            !Array.isArray(entry.result)
              ? entry.result
              : {};
          result = { ...base, answers };
        }
        return {
          seq: entry.seq,
          kind: entry.kind,
          fingerprint: entry.fingerprint,
          state: entry.state,
          result,
        };
      }
      case "journal_put": {
        const a = journalPutArgsSchema.parse(args);
        const row = this.store.putJournalEntry({
          runId: run.id,
          seq: a.seq,
          kind: a.kind,
          fingerprint: a.fingerprint,
          label: a.label ?? null,
          state: a.state,
          result: a.result === undefined ? null : asJsonValue(a.result, "journal result"),
        });
        return {
          seq: row.seq,
          kind: row.kind,
          fingerprint: row.fingerprint,
          state: row.state,
          result: row.result,
        };
      }
    }
  }

  /** Find-or-create the durable child run for workflows.call/run (idempotent re-attach). */
  private startChildRun(
    parentRunId: string,
    slug: string,
    input: unknown,
    idempotencyKey: string | undefined,
  ): RunRow {
    const target = this.store.getWorkflow(slug);
    if (target === null) {
      throw new EngineError(
        "NOT_FOUND",
        `workflows.call target "${slug}" is not deployed on this engine.`,
        `Deploy it first — the engine only runs workflows it knows by slug.`,
      );
    }
    // Crossed the JSON IPC channel, but narrow instead of assuming — and
    // the canonical default key requires a JSON tree anyway.
    const jsonInput = input === undefined ? null : asJsonValue(input, "workflows.call input");
    const key = idempotencyKey ?? defaultIdempotencyKey(parentRunId, slug, jsonInput);
    const { run, created } = this.store.createRun({
      workflowId: target.id,
      triggerKind: "manual",
      input: jsonInput,
      parentRunId,
      idempotencyKey: key,
    });
    if (created) this.emitQueued(run.id);
    return run;
  }

  /**
   * The engine side of MCP OAuth: hand the child a usable access token, refreshing SILENTLY
   * when the stored one is expired (clock + skew) or the child reports the server rejected it
   * (`invalidateToken` — the child retries at most once, so a second rejection lands back here
   * as a failure). When only a human could fix it, answer null + a hint naming
   * engine.authorizeMcpServer — a headless run must fail loudly, never prompt.
   */
  private async resolveMcpToken(
    serverUrl: string,
    invalidateToken: string | undefined,
  ): Promise<{ accessToken: string | null; hint?: string }> {
    const hint =
      `No usable OAuth token for this MCP server — authorize it once with ` +
      `engine.authorizeMcpServer("${serverUrl}") (boardwalk dev / the server UI expose this), ` +
      `then re-run.`;
    const entry = this.mcpTokens.get(serverUrl);
    if (entry === null) return { accessToken: null, hint };

    const invalidated = invalidateToken !== undefined && invalidateToken === entry.accessToken;
    const expired =
      entry.expiresAt !== undefined && entry.expiresAt - MCP_TOKEN_EXPIRY_SKEW_MS <= Date.now();
    if (!invalidated && !expired) return { accessToken: entry.accessToken };

    if (entry.refreshToken === undefined || entry.tokenEndpoint === undefined) {
      return { accessToken: null, hint };
    }
    try {
      const grant = await refreshAccessToken({
        tokenEndpoint: entry.tokenEndpoint,
        clientId: entry.clientId,
        refreshToken: entry.refreshToken,
        resource: entry.resource,
      });
      this.mcpTokens.set(serverUrl, {
        ...entry,
        accessToken: grant.accessToken,
        // An AS may rotate the refresh token on use (OAuth 2.1 encourages it) — keep the new one.
        ...(grant.refreshToken !== undefined ? { refreshToken: grant.refreshToken } : {}),
        ...(grant.expiresAt !== undefined ? { expiresAt: grant.expiresAt } : {}),
      });
      return { accessToken: grant.accessToken };
    } catch {
      // The entry stays: a transient AS outage must not destroy a working grant. The run
      // fails with the authorize hint; a later run retries the refresh.
      return { accessToken: null, hint };
    }
  }

  private resolveSecret(manifest: WorkflowManifest, name: string): string {
    const declared = (manifest.permissions?.secrets ?? []).some((s) => s.name === name);
    if (!declared) {
      throw new EngineError(
        "SECRET_UNDECLARED",
        `Secret "${name}" is not declared in permissions.secrets.`,
        `Add { name: "${name}" } to permissions.secrets — secret access is fail-closed everywhere.`,
      );
    }
    const value = this.env.get(name) ?? process.env[name];
    if (value === undefined || value.length === 0) {
      throw new EngineError(
        "SECRET_MISSING",
        `Secret "${name}" has no value on this engine.`,
        `Set ${name}=… in ${this.envLabel}.`,
      );
    }
    return value;
  }

  /**
   * The child's environment: the parent env plus manifest.env with whole-value
   * `${{ secrets.NAME }}` interpolation resolved (fail-closed against permissions.secrets).
   */
  private childEnv(manifest: WorkflowManifest): Record<string, string | undefined> {
    const out: Record<string, string | undefined> = { ...process.env };
    for (const [key, value] of Object.entries(manifest.env ?? {})) {
      const secretName = /^\$\{\{\s*secrets\.([A-Za-z0-9_-]+)\s*\}\}$/.exec(value)?.[1];
      out[key] = secretName === undefined ? value : this.resolveSecret(manifest, secretName);
    }
    return out;
  }

  // --------------------------------------------------------------------------
  // Events + transitions
  // --------------------------------------------------------------------------

  private setStatus(runId: string, entry: ActiveRun, status: RunStatus): void {
    this.store.updateRunStatus(runId, status);
    this.stampAndStore(runId, entry.envelope, { kind: "run_status", status });
  }

  /** Terminal transition: persist status + output/error, emit the lifecycle event, return the row. */
  private finishRun(
    runId: string,
    entry: ActiveRun,
    status: "completed" | "failed" | "cancelled",
    opts: { output?: unknown; error?: IpcErrorShape },
  ): RunRow {
    this.store.updateRunStatus(runId, status, {
      endedAt: this.clock.now(),
      ...(opts.output !== undefined
        ? { output: asJsonValue(opts.output, "The run's declared output") }
        : {}),
      ...(opts.error !== undefined
        ? { error: { code: opts.error.code, message: opts.error.message } }
        : {}),
    });
    this.stampAndStore(runId, entry.envelope, {
      kind: "run_status",
      status,
      ...(opts.error !== undefined
        ? { error: { code: opts.error.code, message: opts.error.message } }
        : {}),
    });
    const finalized = this.mustGetRun(runId);
    // A child reaching terminal wakes a parent parked on it (workflows.call child-wait release).
    this.wakeWaitingParent(finalized);
    return finalized;
  }

  /**
   * A run reached terminal: if its parent is parked `waiting_for_child` on THIS exact child
   * (its pending workflow_call journal entry names it), resume the parent — it re-attaches, reads
   * the now-memoized output, and continues. Defensive: a wake failure must never corrupt the
   * child's terminal transition (boot recovery is the backstop for a missed wake).
   */
  private wakeWaitingParent(child: RunRow): void {
    if (child.parentRunId === null) return;
    try {
      const parent = this.store.getRun(child.parentRunId);
      if (parent === null || parent.status !== "waiting_for_child") return;
      const pending = this.store
        .listJournal(parent.id)
        .find((e) => e.kind === "workflow_call" && e.state === "pending");
      if (pending === undefined) return;
      if (readChildRunId(pending.result) !== child.id) return;
      this.resume(parent.id);
    } catch (err) {
      console.error(`run ${child.parentRunId}: failed to wake waiting_for_child parent`, err);
    }
  }

  /** Stamp a child-emitted body. A malformed body is dropped with a diagnostic, never fatal. */
  private emitBody(
    runId: string,
    entry: ActiveRun,
    body: RunEventBody | ({ kind: string } & Record<string, unknown>),
    turnId?: string,
  ): void {
    try {
      this.stampAndStore(runId, entry.envelope, body, turnId);
    } catch {
      // A malformed body from the child is a protocol bug, not a reason to kill the run.
      // runEventSchema.parse inside stampAndStore is what threw.
      console.error(`run ${runId}: dropped malformed child event (kind=${body.kind})`);
    }
  }

  /**
   * The single envelope-stamping path: allocate cursor, validate, persist, fan out. The body
   * is typed loosely because child-emitted bodies are untrusted — runEventSchema.parse below
   * is the validation, not the type. Run-level frames carry the run id as turnId; agent-leaf
   * frames carry their turn's id.
   */
  private stampAndStore(
    runId: string,
    envelope: { turn: number; seq: number },
    body: RunEventBody | ({ kind: string } & Record<string, unknown>),
    turnId?: string,
  ): void {
    envelope.seq += 1;
    const cursor = makeCursor(envelope.turn, envelope.seq);
    const event: RunEvent = runEventSchema.parse({
      ...body,
      runId,
      turnId: turnId ?? runId,
      seq: envelope.seq,
      t: this.clock.now(),
    });
    this.store.appendEvents(runId, [{ cursor, event }]);
    const row: EventRow = { runId, cursor, event };
    for (const listener of this.listeners) listener(row);
  }

  /** Resume the envelope past everything already persisted (crash/boot safe). */
  private resumeEnvelope(runId: string): { turn: number; seq: number } {
    const max = this.store.maxCursor(runId);
    return max === 0
      ? { turn: 0, seq: 0 }
      : { turn: Math.floor(max / TURN_CURSOR_STRIDE) + 1, seq: 0 };
  }

  private mustGetRun(runId: string): RunRow {
    const run = this.store.getRun(runId);
    if (run === null) throw new EngineError("INTERNAL", `Run ${runId} vanished from the store.`);
    return run;
  }

  /** The workflow's deployed package root (skills + bundled AGENTS.md), or null when none exists. */
  private packageDirFor(workflowId: string): string | null {
    const dir = packageRoot(this.dataDir, workflowId);
    return existsSync(dir) ? dir : null;
  }

  /** Deployed skills live at <packageRoot>/skills/<name>.md (written at deploy). */
  private skillsDirFor(workflowId: string): string | null {
    const dir = skillsDirOf(packageRoot(this.dataDir, workflowId));
    return existsSync(dir) ? dir : null;
  }
}

function durationBudgetMessage(manifest: WorkflowManifest): string {
  const seconds = manifest.budget?.max_duration_seconds;
  return `Run exceeded budget.max_duration_seconds (${String(seconds)}s of active compute) and was terminated.`;
}

function deadlineBudgetMessage(manifest: WorkflowManifest): string {
  const seconds = manifest.budget?.deadline_seconds;
  return `Run exceeded budget.deadline_seconds (${String(seconds)}s wall-clock) and was terminated.`;
}

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
import { existsSync, writeFileSync } from "node:fs";
import {
  makeCursor,
  runEventSchema,
  TURN_CURSOR_STRIDE,
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
  childToParentSchema,
  getSecretArgsSchema,
  mcpTokenArgsSchema,
  resolveModelArgsSchema,
  writeArtifactArgsSchema,
  type HostMethod,
  type InitMessage,
  type IpcErrorShape,
  type RunEventBody,
} from "./ipc.js";
import {
  hydrateWorkspace,
  persistRoot,
  persistWorkspace,
  prepareRunDir,
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
  | { kind: "budget" };

interface ActiveRun {
  promise: Promise<RunRow>;
  child: ChildProcess | null;
  cancelRequested: boolean;
  /** Set when a budget kill is in flight — names which budget, for the failure message. */
  budgetReason: string | null;
  /** Memory dirs agent() calls used this run — auto-persisted at successful run end. */
  memoryDirs: Set<string>;
  envelope: { turn: number; seq: number };
}

const TERMINAL_STATUSES: readonly RunStatus[] = ["completed", "failed", "cancelled"];

/** Treat an MCP access token expiring this soon as already expired — a token that dies
 *  between the broker reply and the server call would burn the child's whole 401 retry. */
const MCP_TOKEN_EXPIRY_SKEW_MS = 30_000;

/** True when a run can no longer change state. */
export function isTerminal(status: RunStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
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
      // Nothing is executing it right now (queued, or left over from a dead engine).
      const envelope = this.resumeEnvelope(runId);
      this.store.updateRunStatus(runId, "cancelled", { endedAt: this.clock.now() });
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

      const maxSeconds = manifest.budget?.max_duration_seconds;
      const deadline = maxSeconds === undefined ? null : startedAt + maxSeconds * 1000;

      const result = await this.spawnOnce(run, entry, workflow, dirs, deadline);

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
        case "budget":
          return this.finishRun(run.id, entry, "failed", {
            error: {
              code: "BUDGET_EXCEEDED",
              message:
                entry.budgetReason ??
                `Run exceeded budget.max_duration_seconds (${String(maxSeconds)}s) and was terminated.`,
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
        entry.budgetReason ??= durationBudgetMessage(workflow.manifest);
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
          entry.budgetReason ??= durationBudgetMessage(workflow.manifest);
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
          case "done":
            settle({ kind: "done", output: msg.output, outputDeclared: msg.outputDeclared });
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
        if (entry.budgetReason !== null) settle({ kind: "budget" });
        else if (entry.cancelRequested) settle({ kind: "cancelled" });
        else settle({ kind: "crashed" });
      });

      const init: InitMessage = {
        type: "init",
        runId: run.id,
        programPath: dirs.programPath,
        workspaceDir: dirs.workspaceDir,
        skillsDir: this.skillsDirFor(workflow.id),
        input: run.input,
        config: workflow.config,
        manifest: workflow.manifest,
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
        const a = callWorkflowArgsSchema.parse(args);
        const child = this.startChildRun(run.id, a.slug, a.input, a.idempotencyKey);
        const terminal = await this.supervise(child.id);
        if (terminal.status === "completed") return terminal.output;
        if (terminal.status === "cancelled") {
          throw new EngineError("CANCELLED", `Child workflow "${a.slug}" was cancelled.`);
        }
        throw new EngineError(
          "PROGRAM_ERROR",
          `Child workflow "${a.slug}" failed: ${terminal.error?.message ?? "unknown error"}`,
        );
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
        `Deploy it first — the engine only runs workflows it knows by name.`,
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
    const declared = (manifest.secrets ?? []).some((s) => s.name === name);
    if (!declared) {
      throw new EngineError(
        "SECRET_UNDECLARED",
        `Secret "${name}" is not declared in meta.secrets.`,
        `Add { name: "${name}" } to meta.secrets — secret access is fail-closed everywhere.`,
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
   * `${{ secrets.NAME }}` interpolation resolved (fail-closed against meta.secrets).
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
    return this.mustGetRun(runId);
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

  /** Deployed skills live at <dataDir>/skills/<workflowId>/<name>.md (written at deploy). */
  private skillsDirFor(workflowId: string): string | null {
    const dir = join(this.dataDir, "skills", workflowId);
    return existsSync(dir) ? dir : null;
  }
}

function durationBudgetMessage(manifest: WorkflowManifest): string {
  const seconds = manifest.budget?.max_duration_seconds;
  return `Run exceeded budget.max_duration_seconds (${String(seconds)}s) and was terminated.`;
}

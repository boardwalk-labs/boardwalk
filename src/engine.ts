// SPDX-License-Identifier: Apache-2.0

// The engine facade — the one object both consumers construct (SPEC §1):
//   - SERVER mode: `start()` boots the recovery sweep + the cron scheduler loop and the
//     process stays up (the HTTP surface sits on top of this object).
//   - EMBEDDED mode: construct, `runOnce()`, `close()` — what `boardwalk dev` does. No
//     scheduler loop, no recovery thread; one run, in-process supervision, exit.
//
// Layering: this file only wires store + supervisor + scheduler together and translates
// program source → manifest at the deploy boundary. No business logic lives here.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonValue, WorkflowManifest } from "@boardwalk-labs/workflow";
import { extractManifest } from "@boardwalk-labs/workflow/extract";
import type { InferenceConfig } from "./agent/resolve.js";
import type { Clock } from "./clock.js";
import { EngineError } from "./errors.js";
import { runAuthorizationFlow } from "./mcp/oauth.js";
import { McpTokenStore, MCP_TOKENS_FILENAME } from "./mcp/token_store.js";
import { Scheduler } from "./scheduler/scheduler.js";
import {
  Store,
  type EventRow,
  type HumanInputRequestRow,
  type HumanInputStatus,
  type RunRow,
  type TriggerKind,
  type WorkflowRow,
} from "./store/store.js";
import { isTerminal, RunSupervisor } from "./run/supervisor.js";
import { validateHumanInputResponse } from "./run/human_input.js";
import { writePackage } from "./run/run_dir.js";

export interface EngineOptions {
  /** Everything lives under here: `engine.db`, `runs/<id>/`. Created if missing. */
  dataDir: string;
  /** The local secret/env source (parsed .env contents). process.env is the fallback. */
  env?: Record<string, string>;
  /** Where secrets come from, for error hints (e.g. the .env path). Never values. */
  envLabel?: string;
  /** Default model + provider table for agent() leaves. */
  inference?: InferenceConfig;
  clock?: Clock;
  /** Engine diagnostics (scheduler notices). Default: stderr. */
  log?: (line: string) => void;
  /** Crash restarts per run. Default 2. */
  maxRestarts?: number;
  /** Cooperative-cancellation window before SIGKILL. Default 10s. */
  cancelGraceMs?: number;
  /** Override the spawned run-process entry (tests point this at a built dist). */
  childEntryPath?: string;
  /** Scheduler loop cadence. Default 1s. */
  tickIntervalMs?: number;
}

export interface AuthorizeMcpServerOptions {
  /**
   * Receives the authorization URL a HUMAN must open in a browser. The engine never opens a
   * browser itself — the consumer (CLI prints it, a UI links it) owns that interaction.
   */
  onAuthorizationUrl: (url: string) => void;
  /** How long to wait for the human to complete authorization. Default 5 minutes. */
  timeoutMs?: number;
}

export interface DeployArgs {
  /** The bundled workflow program (ESM, `@boardwalk-labs/workflow` external, pure-literal meta). */
  program: string;
  /** Engine-side deploy config (e.g. catch_up). Replaced wholesale on redeploy. */
  config?: Record<string, JsonValue>;
  /**
   * Absolute path to the project's `skills/` directory, deployed alongside the program (the CLI
   * passes the package's skills/ dir). Copied WHOLESALE into the workflow package as
   * skills/<name>/SKILL.md (+ bundled resources); replaced wholesale on redeploy. Skills are
   * per-agent (no manifest field) — an agent() naming an undeployed skill fails at call time.
   */
  skillsSourceDir?: string;
  /**
   * The workflow's BUNDLED AGENTS.md — the author's standing project instructions, shipped in the
   * package alongside the program (the CLI ships the project's root AGENTS.md this way). Read by
   * EVERY agent() in the workflow, before any AGENTS.md the run cloned into its workspace. Replaced
   * wholesale on redeploy; omitted ⇒ the workflow ships no bundled instructions.
   */
  agentsMd?: string;
}

export class Engine {
  readonly store: Store;
  private readonly dataDir: string;
  private readonly supervisor: RunSupervisor;
  private readonly scheduler: Scheduler;
  private started = false;
  private closed = false;

  constructor(opts: EngineOptions) {
    mkdirSync(opts.dataDir, { recursive: true });
    this.dataDir = opts.dataDir;
    this.store = new Store(join(opts.dataDir, "engine.db"));
    this.supervisor = new RunSupervisor({
      store: this.store,
      dataDir: opts.dataDir,
      childEntryPath: opts.childEntryPath ?? defaultChildEntryPath(),
      env: new Map(Object.entries(opts.env ?? {})),
      envLabel: opts.envLabel ?? "the engine environment",
      ...(opts.clock !== undefined ? { clock: opts.clock } : {}),
      ...(opts.maxRestarts !== undefined ? { maxRestarts: opts.maxRestarts } : {}),
      ...(opts.cancelGraceMs !== undefined ? { cancelGraceMs: opts.cancelGraceMs } : {}),
      ...(opts.inference !== undefined ? { inference: opts.inference } : {}),
    });
    this.scheduler = new Scheduler({
      store: this.store,
      dispatch: (runId) => void this.supervisor.supervise(runId),
      emitQueued: (runId) => this.supervisor.emitQueued(runId),
      ...(opts.clock !== undefined ? { clock: opts.clock } : {}),
      ...(opts.log !== undefined ? { log: opts.log } : {}),
      ...(opts.tickIntervalMs !== undefined ? { tickIntervalMs: opts.tickIntervalMs } : {}),
    });
  }

  /**
   * Server-mode boot: finalize/restart whatever a dead engine left behind, then run the cron
   * loop. Embedded consumers never call this.
   */
  start(): { resumed: string[]; cancelled: string[] } {
    this.assertOpen();
    if (this.started) return { resumed: [], cancelled: [] };
    this.started = true;
    const swept = this.supervisor.recoverOnBoot();
    this.scheduler.start();
    return swept;
  }

  /** Stop scheduling, signal children (next boot's sweep recovers them), release the DB. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.scheduler.stop();
    this.supervisor.shutdown();
    this.store.close();
  }

  /** Subscribe to every stamped run event (feeds SSE, the CLI renderer, the log UI). */
  onEvent(listener: (row: EventRow) => void): () => void {
    return this.supervisor.onEvent(listener);
  }

  /**
   * Deploy (or redeploy, by manifest slug) a workflow from its bundled program source. The
   * manifest is DERIVED from the program's pure-literal `meta` — the program file is the
   * author's source of truth, manifest drift is impossible by construction.
   */
  deployWorkflow(args: DeployArgs): WorkflowRow {
    this.assertOpen();
    const manifest: WorkflowManifest = extractManifest(args.program, { fileName: "index.mjs" });
    const workflow = this.store.upsertWorkflow({
      slug: manifest.slug,
      manifest,
      program: args.program,
      ...(args.config !== undefined ? { config: args.config } : {}),
    });
    // Skills + the bundled AGENTS.md are deploy artifacts in the workflow PACKAGE, replaced
    // wholesale: stale files from a previous deploy must not survive a redeploy that dropped them.
    // (Skills are per-agent — no manifest field — so an agent() selecting an undeployed skill fails
    // at call time, not here. The bundled AGENTS.md is default-on, read by every agent().)
    writePackage(this.dataDir, workflow.id, {
      ...(args.skillsSourceDir !== undefined ? { skillsSourceDir: args.skillsSourceDir } : {}),
      ...(args.agentsMd !== undefined ? { agentsMd: args.agentsMd } : {}),
    });
    return workflow;
  }

  /**
   * Queue a run and dispatch it through the concurrency gate. Returns the queued row
   * immediately; `waitForRun` for the terminal row.
   */
  startRun(slug: string, opts: { input?: JsonValue; triggerKind?: TriggerKind } = {}): RunRow {
    this.assertOpen();
    const workflow = this.store.getWorkflow(slug);
    if (workflow === null) {
      throw new EngineError("NOT_FOUND", `Workflow "${slug}" is not deployed on this engine.`);
    }
    const { run } = this.store.createRun({
      workflowId: workflow.id,
      triggerKind: opts.triggerKind ?? "manual",
      ...(opts.input !== undefined ? { input: opts.input } : {}),
    });
    this.supervisor.emitQueued(run.id);
    // Why a synchronous tick: run-now should not wait for the next loop iteration, and manual
    // runs go through the same dispatch gate as cron fires so concurrency modes hold uniformly.
    this.scheduler.tick();
    return run;
  }

  /**
   * One scheduler pass (fire due crons, dispatch queued runs through the concurrency gate).
   * The background loop calls this every tick; expose it so embedders and tests can drive
   * dispatch deterministically without the loop.
   */
  tick(): void {
    this.assertOpen();
    this.scheduler.tick();
  }

  /** Resolve when the run reaches a terminal status (idempotent; safe to call repeatedly). */
  waitForRun(runId: string): Promise<RunRow> {
    this.assertOpen();
    const run = this.store.getRun(runId);
    if (run === null) throw new EngineError("NOT_FOUND", `Unknown run: ${runId}`);
    if (isTerminal(run.status)) return Promise.resolve(run);
    return this.supervisor.supervise(runId);
  }

  cancelRun(runId: string): Promise<void> {
    this.assertOpen();
    return this.supervisor.cancel(runId);
  }

  /** Pending (or filtered) human-input gates — the inbox a responder picks from. */
  listInputRequests(
    filter: { runId?: string; statuses?: readonly HumanInputStatus[] } = {},
  ): HumanInputRequestRow[] {
    this.assertOpen();
    return this.store.listHumanInputRequests(filter);
  }

  /**
   * Answer a run's pending human-input gate, validating the response against its input spec, then
   * resume the run. Atomic: the first responder wins (a second gets CONFLICT). Throws NOT_FOUND
   * when no pending gate matches `key`, VALIDATION when the response doesn't fit the spec.
   */
  respondToInput(
    runId: string,
    key: string,
    value: unknown,
    opts: { respondedBy?: string } = {},
  ): HumanInputRequestRow {
    this.assertOpen();
    if (this.store.getRun(runId) === null) {
      throw new EngineError("NOT_FOUND", `Unknown run: ${runId}`);
    }
    const request = this.store.findPendingHumanInputRequest(runId, key);
    if (request === null) {
      throw new EngineError(
        "NOT_FOUND",
        `No pending human-input request "${key}" for run ${runId}.`,
      );
    }
    const validated = validateHumanInputResponse(request.inputSpec, value);
    const resolved = this.store.transaction(() => {
      const r = this.store.resolveHumanInputRequest(
        request.id,
        validated,
        opts.respondedBy ?? null,
      );
      if (r === null) return null;
      this.store.resolveJournalEntry(runId, request.seq, validated);
      return r;
    });
    if (resolved === null) {
      throw new EngineError("CONFLICT", `Human-input request "${key}" was already answered.`);
    }
    this.supervisor.onInputResolved(runId, request.id, key);
    return resolved;
  }

  /**
   * The ONE-TIME interactive step for an OAuth-protected MCP server: discovery (RFC 9728 +
   * 8414), dynamic client registration (RFC 7591), and the authorization-code + PKCE grant
   * over a loopback redirect. Tokens land in `<dataDir>/mcp_tokens.json` (0600); after this,
   * runs use the server headlessly (the engine refreshes silently). A headless run that needs
   * authorization never prompts — it fails with a hint naming this method.
   */
  async authorizeMcpServer(serverUrl: string, opts: AuthorizeMcpServerOptions): Promise<void> {
    this.assertOpen();
    await runAuthorizationFlow({
      serverUrl,
      store: new McpTokenStore(join(this.dataDir, MCP_TOKENS_FILENAME)),
      onAuthorizationUrl: opts.onAuthorizationUrl,
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    });
  }

  /**
   * Embedded one-shot (the `boardwalk dev` path): deploy, run, await terminal. The workflow
   * persists in the data dir like any other — dev reuses a throwaway dir per invocation.
   */
  async runOnce(args: DeployArgs & { input?: JsonValue }): Promise<RunRow> {
    const workflow = this.deployWorkflow(args);
    const run = this.startRun(workflow.slug, {
      ...(args.input !== undefined ? { input: args.input } : {}),
    });
    return await this.waitForRun(run.id);
  }

  private assertOpen(): void {
    if (this.closed) throw new EngineError("INTERNAL", "This engine has been closed.");
  }
}

/** The compiled child entry that ships next to this module in dist/. */
function defaultChildEntryPath(): string {
  return fileURLToPath(new URL("./run/child.js", import.meta.url));
}

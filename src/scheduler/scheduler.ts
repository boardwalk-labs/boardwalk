// SPDX-License-Identifier: Apache-2.0

// The cron scheduler (SPEC §2.1). Layering: it fires runs; it knows nothing about what a
// workflow does. Execution is injected (`dispatch`) so this module never
// touches processes, and time is injected (`Clock`) so tests drive it deterministically.
//
// Correctness rules implemented here:
//   - A due fire happens exactly once: the fire record and the run row are written in ONE
//     store transaction, keyed (workflow, trigger index, fire time) — a crash between tick
//     and dispatch leaves a queued run the boot sweep picks up, never a duplicate.
//   - Catch-up on restart: missed fires are detected from the persisted fire history and
//     SKIPPED with a logged notice by default; deploy config `catch_up: "once"` runs a single
//     run for any number of missed fires (the manifest has no catch_up field — this is
//     engine-operational policy, so it lives in the engine's deploy-time config).
//     Never silent, never a thundering herd.
//   - Concurrency modes gate DISPATCH, not queueing: `serial` (with or without a key) holds
//     queued runs until the group's active run reaches a terminal status.

import type { CronTrigger, WorkflowManifest } from "@boardwalk-labs/workflow";
import { systemClock, type Clock } from "../clock.js";
import { nextFire, parseCron, type CronSchedule } from "../cron/cron.js";
import type { RunRow, Store, WorkflowRow } from "../store/store.js";

export interface SchedulerOptions {
  store: Store;
  /** Start executing a queued run (the engine wires supervisor.supervise here). */
  dispatch: (runId: string) => void;
  /** Emit the `queued` lifecycle event for a run this scheduler created. */
  emitQueued: (runId: string) => void;
  clock?: Clock;
  /** Engine diagnostics (catch-up notices, tick overruns). Default: console.error. */
  log?: (line: string) => void;
  /** Tick cadence of the background loop. Default 1s. */
  tickIntervalMs?: number;
  /** Ticks slower than this are logged. Default 250ms. */
  tickBudgetMs?: number;
}

/** How many missed fires we enumerate before giving up counting (the notice says "≥"). */
const MISSED_SCAN_CAP = 10_000;

// Held statuses count as active: a run waiting on a person or a child run still occupies its
// process, so a `serial` workflow must not dispatch a second run beside it.
const ACTIVE_STATUSES = [
  "pending",
  "running",
  "cancelling",
  "awaiting_input",
  "waiting_for_child",
] as const;

export class Scheduler {
  private readonly store: Store;
  private readonly dispatch: (runId: string) => void;
  private readonly emitQueued: (runId: string) => void;
  private readonly clock: Clock;
  private readonly log: (line: string) => void;
  private readonly tickIntervalMs: number;
  private readonly tickBudgetMs: number;

  /** Per (workflow, trigger) fire anchor: the last fire time we are PAST (epoch ms). */
  private readonly anchors = new Map<string, number>();
  private readonly scheduleCache = new Map<string, CronSchedule>();
  /** Runs handed to `dispatch` that haven't left `queued` yet — prevents re-dispatch spam. */
  private readonly handedOut = new Set<string>();
  private stopController: AbortController | null = null;

  constructor(opts: SchedulerOptions) {
    this.store = opts.store;
    this.dispatch = opts.dispatch;
    this.emitQueued = opts.emitQueued;
    this.clock = opts.clock ?? systemClock;
    this.log = opts.log ?? ((line: string): void => console.error(line));
    this.tickIntervalMs = opts.tickIntervalMs ?? 1000;
    this.tickBudgetMs = opts.tickBudgetMs ?? 250;
  }

  /** Start the background loop. Idempotent; `stop()` to end it. */
  start(): void {
    if (this.stopController !== null) return;
    const controller = new AbortController();
    this.stopController = controller;
    void this.loop(controller.signal);
  }

  stop(): void {
    this.stopController?.abort();
    this.stopController = null;
  }

  private async loop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      this.tick();
      try {
        await this.clock.sleep(this.tickIntervalMs, signal);
      } catch {
        return; // aborted — clean stop
      }
    }
  }

  /**
   * One scheduler pass: fire every due cron trigger, then dispatch queued runs through the
   * concurrency gate. Public so tests (and the engine's boot path) can drive it directly.
   */
  tick(): void {
    const started = this.clock.now();
    for (const workflow of this.store.listWorkflows()) {
      this.fireDueTriggers(workflow);
    }
    this.dispatchQueued();
    const elapsed = this.clock.now() - started;
    if (elapsed > this.tickBudgetMs) {
      this.log(
        `[scheduler] tick took ${String(elapsed)}ms (budget ${String(this.tickBudgetMs)}ms)`,
      );
    }
  }

  // --------------------------------------------------------------------------
  // Firing
  // --------------------------------------------------------------------------

  private fireDueTriggers(workflow: WorkflowRow): void {
    const now = this.clock.now();
    workflow.manifest.triggers.forEach((trigger, index) => {
      if (trigger.kind !== "cron") return;
      const schedule = this.schedule(trigger.expr, trigger.timezone);
      let anchor = this.ensureAnchor(workflow, index, trigger, schedule, now);
      let due = nextFire(schedule, anchor, trigger.timezone);
      while (due !== null && due <= now) {
        this.fireOnce(workflow, index, trigger, due);
        anchor = due;
        due = nextFire(schedule, anchor, trigger.timezone);
      }
      this.anchors.set(anchorKey(workflow.id, index), anchor);
    });
  }

  /** Create the run + the fire record atomically; a duplicate fire is impossible by schema. */
  private fireOnce(
    workflow: WorkflowRow,
    triggerIndex: number,
    trigger: CronTrigger,
    fireTime: number,
  ): void {
    const runId = this.store.transaction(() => {
      const { run } = this.store.createRun({
        workflowId: workflow.id,
        triggerKind: "cron",
        // The scheduler is the one surface that knows WHICH rule fired — record it so
        // `context.actor` and `trigger.source` are exact.
        actor: { type: "cron", rule: trigger.expr },
        // The trigger's static input (validated as data by the manifest schema; this engine
        // derives no input schema to check it against — the untyped floor).
        ...(trigger.input !== undefined ? { input: trigger.input } : {}),
      });
      this.store.recordCronFire({ workflowId: workflow.id, triggerIndex, fireTime, runId: run.id });
      return run.id;
    });
    this.emitQueued(runId);
  }

  /**
   * The anchor for a trigger, establishing the catch-up policy on first sight: a trigger with
   * fire history starts from its last recorded fire — missed fires in between are counted and
   * either skipped (default, with a notice) or coalesced into ONE immediate run
   * (`catch_up: "once"`). A trigger never seen before starts from now (no retroactive fires).
   */
  private ensureAnchor(
    workflow: WorkflowRow,
    triggerIndex: number,
    trigger: CronTrigger,
    schedule: CronSchedule,
    now: number,
  ): number {
    const timezone = trigger.timezone;
    const key = anchorKey(workflow.id, triggerIndex);
    const existing = this.anchors.get(key);
    if (existing !== undefined) return existing;

    const lastFire = this.store.lastCronFire(workflow.id, triggerIndex);
    if (lastFire === null) {
      this.anchors.set(key, now);
      return now;
    }

    // Count what was missed while no engine was running.
    let missedCount = 0;
    let latestMissed: number | null = null;
    let cursor = lastFire;
    while (missedCount < MISSED_SCAN_CAP) {
      const next = nextFire(schedule, cursor, timezone);
      if (next === null || next > now) break;
      missedCount += 1;
      latestMissed = next;
      cursor = next;
    }

    let anchor = lastFire;
    if (latestMissed !== null) {
      anchor = latestMissed;
      const mode = catchUpMode(workflow);
      const counted =
        missedCount >= MISSED_SCAN_CAP ? `≥${String(missedCount)}` : String(missedCount);
      if (mode === "once") {
        this.fireOnce(workflow, triggerIndex, trigger, latestMissed);
        this.log(
          `[scheduler] ${workflow.slug}: ${counted} missed cron fire(s) while the engine was down; ran once (catch_up: "once").`,
        );
      } else {
        this.log(
          `[scheduler] ${workflow.slug}: skipped ${counted} missed cron fire(s) while the engine was down (catch_up: "skip").`,
        );
      }
    }
    this.anchors.set(key, anchor);
    return anchor;
  }

  // --------------------------------------------------------------------------
  // Dispatch (the concurrency gate)
  // --------------------------------------------------------------------------

  private dispatchQueued(): void {
    const queued = this.store.listRuns({ statuses: ["queued"] });
    // Prune the handed-out set: anything no longer queued has been picked up (or finished).
    const queuedIds = new Set(queued.map((r) => r.id));
    for (const id of this.handedOut) {
      if (!queuedIds.has(id)) this.handedOut.delete(id);
    }
    // Oldest first — listRuns returns newest first.
    queued.reverse();
    const groupsDispatchedNow = new Set<string>();
    for (const run of queued) {
      if (this.handedOut.has(run.id)) continue;
      const workflow = this.store.getWorkflowById(run.workflowId);
      if (workflow === null) continue;
      const group = concurrencyGroup(workflow);
      if (group !== null) {
        if (groupsDispatchedNow.has(group)) continue;
        if (this.groupHasActiveRun(workflow, run)) continue;
        groupsDispatchedNow.add(group);
      }
      this.handedOut.add(run.id);
      this.dispatch(run.id);
    }
  }

  private groupHasActiveRun(workflow: WorkflowRow, _candidate: RunRow): boolean {
    // serial_by_key's key is a static manifest string (SDK schema), so within one workflow it
    // gates exactly like serial: any active run of the workflow blocks dispatch.
    return this.store.listRuns({ workflowId: workflow.id, statuses: ACTIVE_STATUSES }).length > 0;
  }

  private schedule(expr: string, timezone: string | undefined): CronSchedule {
    const key = `${expr} ${timezone ?? ""}`;
    let parsed = this.scheduleCache.get(key);
    if (parsed === undefined) {
      parsed = parseCron(expr);
      this.scheduleCache.set(key, parsed);
    }
    return parsed;
  }
}

function anchorKey(workflowId: string, triggerIndex: number): string {
  return `${workflowId}#${String(triggerIndex)}`;
}

function catchUpMode(workflow: WorkflowRow): "skip" | "once" {
  return workflow.config.catch_up === "once" ? "once" : "skip";
}

/** The dispatch-gate group for a workflow, or null for unlimited concurrency. */
function concurrencyGroup(workflow: WorkflowRow): string | null {
  const concurrency: WorkflowManifest["concurrency"] = workflow.manifest.concurrency;
  if (concurrency.mode === "unlimited") return null;
  // `serial` — with or without a key. The key is a RUNTIME-INTERPOLATED template over the
  // run's input, resolved at run creation on the hosted control plane; this engine does not
  // resolve it yet and serializes the workflow GLOBALLY instead (fail-safe: you asked for
  // per-key serialization, so the ambiguity must never mean MORE concurrency than one).
  return workflow.id;
}

// SPDX-License-Identifier: Apache-2.0

// The JSON API (SPEC §2.4): list workflows/runs, trigger a manual run, read a run + its
// events, cancel. Handlers translate HTTP into engine/store calls and nothing else — all SQL
// lives in the store, all run semantics in the engine.

import { z } from "zod";
import { matchesChannels } from "@boardwalk-labs/workflow";
import type { RunStatus } from "../../store/store.js";
import {
  HttpError,
  MAX_BODY_BYTES,
  jsonValueSchema,
  parseChannelSelection,
  parseJsonBody,
  parseNonNegativeInt,
  readBody,
  sendJson,
} from "../http.js";
import type { RouteContext } from "./router.js";

/**
 * Default page size for run listings. Unbounded-by-default would make the run-log UI's
 * "recent runs" fetch grow forever; callers page with limit/offset for more.
 */
const DEFAULT_RUNS_LIMIT = 100;

const startRunBodySchema = z.strictObject({ input: jsonValueSchema.optional() });

// Why a Record and not an array: the Record<RunStatus, true> shape makes the value list
// provably complete — a status added to the union without a flag here is a compile error, so
// the filter can never reject a status the store legitimately writes.
const RUN_STATUS_FLAGS: Record<RunStatus, true> = {
  queued: true,
  pending: true,
  running: true,
  completed: true,
  failed: true,
  cancelled: true,
  cancelling: true,
};

function isRunStatus(value: string): value is RunStatus {
  return Object.hasOwn(RUN_STATUS_FLAGS, value);
}

/** GET /api/workflows — names + manifest-derived fields, enough to render a picker. */
export function handleListWorkflows(ctx: RouteContext): void {
  const workflows = ctx.engine.store.listWorkflows().map((row) => ({
    name: row.name,
    description: row.manifest.description ?? null,
    triggers: row.manifest.triggers,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
  sendJson(ctx.res, 200, { workflows });
}

/** GET /api/runs?workflow=&status=&limit=&offset= — newest first, full RunRow shape. */
export function handleListRuns(ctx: RouteContext): void {
  const filter: {
    workflowId?: string;
    statuses?: readonly RunStatus[];
    limit: number;
    offset: number;
  } = {
    limit: parseNonNegativeInt(ctx.url, "limit", DEFAULT_RUNS_LIMIT),
    offset: parseNonNegativeInt(ctx.url, "offset", 0),
  };
  const workflowName = ctx.url.searchParams.get("workflow");
  if (workflowName !== null) {
    const workflow = ctx.engine.store.getWorkflow(workflowName);
    if (workflow === null) {
      throw new HttpError(
        404,
        "NOT_FOUND",
        `Workflow "${workflowName}" is not deployed on this engine.`,
      );
    }
    filter.workflowId = workflow.id;
  }
  const status = ctx.url.searchParams.get("status");
  if (status !== null) {
    if (!isRunStatus(status)) {
      throw new HttpError(
        400,
        "VALIDATION",
        `Unknown run status "${status}".`,
        `Valid statuses: ${Object.keys(RUN_STATUS_FLAGS).join(", ")}.`,
      );
    }
    filter.statuses = [status];
  }
  sendJson(ctx.res, 200, { runs: ctx.engine.store.listRuns(filter) });
}

/** POST /api/workflows/:name/runs — start a manual run; 201 with the queued row. */
export async function handleStartRun(ctx: RouteContext, workflowName: string): Promise<void> {
  const raw = await readBody(ctx.req, MAX_BODY_BYTES);
  // An empty body means "no input" — the curl-without-data ergonomics of a run-now button.
  const body = raw.length === 0 ? {} : parseJsonBody(raw, startRunBodySchema, "run-start body");
  const run = ctx.engine.startRun(workflowName, {
    triggerKind: "manual",
    ...(body.input !== undefined ? { input: body.input } : {}),
  });
  sendJson(ctx.res, 201, { run });
}

/** GET /api/runs/:id */
export function handleGetRun(ctx: RouteContext, runId: string): void {
  const run = ctx.engine.store.getRun(runId);
  if (run === null) throw new HttpError(404, "NOT_FOUND", `Unknown run: ${runId}`);
  sendJson(ctx.res, 200, { run });
}

/**
 * GET /api/runs/:id/events?after=&channels=|verbose= — persisted events after a cursor,
 * filtered server-side by channel. Cursors are run-global and untouched by filtering, so a
 * client can resume here (or on /stream) with any channel set.
 */
export function handleListEvents(ctx: RouteContext, runId: string): void {
  if (ctx.engine.store.getRun(runId) === null) {
    throw new HttpError(404, "NOT_FOUND", `Unknown run: ${runId}`);
  }
  const channels = parseChannelSelection(ctx.url);
  const afterCursor = parseNonNegativeInt(ctx.url, "after", 0);
  const events = ctx.engine.store
    .listEvents(runId, { afterCursor })
    .filter((row) => matchesChannels(row.event, channels));
  sendJson(ctx.res, 200, { events });
}

/** POST /api/runs/:id/cancel — 202: accepted now, completes after the cooperative grace. */
export function handleCancelRun(ctx: RouteContext, runId: string): void {
  if (ctx.engine.store.getRun(runId) === null) {
    throw new HttpError(404, "NOT_FOUND", `Unknown run: ${runId}`);
  }
  // Why not awaited: cancellation holds the SIGTERM→SIGKILL grace window open (seconds); 202
  // promises "accepted", and the caller observes completion via the run's status.
  void ctx.engine.cancelRun(runId).catch((err: unknown) => {
    ctx.log(`cancel of run ${runId} failed: ${err instanceof Error ? err.message : String(err)}`);
  });
  sendJson(ctx.res, 202, {});
}

// GET /api/runs/:id/stream — the SSE live tail (SPEC §2.4, MASTER_SPEC §2.5): replay
// persisted events after the resume cursor, then follow live ones. Every frame carries
// `id: <cursor>`, so a dropped client reconnects with Last-Event-ID and misses nothing —
// cursors are run-global and independent of channel filtering, which keeps filtered resumes
// gap-free.

import { matchesChannels } from "@boardwalk-labs/workflow";
import type { IncomingMessage } from "node:http";
import type { EventRow } from "../../store/store.js";
import { HttpError, parseChannelSelection, parseNonNegativeInt } from "../http.js";
import type { RouteContext } from "./router.js";

/** SSE comment frames keep intermediaries from idling out a quiet tail. */
const PING_INTERVAL_MS = 15_000;

export function handleStreamRun(ctx: RouteContext, runId: string): void {
  // All validation happens before headers go out — after writeHead the JSON error contract
  // is unreachable.
  if (ctx.engine.store.getRun(runId) === null) {
    throw new HttpError(404, "NOT_FOUND", `Unknown run: ${runId}`);
  }
  const channels = parseChannelSelection(ctx.url);
  const afterCursor = resolveResumeCursor(ctx.req, ctx.url);

  ctx.res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  // High-water mark of cursors already handled. It advances even for events the channel
  // filter drops: a filtered-out cursor is "covered", and skipping it is not a gap.
  let delivered = afterCursor;
  const deliver = (row: EventRow): void => {
    if (row.cursor <= delivered) return;
    delivered = row.cursor;
    if (!matchesChannels(row.event, channels)) return;
    if (ctx.res.writableEnded || ctx.res.destroyed) return;
    ctx.res.write(`id: ${String(row.cursor)}\ndata: ${JSON.stringify(row.event)}\n\n`);
  };

  // Why subscribe BEFORE reading the store: an event appended between "read store" and
  // "subscribe" would be lost forever. Subscribing first means such events land in the
  // backlog instead, and the high-water mark dedupes any the replay also saw.
  let replaying = true;
  const backlog: EventRow[] = [];
  const unsubscribe = ctx.engine.onEvent((row) => {
    if (row.runId !== runId) return;
    if (replaying) backlog.push(row);
    else deliver(row);
  });
  for (const row of ctx.engine.store.listEvents(runId, { afterCursor })) deliver(row);
  replaying = false;
  for (const row of backlog.splice(0)) deliver(row);

  const ping = setInterval(() => {
    ctx.res.write(": ping\n\n");
  }, PING_INTERVAL_MS);
  // Why unref: a lingering tail must never hold the process open past server close.
  ping.unref();
  ctx.res.on("close", () => {
    clearInterval(ping);
    unsubscribe();
  });
}

/**
 * Where to resume from: the SSE-standard Last-Event-ID header wins (it is what browsers send
 * on automatic reconnect), then `?after=`, then 0 (everything).
 */
function resolveResumeCursor(req: IncomingMessage, url: URL): number {
  const header = req.headers["last-event-id"];
  const value = Array.isArray(header) ? header[0] : header;
  if (value !== undefined) {
    const cursor = Number(value);
    if (value.trim() === "" || !Number.isInteger(cursor) || cursor < 0) {
      throw new HttpError(
        400,
        "VALIDATION",
        `Last-Event-ID must be a non-negative integer cursor (got "${value}").`,
      );
    }
    return cursor;
  }
  return parseNonNegativeInt(url, "after", 0);
}

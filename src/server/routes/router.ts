// SPDX-License-Identifier: Apache-2.0

// URL → handler resolution for the engine server. One flat match over decoded path segments —
// the route table is small enough that a real trie/middleware stack would be pure ceremony.
// Method mismatches on a known path get 405 + Allow (not 404), so clients can tell "wrong
// verb" from "no such thing".

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Engine } from "../../engine.js";
import { HttpError } from "../http.js";
import {
  handleCancelRun,
  handleGetRun,
  handleListEvents,
  handleListPendingInputs,
  handleListRunInputs,
  handleListRuns,
  handleListWorkflows,
  handleRespondToInput,
  handleStartRun,
} from "./api.js";
import { handleWebhook } from "./hooks.js";
import { handleStreamRun } from "./stream.js";
import { handleUiPage } from "./ui.js";

/** Everything a route handler may touch. The server only calls engine/store methods. */
export interface RouteContext {
  engine: Engine;
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  log: (line: string) => void;
}

type Handler = (ctx: RouteContext) => Promise<void> | void;

/**
 * Resolve and run the handler for one request. Throws HttpError for routing failures; the
 * server's top-level catch renders them, so handlers never touch error formatting.
 */
export async function dispatchRequest(
  engine: Engine,
  req: IncomingMessage,
  res: ServerResponse,
  log: (line: string) => void,
): Promise<void> {
  const method = req.method ?? "GET";
  // The base never matters — routes only read pathname + searchParams.
  const url = new URL(req.url ?? "/", "http://localhost");
  const methods = matchRoute(decodePathSegments(url.pathname));
  if (methods === null) {
    throw new HttpError(404, "NOT_FOUND", `No such route: ${url.pathname}`);
  }
  const handler = methods[method];
  if (handler === undefined) {
    // Allow rides on setHeader so the shared error renderer needs no special 405 case.
    res.setHeader("allow", Object.keys(methods).join(", "));
    throw new HttpError(405, "METHOD_NOT_ALLOWED", `${method} is not allowed for ${url.pathname}.`);
  }
  await handler({ engine, req, res, url, log });
}

function decodePathSegments(pathname: string): string[] {
  return pathname
    .split("/")
    .filter((segment) => segment !== "")
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        throw new HttpError(400, "VALIDATION", "Malformed percent-encoding in URL path.");
      }
    });
}

/** The route table: path segments → method → handler. Null means no such resource (404). */
function matchRoute(segments: readonly string[]): Record<string, Handler> | null {
  const [first, second, third, fourth] = segments;
  if (segments.length === 0) return { GET: handleUiPage };
  if (first === "api" && second === "workflows") {
    if (segments.length === 2) return { GET: handleListWorkflows };
    if (segments.length === 4 && third !== undefined && fourth === "runs") {
      return { POST: (ctx) => handleStartRun(ctx, third) };
    }
  }
  if (first === "api" && second === "inputs" && segments.length === 2) {
    return { GET: handleListPendingInputs };
  }
  if (first === "api" && second === "runs") {
    if (segments.length === 2) return { GET: handleListRuns };
    if (third === undefined) return null;
    if (segments.length === 3) return { GET: (ctx) => handleGetRun(ctx, third) };
    if (segments.length === 4) {
      if (fourth === "events") return { GET: (ctx) => handleListEvents(ctx, third) };
      if (fourth === "cancel") return { POST: (ctx) => handleCancelRun(ctx, third) };
      if (fourth === "stream") return { GET: (ctx) => handleStreamRun(ctx, third) };
      if (fourth === "inputs") return { GET: (ctx) => handleListRunInputs(ctx, third) };
    }
    // POST /api/runs/:id/inputs/:key — answer a pending gate.
    if (segments.length === 5 && fourth === "inputs") {
      const key = segments[4];
      if (key !== undefined) return { POST: (ctx) => handleRespondToInput(ctx, third, key) };
    }
  }
  if (first === "hooks" && segments.length === 3 && second !== undefined && third !== undefined) {
    return { POST: (ctx) => handleWebhook(ctx, second, third) };
  }
  return null;
}

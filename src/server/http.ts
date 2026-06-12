// Shared HTTP plumbing for the engine server: the error type every route throws, JSON
// request/response helpers, and query/body parsing. Bare node:http is deliberate (no
// third-party HTTP framework anywhere in the Boardwalk stack) — these helpers are the entire
// "framework", so every trust boundary (bodies, query params, headers) is narrowed with Zod
// or a type predicate before any engine call sees the data.

import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { CHANNELS, DEFAULT_CHANNELS } from "@boardwalk/workflow";
import type { Channel, JsonValue } from "@boardwalk/workflow";
import { EngineError } from "../errors.js";

/** Bodies above this reject with 413 — nothing on this surface needs more than 1 MiB. */
export const MAX_BODY_BYTES = 1024 * 1024;

/**
 * An error that already knows its HTTP response. Routes throw these (or EngineErrors) and the
 * top-level dispatcher renders them, so every endpoint shares one wire shape:
 * `{ error: { code, message, hint? } }`.
 */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  /** A one-line pointer at the fix (env var to set, valid values) — safe to show anywhere. */
  readonly hint: string | undefined;

  constructor(status: number, code: string, message: string, hint?: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.hint = hint;
  }
}

/**
 * JSON values as a Zod schema, for narrowing parsed request bodies. The store keeps its own
 * private copy — two private copies beat widening the store's public surface for one schema.
 */
export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

/** Serialize `payload` and finish the response. The one place response JSON is written. */
export function sendJson(
  res: ServerResponse,
  status: number,
  payload: object,
  headers: Record<string, string> = {},
): void {
  // Why stringify before writeHead: a serialization failure must not escape after the status
  // line is on the wire, where the JSON error contract is unreachable.
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  res.end(body);
}

/**
 * Render any thrown value as the JSON error contract. `err` is `unknown` because this sits
 * behind a catch boundary — the one place that type is unavoidable; it is narrowed immediately
 * via instanceof. Internals (stacks, unexpected messages) go to `log`, never to the client.
 */
export function sendError(res: ServerResponse, err: unknown, log: (line: string) => void): void {
  if (res.headersSent || res.destroyed) {
    // Mid-stream failure (e.g. SSE): the JSON contract is unreachable; drop the connection.
    res.destroy();
    return;
  }
  if (err instanceof HttpError) {
    // Why connection: close on 413: the client may still be sending the oversized body; close
    // tells it to stop instead of stalling the kept-alive socket on unread data.
    const headers = err.status === 413 ? { connection: "close" } : {};
    sendJson(
      res,
      err.status,
      { error: { code: err.code, message: err.message, hint: err.hint } },
      headers,
    );
    return;
  }
  if (err instanceof EngineError) {
    const status = engineErrorStatus(err);
    if (status !== null) {
      sendJson(res, status, { error: { code: err.code, message: err.message, hint: err.hint } });
      return;
    }
  }
  log(`internal error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  sendJson(res, 500, { error: { code: "INTERNAL", message: "Internal server error." } });
}

/**
 * The HTTP status an EngineError code implies, or null for codes that must render as an
 * opaque 500 (anything unexpected at this surface could leak engine internals).
 */
function engineErrorStatus(err: EngineError): number | null {
  switch (err.code) {
    case "NOT_FOUND":
      return 404;
    case "VALIDATION":
      return 400;
    case "CONFLICT":
      return 409;
    case "UNSUPPORTED":
      return 400;
    default:
      return null;
  }
}

/** Buffer a request body, rejecting 413 as soon as it exceeds `limitBytes`. */
export function readBody(req: IncomingMessage, limitBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let settled = false;
    const fail = (failure: HttpError): void => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      reject(failure);
    };
    // Why the Buffer annotation: no encoding is set on the stream, so chunks are Buffers per
    // the node:http contract; the generic listener type erases that to `any`.
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      received += chunk.length;
      if (received > limitBytes) {
        fail(
          new HttpError(
            413,
            "PAYLOAD_TOO_LARGE",
            `Request body exceeds the ${String(limitBytes)}-byte limit.`,
          ),
        );
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on("error", () => {
      fail(new HttpError(400, "VALIDATION", "Request body could not be read."));
    });
  });
}

/** Parse a body as JSON and narrow it with `schema` — the trust boundary for HTTP input. */
export function parseJsonBody<T>(raw: Buffer, schema: z.ZodType<T>, what: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new HttpError(400, "VALIDATION", `${what} is not valid JSON.`);
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new HttpError(400, "VALIDATION", `${what} failed validation: ${result.error.message}`);
  }
  return result.data;
}

/** Parse `?name=<n>` as a non-negative integer, falling back when the parameter is absent. */
export function parseNonNegativeInt(url: URL, name: string, fallback: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (raw.trim() === "" || !Number.isInteger(value) || value < 0) {
    throw new HttpError(
      400,
      "VALIDATION",
      `Query parameter "${name}" must be a non-negative integer (got "${raw}").`,
    );
  }
  return value;
}

function isChannel(value: string): value is Channel {
  return CHANNELS.some((channel) => channel === value);
}

/**
 * The channel subscription for an event read (`/events` and `/stream` share this so a tail and
 * its catch-up reads can never disagree): `?verbose=true` = everything, `?channels=a,b` = an
 * explicit set, neither = MASTER_SPEC §2.5's default of lifecycle + phase + output.
 */
export function parseChannelSelection(url: URL): readonly Channel[] {
  const verbose = url.searchParams.get("verbose");
  if (verbose !== null && verbose !== "true" && verbose !== "false") {
    throw new HttpError(
      400,
      "VALIDATION",
      `Query parameter "verbose" must be "true" or "false" (got "${verbose}").`,
    );
  }
  if (verbose === "true") return CHANNELS;
  const raw = url.searchParams.get("channels");
  if (raw === null) return DEFAULT_CHANNELS;
  const channels: Channel[] = [];
  for (const name of raw.split(",").map((part) => part.trim())) {
    if (!isChannel(name)) {
      throw new HttpError(
        400,
        "VALIDATION",
        `Unknown channel "${name}".`,
        `Valid channels: ${CHANNELS.join(", ")}.`,
      );
    }
    channels.push(name);
  }
  return channels;
}

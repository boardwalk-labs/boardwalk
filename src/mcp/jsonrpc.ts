// JSON-RPC 2.0 request/notification correlation for the hand-rolled MCP client (the
// @modelcontextprotocol/sdk dependency tree was rejected for the flagship — zero new deps).
// The transport moves frames; this layer owns ids, correlation, timeouts, and the trust
// boundary: every inbound frame is Zod-validated before anything dereferences it
// (an MCP server is as untrusted as any provider).

import { z } from "zod";
import { EngineError } from "../errors.js";

/** A frame this client sends: a request, a notification, or an error reply to a server request. */
export type JsonRpcOutbound =
  | { jsonrpc: "2.0"; id: number; method: string; params?: unknown }
  | { jsonrpc: "2.0"; method: string; params?: unknown }
  | { jsonrpc: "2.0"; id: string | number; error: { code: number; message: string } };

/**
 * What a transport must provide: framing only — no protocol knowledge. Both implementations
 * (stdio child process, streamable HTTP) fit behind this so the client and every test fake
 * are transport-agnostic.
 */
export interface McpTransport {
  send(message: JsonRpcOutbound): Promise<void>;
  /** Deliver every inbound frame (already JSON-parsed, still untrusted) to the client. */
  onMessage(cb: (message: unknown) => void): void;
  /** Invoked at most once if the transport dies out from under the client (process exit). */
  onClose(cb: (err: Error) => void): void;
  close(): Promise<void>;
}

// One loose schema for every inbound frame; classification happens after validation. A frame
// is a server request/notification (has `method`) or a response (has `id` + result/error).
const inboundFrameSchema = z.looseObject({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]).nullish(),
  method: z.string().optional(),
  result: z.unknown().optional(),
  error: z.looseObject({ code: z.number(), message: z.string() }).optional(),
});

/** Default per-request timeout — a hung MCP server must fail the call, not hold the run. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export interface JsonRpcClientOptions {
  /** Names the peer in every error message (the MCP server's name from the agent() call). */
  label: string;
  timeoutMs?: number;
}

export class JsonRpcClient {
  private readonly transport: McpTransport;
  private readonly label: string;
  private readonly timeoutMs: number;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private closed = false;

  constructor(transport: McpTransport, opts: JsonRpcClientOptions) {
    this.transport = transport;
    this.label = opts.label;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    transport.onMessage((message) => this.handleInbound(message));
    transport.onClose((err) => this.failAllPending(err));
  }

  /** Send a request and resolve with its (still-unknown) result; the caller Zod-narrows it. */
  request(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(this.connectionError(`cannot call ${method} — connection is closed`));
    }
    const id = this.nextId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          this.connectionError(
            `"${method}" timed out after ${String(this.timeoutMs / 1000)}s — the server never answered`,
          ),
        );
      }, this.timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
    });
    this.transport
      .send({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) })
      .catch((err: unknown) => {
        this.settle(id, (pending) =>
          pending.reject(err instanceof Error ? err : this.connectionError(String(err))),
        );
      });
    return promise;
  }

  /** Fire-and-forget notification (e.g. `notifications/initialized`). */
  async notify(method: string, params?: unknown): Promise<void> {
    await this.transport.send({
      jsonrpc: "2.0",
      method,
      ...(params !== undefined ? { params } : {}),
    });
  }

  /** Close the transport and reject everything in flight — callers must never hang. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.failAllPending(this.connectionError("connection closed"));
    await this.transport.close();
  }

  private handleInbound(message: unknown): void {
    const parsed = inboundFrameSchema.safeParse(message);
    if (!parsed.success) return; // not a JSON-RPC 2.0 frame — drop, never crash on peer noise
    const frame = parsed.data;

    if (frame.method !== undefined) {
      // A server→client request (sampling, roots, …): this minimal client implements none, so
      // answer "method not found" rather than leaving the server hanging. Notifications
      // (no id) are dropped — nothing here consumes them yet.
      if (frame.id !== undefined && frame.id !== null) {
        void this.transport
          .send({
            jsonrpc: "2.0",
            id: frame.id,
            error: { code: -32601, message: "This client supports no server-initiated requests" },
          })
          .catch(() => {
            // The reply is best-effort courtesy; a dead transport already failed the pending map.
          });
      }
      return;
    }

    if (typeof frame.id !== "number") return; // our ids are numeric; anything else isn't ours
    const id = frame.id;
    if (frame.error !== undefined) {
      const { code, message } = frame.error;
      this.settle(id, (pending) =>
        pending.reject(
          this.connectionError(`"${pending.method}" failed: ${message} (code ${String(code)})`),
        ),
      );
      return;
    }
    this.settle(id, (pending) => pending.resolve(frame.result));
  }

  private settle(id: number, fn: (pending: Pending) => void): void {
    const pending = this.pending.get(id);
    if (pending === undefined) return; // already timed out / unknown id — nothing to do
    this.pending.delete(id);
    clearTimeout(pending.timer);
    fn(pending);
  }

  private failAllPending(err: Error): void {
    for (const [id] of [...this.pending]) {
      this.settle(id, (pending) => pending.reject(err));
    }
  }

  private connectionError(detail: string): EngineError {
    return new EngineError("PROVIDER_ERROR", `MCP server "${this.label}": ${detail}.`);
  }
}

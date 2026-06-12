// MCP streamable-HTTP transport (spec rev 2025-06-18 §Transports): every client message is a
// POST to the server URL; the response is either a single JSON body or an SSE stream of
// JSON-RPC messages (one shared parser with the provider adapters — src/agent/sse.ts). The
// transport also owns the session header (`Mcp-Session-Id`, captured at initialize and
// replayed on every later request) and the OAuth retry dance: program-supplied headers are
// always applied first; a bearer token is only fetched — through the `acquireToken` hook the
// connection layer provides — after the server answers 401.

import { EngineError } from "../errors.js";
import { sseDataLines } from "../agent/sse.js";
import type { JsonRpcOutbound, McpTransport } from "./jsonrpc.js";

export interface HttpTransportOptions {
  /** The MCP server's name from the agent() call — names the endpoint in every error. */
  serverName: string;
  url: string;
  /** Program-supplied headers (the program is the trusted layer; credentials go here). */
  headers?: Record<string, string> | undefined;
  /**
   * The OAuth hook: called when the server answers 401. `failedToken` is the bearer token the
   * rejected request carried (null when none was sent). Returns a token to retry with; throws
   * to fail the call (e.g. when the engine holds no token and a human must authorize).
   * Omitted ⇒ a 401 is a plain provider error.
   */
  acquireToken?: ((failedToken: string | null) => Promise<string>) | undefined;
  fetchImpl?: typeof fetch | undefined;
}

/** 401-retry budget per message: original try + one retried token + one invalidate-and-retry. */
const MAX_AUTH_ATTEMPTS = 3;

export class HttpTransport implements McpTransport {
  private readonly serverName: string;
  private readonly url: string;
  private readonly baseHeaders: Record<string, string>;
  private readonly acquireToken: ((failedToken: string | null) => Promise<string>) | undefined;
  private readonly fetchImpl: typeof fetch;
  private messageCb: ((message: unknown) => void) | null = null;
  private sessionId: string | null = null;
  private protocolVersion: string | null = null;
  private bearerToken: string | null = null;

  constructor(opts: HttpTransportOptions) {
    this.serverName = opts.serverName;
    this.url = opts.url;
    this.baseHeaders = { ...opts.headers };
    this.acquireToken = opts.acquireToken;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async send(message: JsonRpcOutbound): Promise<void> {
    const body = JSON.stringify(message);
    let response: Response | null = null;
    for (let attempt = 1; attempt <= MAX_AUTH_ATTEMPTS; attempt++) {
      const sentToken = this.bearerToken;
      try {
        response = await this.fetchImpl(this.url, {
          method: "POST",
          headers: this.requestHeaders(sentToken),
          body,
        });
      } catch (err) {
        // fetch network failures are bare TypeErrors ("fetch failed") — name the server.
        throw new EngineError(
          "PROVIDER_ERROR",
          `MCP server "${this.serverName}" (${this.url}) is unreachable: ` +
            `${err instanceof Error ? err.message : String(err)}.`,
          "Check the URL and that the server is up — the agent() call named this server, so " +
            "the run fails rather than silently dropping its tools.",
        );
      }
      if (response.status !== 401) break;
      if (this.acquireToken === undefined || attempt === MAX_AUTH_ATTEMPTS) {
        throw new EngineError(
          "PROVIDER_ERROR",
          `MCP server "${this.serverName}" (${this.url}) rejected the request: 401 Unauthorized.`,
          this.acquireToken === undefined
            ? "The server demands credentials; supply them in the McpServerRef headers, or use " +
                "an engine-authorized OAuth token."
            : "A freshly issued token was still rejected — re-authorize the server with " +
                "engine.authorizeMcpServer.",
        );
      }
      // The hook decides between cached/refreshed/none; passing the failed token tells the
      // engine to invalidate it rather than hand the same one back.
      this.bearerToken = await this.acquireToken(sentToken);
    }
    if (response === null) return; // unreachable: the loop always assigns — satisfies narrowing
    await this.consumeResponse(response);
  }

  onMessage(cb: (message: unknown) => void): void {
    this.messageCb = cb;
  }

  onClose(_cb: (err: Error) => void): void {
    // HTTP has no long-lived pipe to lose; per-request failures reject the send instead.
  }

  /** The MCP client calls this after the initialize handshake settles the version. */
  setProtocolVersion(version: string): void {
    this.protocolVersion = version;
  }

  /** Best-effort session teardown (spec: clients SHOULD DELETE the session when done). */
  async close(): Promise<void> {
    if (this.sessionId === null) return;
    try {
      await this.fetchImpl(this.url, {
        method: "DELETE",
        headers: this.requestHeaders(this.bearerToken),
      });
    } catch {
      // The session will expire server-side; teardown must never fail a finished run.
    }
    this.sessionId = null;
  }

  private requestHeaders(token: string | null): Record<string, string> {
    return {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...this.baseHeaders,
      ...(this.sessionId !== null ? { "mcp-session-id": this.sessionId } : {}),
      ...(this.protocolVersion !== null ? { "mcp-protocol-version": this.protocolVersion } : {}),
      // After base headers: OAuth only engages when the program's own headers got a 401, so
      // overriding a program-supplied Authorization here is the correct escalation.
      ...(token !== null ? { authorization: `Bearer ${token}` } : {}),
    };
  }

  private async consumeResponse(response: Response): Promise<void> {
    const session = response.headers.get("mcp-session-id");
    if (session !== null && session.length > 0) this.sessionId = session;

    if (response.status === 202 || response.status === 204) return; // accepted notification
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      throw new EngineError(
        "PROVIDER_ERROR",
        `MCP server "${this.serverName}" (${this.url}) returned ${String(response.status)}: ${detail}`,
      );
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream")) {
      // The server chose to stream: each SSE data line is one JSON-RPC message; the response
      // to our request arrives through the same onMessage path the correlator already watches.
      for await (const data of sseDataLines(response)) {
        this.deliverJson(data);
      }
      return;
    }
    if (contentType.includes("application/json")) {
      this.deliverJson(await response.text());
    }
    // Any other content type carries no JSON-RPC messages — nothing to deliver.
  }

  private deliverJson(text: string): void {
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      return; // malformed server frame — the request will time out with a clear error
    }
    // 2025-03-26-era servers may still answer with a JSON-RPC batch array.
    if (Array.isArray(message)) {
      // Why the annotation: Array.isArray narrows unknown to any[]; widen back to unknown[].
      const items: unknown[] = message;
      for (const item of items) this.messageCb?.(item);
      return;
    }
    this.messageCb?.(message);
  }
}

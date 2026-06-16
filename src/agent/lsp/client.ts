// SPDX-License-Identifier: Apache-2.0

// A minimal, hand-rolled LSP client over a spawned language-server child (stdio, Content-Length
// framing). It models the MCP client's spawn + request/notification + correlation pattern
// (src/mcp/{jsonrpc,transport_stdio}.ts); LSP differs only in framing (FrameDecoder) and in that we
// COLLECT the server's `textDocument/publishDiagnostics` notifications per file URI rather than
// drop them — diagnostics are the whole point.
//
// Everything is BEST-EFFORT and BOUNDED: a language server is observability, never load-bearing, so
// a spawn failure, a hung server, or a slow response degrades (no diagnostics) rather than throwing
// into the run or hanging it. Every request and every diagnostics wait has a timeout, and close()
// always tears the process down — no leaked children.

import { spawn, type ChildProcess } from "node:child_process";
import { encodeFrame, FrameDecoder } from "./framing.js";

/** One diagnostic as the loop renders it — the LSP shape narrowed to what we surface. */
export interface Diagnostic {
  /** 1-based line (LSP positions are 0-based on the wire; we convert for human-facing output). */
  line: number;
  severity: DiagnosticSeverity;
  message: string;
  /** The server's rule/code when present (e.g. a TS error number), for context. */
  source?: string;
}

export type DiagnosticSeverity = "error" | "warning" | "information" | "hint";

/** Why a client is unusable, so the service can degrade with a clear (never alarming) note. */
export type LspClientStatus = "ready" | "spawn-failed" | "exited";

export interface LspClientOptions {
  command: string;
  args?: readonly string[];
  /** The run workspace — sent as the server's rootUri and used as the child's cwd. */
  workspaceDir: string;
  /** Per-request timeout; a server that never answers must not hold the run. */
  requestTimeoutMs: number;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * A live connection to one language server. Lazily handshaken on first use, reused for the run, torn
 * down on close. Never throws into the caller: failures flip `status` away from "ready" and the
 * service treats a non-ready client as "no diagnostics".
 */
export class LspClient {
  private readonly child: ChildProcess;
  private readonly decoder = new FrameDecoder();
  private readonly requestTimeoutMs: number;
  private readonly pending = new Map<number, Pending>();
  /** Latest published diagnostics per document URI (publishDiagnostics REPLACES the prior set). */
  private readonly diagnostics = new Map<string, Diagnostic[]>();
  /** Resolvers waiting for the NEXT publishDiagnostics for a given URI (one-shot, fired then cleared). */
  private readonly waiters = new Map<string, (() => void)[]>();
  private nextId = 1;
  private statusValue: LspClientStatus = "ready";
  private closed = false;

  constructor(opts: LspClientOptions) {
    this.requestTimeoutMs = opts.requestTimeoutMs;
    // stderr is inherited so a server's own diagnostics land in the run log like any other program
    // output (matching the MCP stdio transport); we never parse it.
    this.child = spawn(opts.command, [...(opts.args ?? [])], {
      cwd: opts.workspaceDir,
      stdio: ["pipe", "pipe", "inherit"],
    });
    this.child.on("error", () => this.die("spawn-failed"));
    this.child.on("exit", () => this.die("exited"));
    this.child.stdout?.on("data", (chunk: Buffer) => {
      for (const message of this.decoder.push(chunk)) this.handleInbound(message);
    });
  }

  get status(): LspClientStatus {
    return this.statusValue;
  }

  /** Send a request and resolve with its (untrusted) result; rejects on timeout/dead transport. */
  request(method: string, params?: unknown): Promise<unknown> {
    if (this.statusValue !== "ready") {
      return Promise.reject(new Error(`language server is ${this.statusValue}`));
    }
    const id = this.nextId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP request "${method}" timed out`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.write({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });
    return promise;
  }

  /** Fire-and-forget notification (initialized, didOpen/didChange/didClose). */
  notify(method: string, params?: unknown): void {
    if (this.statusValue !== "ready") return;
    this.write({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) });
  }

  /** The latest published diagnostics for a URI, or [] if the server has published none. */
  diagnosticsFor(uri: string): Diagnostic[] {
    return this.diagnostics.get(uri) ?? [];
  }

  /** Every URI the server currently reports at least one diagnostic for. */
  urisWithDiagnostics(): string[] {
    return [...this.diagnostics].filter(([, ds]) => ds.length > 0).map(([uri]) => uri);
  }

  /**
   * Wait (bounded) for the NEXT publishDiagnostics for `uri` after a sync. Resolves true if the
   * server published in time, false if it timed out — the caller returns whatever's cached either
   * way (best-effort), so a slow server costs latency, never correctness.
   */
  waitForDiagnostics(uri: string, timeoutMs: number): Promise<boolean> {
    if (this.statusValue !== "ready") return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const settle = (published: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(published);
      };
      const timer = setTimeout(() => settle(false), timeoutMs);
      const list = this.waiters.get(uri) ?? [];
      list.push(() => settle(true));
      this.waiters.set(uri, list);
    });
  }

  /**
   * Tear the server down cleanly: `shutdown` request → `exit` notification (the LSP-spec polite
   * teardown), then a hard kill if it doesn't exit promptly. Idempotent and never throws — close
   * runs on the run's teardown path, including after a crash.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const exited = await this.gracefulShutdown();
    if (!exited && this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill("SIGKILL");
    }
    this.die("exited");
  }

  private async gracefulShutdown(): Promise<boolean> {
    if (this.statusValue !== "ready") return true; // already dead — nothing to shut down
    try {
      await this.request("shutdown");
    } catch {
      return false; // a server that won't acknowledge shutdown gets killed below
    }
    this.notify("exit");
    return await this.awaitExit(SHUTDOWN_EXIT_GRACE_MS);
  }

  private awaitExit(timeoutMs: number): Promise<boolean> {
    if (this.child.exitCode !== null || this.child.signalCode !== null)
      return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.child.once("exit", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  private handleInbound(message: unknown): void {
    if (typeof message !== "object" || message === null) return;
    const frame = message as Record<string, unknown>;
    const id = frame["id"];
    const method = frame["method"];

    // A server→client request (the few servers that ask for config/registration): answer "method
    // not found" so the server isn't left hanging, exactly as the MCP client does. We implement none.
    if (typeof method === "string") {
      if (typeof id === "number" || typeof id === "string") {
        this.write({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: "client supports no server-initiated requests" },
        });
      }
      if (method === "textDocument/publishDiagnostics") this.onPublishDiagnostics(frame["params"]);
      return;
    }

    if (typeof id !== "number") return; // our request ids are numeric; anything else isn't a reply
    const settle = this.pending.get(id);
    if (settle === undefined) return;
    this.pending.delete(id);
    clearTimeout(settle.timer);
    if (frame["error"] !== undefined) {
      settle.reject(new Error(`LSP request failed: ${describeError(frame["error"])}`));
    } else {
      settle.resolve(frame["result"]);
    }
  }

  private onPublishDiagnostics(params: unknown): void {
    if (typeof params !== "object" || params === null) return;
    const record = params as Record<string, unknown>;
    const uri = record["uri"];
    if (typeof uri !== "string") return;
    this.diagnostics.set(uri, parseDiagnostics(record["diagnostics"]));
    const waiting = this.waiters.get(uri);
    if (waiting !== undefined) {
      this.waiters.delete(uri);
      for (const fire of waiting) fire();
    }
  }

  private write(message: unknown): void {
    const stdin = this.child.stdin;
    if (stdin === null || !stdin.writable) {
      this.die("exited");
      return;
    }
    stdin.write(encodeFrame(message), (err) => {
      if (err !== null && err !== undefined) this.die("exited");
    });
  }

  /** Mark the client unusable and fail everything in flight; never downgrade a real failure to "exited". */
  private die(status: Exclude<LspClientStatus, "ready">): void {
    if (this.statusValue === "ready") this.statusValue = status;
    for (const [id, pending] of [...this.pending]) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(new Error(`language server is ${this.statusValue}`));
    }
    for (const [uri, fns] of [...this.waiters]) {
      this.waiters.delete(uri);
      for (const fire of fns) fire(); // unblock waiters — they read the cache (likely empty) and move on
    }
  }
}

/** How long after `exit` we wait for a clean process exit before SIGKILL. */
const SHUTDOWN_EXIT_GRACE_MS = 2_000;

const LSP_SEVERITY: Record<number, DiagnosticSeverity> = {
  1: "error",
  2: "warning",
  3: "information",
  4: "hint",
};

/** Narrow the server's `diagnostics` array (untrusted) into our shape, converting 0-based → 1-based lines. */
function parseDiagnostics(value: unknown): Diagnostic[] {
  if (!Array.isArray(value)) return [];
  const out: Diagnostic[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const message = record["message"];
    if (typeof message !== "string") continue;
    const startLine = readStartLine(record["range"]);
    const severityCode = record["severity"];
    const severity =
      typeof severityCode === "number" ? (LSP_SEVERITY[severityCode] ?? "error") : "error";
    const source = readSource(record["source"], record["code"]);
    out.push({
      line: startLine + 1,
      severity,
      message,
      ...(source !== undefined ? { source } : {}),
    });
  }
  return out;
}

function readStartLine(range: unknown): number {
  if (typeof range !== "object" || range === null) return 0;
  const start = (range as Record<string, unknown>)["start"];
  if (typeof start !== "object" || start === null) return 0;
  const line = (start as Record<string, unknown>)["line"];
  return typeof line === "number" && Number.isInteger(line) && line >= 0 ? line : 0;
}

function readSource(source: unknown, code: unknown): string | undefined {
  const name = typeof source === "string" && source.length > 0 ? source : undefined;
  const id = typeof code === "string" || typeof code === "number" ? String(code) : undefined;
  if (name !== undefined && id !== undefined) return `${name} ${id}`;
  return name ?? id;
}

function describeError(error: unknown): string {
  if (typeof error !== "object" || error === null) return "unknown error";
  const message = (error as Record<string, unknown>)["message"];
  return typeof message === "string" ? message : "unknown error";
}

// SPDX-License-Identifier: Apache-2.0

// An LspSession is one language server, lazily started on first use and reused for the whole run.
// It owns the LSP HANDSHAKE (`initialize` with the workspace rootUri + minimal capabilities →
// `initialized`) and DOCUMENT SYNC (didOpen / didChange / didClose), and exposes "sync this file
// and give me its current diagnostics" to the service above it.
//
// Everything is best-effort + bounded. Initialization is attempted once (a second use after a
// failed/timed-out init does not re-spawn); a hung handshake degrades to "no diagnostics". A
// running file is reopened with its latest text and we wait (bounded) for the server to re-publish.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { LspClient, type Diagnostic } from "./client.js";
import { languageIdForPath, type LanguageServer } from "./registry.js";

/** How long to wait for the `initialize` handshake before giving up on the server. */
const INITIALIZE_TIMEOUT_MS = 5_000;
/** Per-request timeout for everything the client sends (initialize/shutdown). */
const REQUEST_TIMEOUT_MS = 5_000;

export interface LspSessionOptions {
  server: LanguageServer;
  workspaceDir: string;
  /** Override for tests; defaults to the registry server's command. */
  command?: string;
  args?: readonly string[];
}

/** The result of syncing a file: its diagnostics, or a reason none are available (best-effort). */
export interface SyncResult {
  available: boolean;
  diagnostics: Diagnostic[];
}

const UNAVAILABLE: SyncResult = { available: false, diagnostics: [] };

export class LspSession {
  private readonly server: LanguageServer;
  private readonly workspaceDir: string;
  private readonly command: string;
  private readonly args: readonly string[];
  /** Lazily created on first sync; null until then. */
  private client: LspClient | null = null;
  /** One-shot handshake; reused so concurrent first-syncs share the same initialize. */
  private initialization: Promise<boolean> | null = null;
  /** Document versions for didChange (LSP requires a monotonically increasing version per URI). */
  private readonly versions = new Map<string, number>();

  constructor(opts: LspSessionOptions) {
    this.server = opts.server;
    this.workspaceDir = opts.workspaceDir;
    this.command = opts.command ?? opts.server.command;
    this.args = opts.args ?? opts.server.args;
  }

  /**
   * Sync `absolutePath`'s on-disk contents to the server and return its current diagnostics. The
   * file is opened (first sync) or changed (subsequent syncs) and we wait, bounded by
   * `diagnosticsWaitMs`, for the server to publish. Always resolves — a dead/hung server yields
   * `{ available: false }`, never a throw.
   */
  async diagnostics(absolutePath: string, diagnosticsWaitMs: number): Promise<SyncResult> {
    const client = await this.ensureInitialized();
    if (client === null || client.status !== "ready") return UNAVAILABLE;

    let text: string;
    try {
      text = readFileSync(absolutePath, "utf8");
    } catch {
      return UNAVAILABLE; // the file vanished between write and sync — nothing to diagnose
    }

    const uri = pathToFileURL(absolutePath).href;
    const languageId = languageIdForPath(this.server, absolutePath);
    const previous = this.versions.get(uri);
    if (previous === undefined) {
      this.versions.set(uri, 1);
      client.notify("textDocument/didOpen", {
        textDocument: { uri, languageId, version: 1, text },
      });
    } else {
      const version = previous + 1;
      this.versions.set(uri, version);
      client.notify("textDocument/didChange", {
        textDocument: { uri, version },
        contentChanges: [{ text }], // full-document sync (the simplest TextDocumentSyncKind)
      });
    }

    await client.waitForDiagnostics(uri, diagnosticsWaitMs);
    return { available: true, diagnostics: client.diagnosticsFor(uri) };
  }

  /** URIs the server currently reports diagnostics for (after at least one sync), workspace-wide. */
  urisWithDiagnostics(): string[] {
    return this.client?.urisWithDiagnostics() ?? [];
  }

  /** Tear the server down. Idempotent, never throws (runs on the run's teardown path). */
  async close(): Promise<void> {
    await this.client?.close();
  }

  /**
   * Spawn + handshake on first use; cache the outcome. Returns the ready client, or null if the
   * server couldn't be spawned or didn't complete the handshake in time. Never re-spawns after a
   * failure — a missing/broken server stays "unavailable" for the run rather than retried per edit.
   */
  private async ensureInitialized(): Promise<LspClient | null> {
    if (this.initialization === null) {
      const client = new LspClient({
        command: this.command,
        args: this.args,
        workspaceDir: this.workspaceDir,
        requestTimeoutMs: REQUEST_TIMEOUT_MS,
      });
      this.client = client;
      this.initialization = this.handshake(client);
    }
    const ok = await this.initialization;
    return ok ? this.client : null;
  }

  private async handshake(client: LspClient): Promise<boolean> {
    try {
      await withTimeout(
        client.request("initialize", {
          processId: process.pid,
          rootUri: pathToFileURL(this.workspaceDir).href,
          capabilities: {
            textDocument: {
              synchronization: { dynamicRegistration: false },
              publishDiagnostics: { relatedInformation: false },
            },
          },
        }),
        INITIALIZE_TIMEOUT_MS,
      );
    } catch {
      return false; // spawn failure or a server that never answered initialize — degrade
    }
    client.notify("initialized", {});
    return client.status === "ready";
  }
}

/** Bound a promise; rejects if it doesn't settle in time (the handshake must not hang the run). */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("LSP handshake timed out")), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

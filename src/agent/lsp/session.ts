// SPDX-License-Identifier: Apache-2.0

// An LspSession is one language server, lazily started on first use and reused for the whole run.
// It owns the LSP HANDSHAKE (`initialize` with the workspace rootUri + our capabilities →
// `initialized` → push workspace settings) and DOCUMENT SYNC (didOpen / didChange), and exposes the
// two things the tools above it need: "sync this file and give me its diagnostics" and "sync this
// file and run an LSP request against it" (the navigation ops).
//
// Everything is best-effort + bounded. Initialization is attempted once (a second use after a
// failed/timed-out init does not re-spawn); a hung handshake degrades to "no diagnostics". A
// running file is reopened with its latest text and we wait (bounded) for the server to re-publish.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { LspClient, LspTimeoutError, type Diagnostic } from "./client.js";
import { languageIdForPath, type LanguageServer } from "./registry.js";

/** How long to wait for the `initialize` handshake before giving up on the server. */
const INITIALIZE_TIMEOUT_MS = 5_000;
/** Default per-request timeout (the handshake and shutdown). */
const REQUEST_TIMEOUT_MS = 5_000;
/** Deadline for a navigation query — longer, because a cold index makes the first one slow. */
const NAVIGATION_TIMEOUT_MS = 15_000;

/**
 * The outcome of one LSP request. `answered: false` means the server never replied — dead, or still
 * indexing past the deadline — which is NOT the same as replying "nothing found". Callers must keep
 * them apart: rendering a timeout as "no results" tells the loop a symbol is unreferenced when the
 * server simply wasn't ready yet, and the loop will believe it.
 */
export type LspRequestOutcome = { answered: true; result: unknown } | { answered: false };

const NOT_ANSWERED: LspRequestOutcome = { answered: false };

export interface LspSessionOptions {
  server: LanguageServer;
  workspaceDir: string;
  /** Override for tests; defaults to the registry server's command. */
  command?: string;
  args?: readonly string[];
  /** Override for tests; defaults to NAVIGATION_TIMEOUT_MS, too long to wait out in a unit test. */
  navigationTimeoutMs?: number;
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
  private readonly navigationTimeoutMs: number;
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
    this.navigationTimeoutMs = opts.navigationTimeoutMs ?? NAVIGATION_TIMEOUT_MS;
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

    const uri = this.sync(client, absolutePath);
    if (uri === null) return UNAVAILABLE; // the file vanished between write and sync

    await client.waitForDiagnostics(uri, diagnosticsWaitMs);
    return { available: true, diagnostics: client.diagnosticsFor(uri) };
  }

  /**
   * Sync `absolutePath` to the server, then issue an LSP request whose params are built from its
   * URI — the shape every navigation op takes (a server can only answer about a document it has been
   * told about).
   */
  async requestForFile(
    absolutePath: string,
    method: string,
    params: (uri: string) => unknown,
  ): Promise<LspRequestOutcome> {
    const client = await this.ensureInitialized();
    if (client === null || client.status !== "ready") return NOT_ANSWERED;
    const uri = this.sync(client, absolutePath);
    if (uri === null) return NOT_ANSWERED;
    return await this.send(client, method, params(uri));
  }

  /** Issue a workspace-scoped LSP request (no document involved — `workspace/symbol`). */
  async request(method: string, params: unknown): Promise<LspRequestOutcome> {
    const client = await this.ensureInitialized();
    if (client === null || client.status !== "ready") return NOT_ANSWERED;
    return await this.send(client, method, params);
  }

  /**
   * Issue one request on a NAVIGATION deadline, which is deliberately longer than the handshake's:
   * the first navigation query of a run lands while the server is still indexing the workspace, and
   * a 5s cut-off there would report "nothing found" for a symbol that plainly exists.
   *
   * A method the server doesn't implement answers with a JSON-RPC error, which is a real "no" and
   * so reports as answered-with-nothing; only a timeout or a dead transport is `answered: false`.
   */
  private async send(
    client: LspClient,
    method: string,
    params: unknown,
  ): Promise<LspRequestOutcome> {
    try {
      const result = await client.request(method, params, this.navigationTimeoutMs);
      return { answered: true, result };
    } catch (err) {
      if (err instanceof LspTimeoutError) return NOT_ANSWERED;
      return client.status === "ready" ? { answered: true, result: null } : NOT_ANSWERED;
    }
  }

  /**
   * Open the document on first sight, or push its current on-disk text on every sync after that.
   * Returns the document URI, or null when the file can't be read. Full-document sync (the simplest
   * TextDocumentSyncKind) — the versions map exists because LSP requires a monotonic version per URI.
   */
  private sync(client: LspClient, absolutePath: string): string | null {
    let text: string;
    try {
      text = readFileSync(absolutePath, "utf8");
    } catch {
      return null;
    }

    const uri = pathToFileURL(absolutePath).href;
    const previous = this.versions.get(uri);
    if (previous === undefined) {
      this.versions.set(uri, 1);
      client.notify("textDocument/didOpen", {
        textDocument: {
          uri,
          languageId: languageIdForPath(this.server, absolutePath),
          version: 1,
          text,
        },
      });
    } else {
      const version = previous + 1;
      this.versions.set(uri, version);
      client.notify("textDocument/didChange", {
        textDocument: { uri, version },
        contentChanges: [{ text }],
      });
    }
    return uri;
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
      // Computed once per session, not per module load: a setting like the Python interpreter path
      // is resolved off PATH, which is only meaningful in the process that will spawn the server.
      const settings = this.server.settings?.() ?? {};
      const client = new LspClient({
        command: this.command,
        args: this.args,
        workspaceDir: this.workspaceDir,
        requestTimeoutMs: REQUEST_TIMEOUT_MS,
        settings,
      });
      this.client = client;
      this.initialization = this.handshake(client, settings);
    }
    const ok = await this.initialization;
    return ok ? this.client : null;
  }

  private async handshake(client: LspClient, settings: Record<string, unknown>): Promise<boolean> {
    try {
      await withTimeout(
        client.request("initialize", {
          processId: process.pid,
          rootUri: pathToFileURL(this.workspaceDir).href,
          initializationOptions: { settings },
          capabilities: {
            textDocument: {
              synchronization: { dynamicRegistration: false },
              publishDiagnostics: { relatedInformation: false },
              // The navigation ops. `linkSupport` lets a server answer with LocationLink instead of
              // Location; the parser accepts both, so declaring it only widens what we understand.
              definition: { linkSupport: true },
              implementation: { linkSupport: true },
              references: { dynamicRegistration: false },
              hover: { contentFormat: ["markdown", "plaintext"] },
              documentSymbol: { hierarchicalDocumentSymbolSupport: true },
              callHierarchy: { dynamicRegistration: false },
            },
            workspace: {
              // `configuration: true` is what invites the server to ASK for settings; without it a
              // server may never send workspace/configuration and our answer would go unused.
              configuration: true,
              didChangeConfiguration: { dynamicRegistration: false },
              symbol: { dynamicRegistration: false },
            },
          },
        }),
        INITIALIZE_TIMEOUT_MS,
      );
    } catch {
      return false; // spawn failure or a server that never answered initialize — degrade
    }
    client.notify("initialized", {});
    // Push settings as well as answering pulls: servers split roughly evenly on which they honor,
    // and a server that ignores the push simply re-asks via workspace/configuration.
    client.notify("workspace/didChangeConfiguration", { settings });
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

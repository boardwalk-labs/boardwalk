// SPDX-License-Identifier: Apache-2.0

// The per-run LspService: it owns the language-server sessions for a run, picks the right server
// for a file's extension (the registry), lazy-starts a session on first relevant file, reuses it
// across the run, and shuts them all down at run end. The fs tools (diagnostics-after-edit) and the
// `diagnostics` built-in call through it.
//
// Engine-native + best-effort: a file the engine has no server for, or a server binary not on PATH,
// yields a clean `{ available: false }` (the tools render a short "no language server available"
// note) — never an error, never a hang. One service per run; close() leaks nothing.

import { LspSession } from "./session.js";
import type { Diagnostic } from "./client.js";
import { isCommandAvailable, serverForPath, type LanguageServer } from "./registry.js";

/** How long a single diagnostics query waits for the server to publish before returning the cache. */
export const DEFAULT_DIAGNOSTICS_WAIT_MS = 1_800;

export interface LspServiceOptions {
  workspaceDir: string;
  /**
   * Test seam: override how a session is built for a server. Production uses the default (spawn the
   * registry command). Tests inject a session backed by a mock stdio server.
   */
  createSession?: (server: LanguageServer, workspaceDir: string) => LspSession;
  /** Test seam: override the PATH availability check (default: resolve the command on PATH). */
  isAvailable?: (server: LanguageServer) => boolean;
}

/** What a diagnostics query reports for one file. */
export interface FileDiagnostics {
  /** False when no server handles the extension or its binary isn't installed (best-effort skip). */
  available: boolean;
  diagnostics: Diagnostic[];
}

const UNAVAILABLE: FileDiagnostics = { available: false, diagnostics: [] };

export class LspService {
  private readonly workspaceDir: string;
  private readonly createSession: (server: LanguageServer, workspaceDir: string) => LspSession;
  private readonly isAvailable: (server: LanguageServer) => boolean;
  /** One session per server id, lazily created. */
  private readonly sessions = new Map<string, LspSession>();
  /** Cached availability per server id — PATH doesn't change mid-run, so probe once. */
  private readonly availability = new Map<string, boolean>();
  private closed = false;

  constructor(opts: LspServiceOptions) {
    this.workspaceDir = opts.workspaceDir;
    this.createSession =
      opts.createSession ?? ((server, workspaceDir) => new LspSession({ server, workspaceDir }));
    this.isAvailable = opts.isAvailable ?? ((server) => isCommandAvailable(server.command));
  }

  /** Whether SOME registered, installed server can diagnose this file (no spawn — cheap to ask). */
  supports(absolutePath: string): boolean {
    const server = serverForPath(absolutePath);
    return server !== undefined && this.serverAvailable(server);
  }

  /**
   * Sync `absolutePath` to its language server and return the file's current diagnostics. Lazily
   * starts the session on first use; bounded wait for the server to publish. Returns
   * `{ available: false }` when no installed server handles the file (best-effort).
   */
  async diagnostics(
    absolutePath: string,
    waitMs = DEFAULT_DIAGNOSTICS_WAIT_MS,
  ): Promise<FileDiagnostics> {
    if (this.closed) return UNAVAILABLE;
    const server = serverForPath(absolutePath);
    if (server === undefined || !this.serverAvailable(server)) return UNAVAILABLE;
    const session = this.sessionFor(server);
    return await session.diagnostics(absolutePath, waitMs);
  }

  /**
   * Every file the file's language server currently reports diagnostics for (workspace-wide), as
   * file:// URIs — populated as files are synced. Empty when no session exists or none are installed.
   */
  filesWithDiagnostics(absolutePath: string): string[] {
    const server = serverForPath(absolutePath);
    if (server === undefined || !this.serverAvailable(server)) return [];
    return this.sessions.get(server.id)?.urisWithDiagnostics() ?? [];
  }

  /** Shut down every session. Idempotent, never throws — runs on the run's teardown path. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.all(
      [...this.sessions.values()].map((session) =>
        session.close().catch(() => {
          // Best-effort teardown: a session that won't close cleanly must not mask the run outcome.
        }),
      ),
    );
    this.sessions.clear();
  }

  private sessionFor(server: LanguageServer): LspSession {
    let session = this.sessions.get(server.id);
    if (session === undefined) {
      session = this.createSession(server, this.workspaceDir);
      this.sessions.set(server.id, session);
    }
    return session;
  }

  private serverAvailable(server: LanguageServer): boolean {
    let known = this.availability.get(server.id);
    if (known === undefined) {
      known = this.isAvailable(server);
      this.availability.set(server.id, known);
    }
    return known;
  }
}

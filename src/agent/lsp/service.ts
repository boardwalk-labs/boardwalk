// SPDX-License-Identifier: Apache-2.0

// The per-run LspService: it owns the language-server sessions for a run, picks the right server
// for a file's extension (the registry), lazy-starts a session on first relevant file, reuses it
// across the run, and shuts them all down at run end. The fs tools (diagnostics-after-edit) and the
// `diagnostics` + `navigate` built-ins call through it.
//
// Engine-native + best-effort: a file the engine has no server for, or a server binary not on PATH,
// yields a clean `{ available: false }` (the tools render a short "no language server available"
// note) — never an error, never a hang. One service per run; close() leaks nothing.
//
// Availability is the CALLER's gate: `supports()` answers it once, after which an empty navigation
// result means "the server found nothing", not "there is no server". That keeps the navigation
// methods free of a second unavailable-vs-empty signal nobody would read differently.

import { LspSession, type LspRequestOutcome } from "./session.js";
import type { Diagnostic } from "./client.js";
import { isCommandAvailable, serverForPath, type LanguageServer } from "./registry.js";
import {
  parseCallHierarchyItems,
  parseCalls,
  parseDocumentSymbols,
  parseHover,
  parseLocations,
  parseWorkspaceSymbols,
  type SourceLocation,
  type SymbolMatch,
} from "./navigation.js";

/** How long a single diagnostics query waits for the server to publish before returning the cache. */
export const DEFAULT_DIAGNOSTICS_WAIT_MS = 1_800;

/** The position-in, locations-out navigation queries, and the LSP method each maps to. */
export type LocationQuery = "definition" | "references" | "implementations";

const LOCATION_METHODS: Record<LocationQuery, string> = {
  definition: "textDocument/definition",
  references: "textDocument/references",
  implementations: "textDocument/implementation",
};

/** A 1-based cursor position, as tools and humans express it. LSP is 0-based; convert at the wire. */
export interface Position {
  line: number;
  character: number;
}

/**
 * A navigation answer. `answered: false` means the server never replied — not installed, dead, or
 * still indexing past the deadline — and is deliberately distinct from an answer of "nothing found",
 * so the tool can say "retry, it's still indexing" instead of reporting a symbol as unreferenced.
 */
export type NavigationResult<T> = { answered: true; value: T } | { answered: false };

const NOT_ANSWERED: NavigationResult<never> = { answered: false };

/** Apply a parser to an answered outcome, preserving the unanswered case. */
function map<T>(outcome: LspRequestOutcome, parse: (result: unknown) => T): NavigationResult<T> {
  return outcome.answered ? { answered: true, value: parse(outcome.result) } : NOT_ANSWERED;
}

function toWirePosition(position: Position): { line: number; character: number } {
  return { line: position.line - 1, character: position.character - 1 };
}

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
   * Resolve a position to source locations: where a symbol is defined, implemented, or referenced.
   * The three LSP methods share one shape (position in, locations out), so they share one entry
   * point rather than three near-identical wrappers.
   */
  async locations(
    absolutePath: string,
    kind: LocationQuery,
    position: Position,
  ): Promise<NavigationResult<SourceLocation[]>> {
    const outcome = await this.forFile(absolutePath, LOCATION_METHODS[kind], (uri) => ({
      textDocument: { uri },
      position: toWirePosition(position),
      // References default to including the declaration itself, which just echoes back the position
      // the caller already has. Callers asking "who uses this" want the other call sites.
      ...(kind === "references" ? { context: { includeDeclaration: false } } : {}),
    }));
    return map(outcome, parseLocations);
  }

  /** Type and documentation at a position, as plain text; a null value means the server had none. */
  async hover(absolutePath: string, position: Position): Promise<NavigationResult<string | null>> {
    const outcome = await this.forFile(absolutePath, "textDocument/hover", (uri) => ({
      textDocument: { uri },
      position: toWirePosition(position),
    }));
    return map(outcome, parseHover);
  }

  /** Every symbol declared in one file, flattened depth-first (a class is followed by its methods). */
  async documentSymbols(absolutePath: string): Promise<NavigationResult<SymbolMatch[]>> {
    const outcome = await this.forFile(absolutePath, "textDocument/documentSymbol", (uri) => ({
      textDocument: { uri },
    }));
    return map(outcome, (result) => parseDocumentSymbols(result, absolutePath));
  }

  /**
   * Search symbols by name across the workspace. `absolutePath` selects WHICH language server
   * answers — `workspace/symbol` is server-scoped, and asking every installed server would spawn
   * runtimes the run never otherwise needs.
   */
  async workspaceSymbols(
    absolutePath: string,
    query: string,
  ): Promise<NavigationResult<SymbolMatch[]>> {
    const session = this.sessionForPath(absolutePath);
    if (session === null) return NOT_ANSWERED;
    return map(await session.request("workspace/symbol", { query }), parseWorkspaceSymbols);
  }

  /**
   * Callers or callees of the function at a position. Two round trips by design: the LSP requires
   * resolving the position to a call-hierarchy item first, then querying edges from that item. A
   * position that resolves to no item is a real answer ("that isn't a callable"), not a failure.
   */
  async calls(
    absolutePath: string,
    position: Position,
    direction: "incoming" | "outgoing",
  ): Promise<NavigationResult<SymbolMatch[]>> {
    const prepared = await this.forFile(
      absolutePath,
      "textDocument/prepareCallHierarchy",
      (uri) => ({ textDocument: { uri }, position: toWirePosition(position) }),
    );
    if (!prepared.answered) return NOT_ANSWERED;
    const first = parseCallHierarchyItems(prepared.result)[0];
    if (first === undefined) return { answered: true, value: [] };

    const session = this.sessionForPath(absolutePath);
    if (session === null) return NOT_ANSWERED;
    const method =
      direction === "incoming" ? "callHierarchy/incomingCalls" : "callHierarchy/outgoingCalls";
    const calls = await session.request(method, { item: first.raw });
    return map(calls, (result) => parseCalls(result, direction));
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

  /** The session that owns a path, or null when no installed server handles it. Never spawns twice. */
  private sessionForPath(absolutePath: string): LspSession | null {
    if (this.closed) return null;
    const server = serverForPath(absolutePath);
    if (server === undefined || !this.serverAvailable(server)) return null;
    return this.sessionFor(server);
  }

  /** Sync a file to its server and issue a document-scoped request. */
  private async forFile(
    absolutePath: string,
    method: string,
    params: (uri: string) => unknown,
  ): Promise<LspRequestOutcome> {
    const session = this.sessionForPath(absolutePath);
    // Contextually typed as LspRequestOutcome, whose unanswered branch is the same shape as
    // NavigationResult's — the constant above belongs to the other union and can't stand in.
    if (session === null) return { answered: false };
    return await session.requestForFile(absolutePath, method, params);
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

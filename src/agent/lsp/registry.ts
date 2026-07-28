// SPDX-License-Identifier: Apache-2.0

// The pluggable extension → language-server registry. Code intelligence is ENGINE-NATIVE: the engine
// spawns a language server in the run's workspace the same way `bash` spawns a process, so it works
// wherever the server binary exists and needs no host backend. Today it ships TypeScript/JavaScript
// via `typescript-language-server --stdio` and Python via `pyright-langserver --stdio`; a new
// language is one entry here (a server id, its command + args, the extensions it owns, and any
// workspace settings it needs).
//
// Availability is BEST-EFFORT, exactly like grep's ripgrep→Node fallback: if the server binary is
// not on PATH, diagnostics and navigation are silently skipped (a clear "no language server
// available" note, never an error). We detect availability by resolving the command on PATH — no
// spawn, no probe.

import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

/** A language server the engine knows how to drive over stdio. */
export interface LanguageServer {
  /** Stable id, also the session key (one session per server per run). */
  id: string;
  /** The binary to spawn; resolved on PATH for the availability check. */
  command: string;
  /** Args that put the server in stdio mode. */
  args: readonly string[];
  /** Lowercased file extensions (with the dot) this server handles. */
  extensions: readonly string[];
  /** The LSP `languageId` for a given extension (textDocument.languageId on didOpen). */
  languageId(extension: string): string;
  /**
   * Workspace settings this server reads, keyed by LSP configuration section (`python`,
   * `typescript`, …). Sent as `initializationOptions.settings`, pushed after `initialized` via
   * `workspace/didChangeConfiguration`, and served back on `workspace/configuration` requests — the
   * three ways servers actually ask, since none of them is universally honored. Computed at session
   * start (not module load) because a value like the Python interpreter path is PATH-dependent.
   */
  settings?(): Record<string, unknown>;
}

/**
 * TypeScript/JavaScript via `typescript-language-server`. It speaks LSP over stdio and reports the
 * tsserver diagnostics — exactly the type/lint errors an autonomous coding agent needs to see the
 * moment it finishes an edit.
 */
const TYPESCRIPT_SERVER: LanguageServer = {
  id: "typescript",
  command: "typescript-language-server",
  args: ["--stdio"],
  extensions: [".ts", ".tsx", ".cts", ".mts", ".js", ".jsx", ".cjs", ".mjs"],
  languageId(extension: string): string {
    if (extension === ".tsx") return "typescriptreact";
    if (extension === ".jsx") return "javascriptreact";
    if (extension === ".js" || extension === ".cjs" || extension === ".mjs") return "javascript";
    return "typescript";
  },
};

/**
 * Python via `pyright-langserver` (the `pyright` npm package, so it needs only the Node already
 * under the engine).
 *
 * The interpreter matters more here than for any other server: pyright resolves imports against the
 * configured Python, and pointed at the wrong one it reports `reportMissingImports` for every
 * `import pandas`. That failure is WORSE than having no server, because diagnostics ride along on
 * every write/edit result — the loop would burn tokens being told correct code is broken. So we
 * resolve `python3` on PATH and hand pyright the answer. When no interpreter resolves we omit
 * `pythonPath` entirely and let pyright search for itself rather than assert a path we know is wrong.
 *
 * `diagnosticMode: "openFilesOnly"` (pyright's own default, pinned so a future flip can't surprise
 * us) keeps it to files the run actually touched instead of type-checking the whole workspace.
 */
const PYTHON_SERVER: LanguageServer = {
  id: "pyright",
  command: "pyright-langserver",
  args: ["--stdio"],
  extensions: [".py", ".pyi"],
  languageId(): string {
    return "python";
  },
  settings(): Record<string, unknown> {
    const interpreter = resolveOnPath("python3") ?? resolveOnPath("python");
    return {
      python: {
        ...(interpreter !== undefined ? { pythonPath: interpreter } : {}),
        analysis: {
          diagnosticMode: "openFilesOnly",
          typeCheckingMode: "basic",
          autoSearchPaths: true,
          useLibraryCodeForTypes: true,
        },
      },
    };
  },
};

/** Every registered server, in lookup order. Add a language by appending an entry here. */
export const LANGUAGE_SERVERS: readonly LanguageServer[] = [TYPESCRIPT_SERVER, PYTHON_SERVER];

/** The server that owns a file's extension, or undefined when no registered server handles it. */
export function serverForPath(filePath: string): LanguageServer | undefined {
  const ext = extensionOf(filePath);
  if (ext === null) return undefined;
  return LANGUAGE_SERVERS.find((server) => server.extensions.includes(ext));
}

/** The LSP languageId for a file path, given its owning server. */
export function languageIdForPath(server: LanguageServer, filePath: string): string {
  return server.languageId(extensionOf(filePath) ?? "");
}

/** Lowercased extension (including the dot) of a path, or null when it has none. */
function extensionOf(filePath: string): string | null {
  const slash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  const base = slash === -1 ? filePath : filePath.slice(slash + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return null; // no dot, or a leading dot (a dotfile has no extension)
  return base.slice(dot).toLowerCase();
}

/**
 * Whether a server's command resolves on PATH — the best-effort availability gate. Pure filesystem
 * lookup (no spawn); see resolveOnPath for the resolution rules.
 */
export function isCommandAvailable(command: string): boolean {
  return resolveOnPath(command) !== undefined;
}

/**
 * The absolute path a command resolves to on PATH, or undefined when it doesn't. Pure filesystem
 * lookup (no spawn): on POSIX, an executable file on a PATH entry; on Windows, also tried with the
 * PATHEXT suffixes. A command containing a separator is checked directly. Errors mean "unresolved".
 *
 * Exported because a server's settings can need a resolved SIBLING binary, not just its own — see
 * PYTHON_SERVER handing pyright the interpreter path.
 */
export function resolveOnPath(command: string): string | undefined {
  if (command.includes("/") || command.includes("\\")) {
    return isExecutable(command) ? command : undefined;
  }
  const pathDirs = (process.env["PATH"] ?? "").split(delimiter).filter((dir) => dir.length > 0);
  const suffixes = windowsExecutableSuffixes();
  for (const dir of pathDirs) {
    for (const suffix of suffixes) {
      const candidate = join(dir, command + suffix);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return undefined;
}

function isExecutable(path: string): boolean {
  try {
    // X_OK is meaningful on POSIX; on Windows it falls back to existence, which is what PATHEXT needs.
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** On Windows, a bare command name resolves through PATHEXT suffixes; elsewhere only the name itself. */
function windowsExecutableSuffixes(): string[] {
  if (process.platform !== "win32") return [""];
  const pathext = process.env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD";
  return ["", ...pathext.split(";").filter((ext) => ext.length > 0)];
}

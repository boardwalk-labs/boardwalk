// SPDX-License-Identifier: Apache-2.0

// The filesystem built-ins: read, write, edit, ls, grep, glob. All confined to the run's
// workspace via containedPath — a model-chosen path that escapes the workspace is a loud
// VALIDATION failure, never a silent clamp. grep prefers ripgrep (a fast system binary) and
// falls back to a Node recursive scan so `dev` works on a host without `rg` installed; nothing
// here pulls in a runtime dependency.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { EngineError } from "../../errors.js";
import type { ExecutableTool } from "../tools.js";
import { containedPath, workspaceRelative } from "./sandbox.js";

/**
 * Run a synchronous tool body but hand back a Promise (the ExecutableTool contract), turning a
 * synchronous validation throw into a rejected promise. The sandbox tools' work is sync `fs` —
 * this keeps them honest (a thrown error is awaited as a rejection) without an `async` body that
 * never awaits.
 */
function sync(fn: () => string): Promise<string> {
  try {
    return Promise.resolve(fn());
  } catch (err) {
    return Promise.reject(err instanceof Error ? err : new Error(String(err)));
  }
}

/** A long read/listing/search result is capped so one tool call can't flood model context. */
const MAX_GREP_MATCHES = 100;
const MAX_GLOB_RESULTS = 500;
const MAX_LS_ENTRIES = 1000;
/** Directories never worth scanning in grep/glob fallbacks — they bloat results and slow scans. */
const SKIP_DIRS = new Set([".git", "node_modules", ".venv", "__pycache__", "dist", ".cache"]);

export function readTool(workspaceDir: string): ExecutableTool {
  return {
    name: "read",
    description:
      "Read a UTF-8 text file from the workspace. Optional 1-based `offset` line and `limit` " +
      "line count return a slice of a large file.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative file path." },
        offset: { type: "number", description: "1-based first line to return (optional)." },
        limit: { type: "number", description: "Maximum number of lines to return (optional)." },
      },
      required: ["path"],
      additionalProperties: false,
    },
    execute: (input) =>
      sync(() => {
        const path = requireString(input, "path");
        const file = containedPath(workspaceDir, path);
        if (!existsSync(file) || statSync(file).isDirectory()) {
          throw new EngineError("VALIDATION", `read: no such file "${path}".`);
        }
        const content = readFileSync(file, "utf8");
        const offset = optionalPositiveInt(input["offset"], "offset");
        const limit = optionalPositiveInt(input["limit"], "limit");
        if (offset === undefined && limit === undefined) return content;
        const lines = content.split("\n");
        const start = (offset ?? 1) - 1;
        const end = limit === undefined ? lines.length : start + limit;
        return lines.slice(start, end).join("\n");
      }),
  };
}

export function writeTool(workspaceDir: string): ExecutableTool {
  return {
    name: "write",
    description:
      "Create or overwrite a UTF-8 text file in the workspace, creating parent directories as " +
      "needed. Use `edit` for targeted changes to an existing file.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative file path." },
        content: { type: "string", description: "The full file contents." },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    execute: (input) =>
      sync(() => {
        const path = requireString(input, "path");
        const content = requireString(input, "content");
        const file = containedPath(workspaceDir, path);
        if (existsSync(file) && statSync(file).isDirectory()) {
          throw new EngineError("VALIDATION", `write: "${path}" is a directory.`);
        }
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, content, "utf8");
        return `wrote ${path} (${String(content.length)} chars)`;
      }),
  };
}

export function editTool(workspaceDir: string): ExecutableTool {
  return {
    name: "edit",
    description:
      "Replace an exact string in a workspace file. By default `old` must appear EXACTLY ONCE " +
      "(an absent or ambiguous match fails); set `replaceAll: true` to replace every occurrence.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative file path." },
        old: { type: "string", description: "The exact text to replace." },
        new: { type: "string", description: "The replacement text." },
        replaceAll: {
          type: "boolean",
          description: "Replace every occurrence instead of requiring exactly one (default false).",
        },
      },
      required: ["path", "old", "new"],
      additionalProperties: false,
    },
    execute: (input) =>
      sync(() => {
        const path = requireString(input, "path");
        const oldText = requireString(input, "old");
        const newText = requireString(input, "new");
        const replaceAll = input["replaceAll"] === true;
        if (oldText === newText) {
          throw new EngineError(
            "VALIDATION",
            "edit: `old` and `new` are identical — nothing to do.",
          );
        }
        const file = containedPath(workspaceDir, path);
        if (!existsSync(file) || statSync(file).isDirectory()) {
          throw new EngineError("VALIDATION", `edit: no such file "${path}".`);
        }
        const content = readFileSync(file, "utf8");
        const count = occurrences(content, oldText);
        if (count === 0) {
          throw new EngineError("VALIDATION", `edit: \`old\` text was not found in "${path}".`);
        }
        if (count > 1 && !replaceAll) {
          throw new EngineError(
            "VALIDATION",
            `edit: \`old\` text appears ${String(count)} times in "${path}" — make it unique or pass replaceAll: true.`,
          );
        }
        const updated = replaceAll
          ? content.split(oldText).join(newText)
          : content.replace(oldText, newText);
        writeFileSync(file, updated, "utf8");
        return `edited ${path} (${String(replaceAll ? count : 1)} replacement${count === 1 ? "" : replaceAll ? "s" : ""})`;
      }),
  };
}

export function lsTool(workspaceDir: string): ExecutableTool {
  return {
    name: "ls",
    description:
      "List a workspace directory: each entry's name, whether it is a file or directory, and size.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Workspace-relative directory (defaults to the workspace root).",
        },
      },
      additionalProperties: false,
    },
    execute: (input) =>
      sync(() => {
        const rel = typeof input["path"] === "string" ? input["path"] : "";
        const dir = containedPath(workspaceDir, rel);
        if (!existsSync(dir) || !statSync(dir).isDirectory()) {
          throw new EngineError("VALIDATION", `ls: no such directory "${rel || "."}".`);
        }
        const entries = readdirSync(dir).sort().slice(0, MAX_LS_ENTRIES);
        const lines = entries.map((name) => {
          const full = join(dir, name);
          const st = statSync(full);
          return st.isDirectory() ? `${name}/  (dir)` : `${name}  (${String(st.size)} bytes)`;
        });
        return lines.length > 0 ? lines.join("\n") : "(empty directory)";
      }),
  };
}

export function grepTool(workspaceDir: string): ExecutableTool {
  return {
    name: "grep",
    description:
      "Search the workspace for a regular expression. Returns matching lines as `path:line:text`, " +
      `capped at ${String(MAX_GREP_MATCHES)} matches. Uses ripgrep when available, else a built-in scan.`,
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "The regular expression to search for." },
        path: {
          type: "string",
          description:
            "Workspace-relative directory or file to search (defaults to the workspace root).",
        },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    execute: async (input) => {
      const pattern = requireString(input, "pattern");
      const rel = typeof input["path"] === "string" ? input["path"] : "";
      const searchRoot = containedPath(workspaceDir, rel);
      if (!existsSync(searchRoot)) {
        throw new EngineError("VALIDATION", `grep: no such path "${rel || "."}".`);
      }
      const rgResult = await tryRipgrep(pattern, searchRoot, workspaceDir);
      const matches = rgResult ?? nodeGrep(pattern, searchRoot, workspaceDir);
      if (matches.length === 0) return "(no matches)";
      const shown = matches.slice(0, MAX_GREP_MATCHES);
      const note =
        matches.length > MAX_GREP_MATCHES
          ? `\n…[${String(matches.length - MAX_GREP_MATCHES)} more matches truncated]`
          : "";
      return shown.join("\n") + note;
    },
  };
}

export function globTool(workspaceDir: string): ExecutableTool {
  return {
    name: "glob",
    description:
      "Find workspace files matching a glob pattern (supports `*`, `**`, `?`). Returns " +
      `workspace-relative paths, capped at ${String(MAX_GLOB_RESULTS)}.`,
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: 'A glob pattern, e.g. "src/**/*.ts".' },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    execute: (input) =>
      sync(() => {
        const pattern = requireString(input, "pattern");
        const re = globToRegExp(pattern);
        const results: string[] = [];
        walk(workspaceDir, workspaceDir, (absPath) => {
          const rel = relative(workspaceDir, absPath);
          if (re.test(rel)) results.push(rel);
          return results.length < MAX_GLOB_RESULTS;
        });
        results.sort();
        if (results.length === 0) return "(no files matched)";
        const note =
          results.length >= MAX_GLOB_RESULTS
            ? `\n…[results capped at ${String(MAX_GLOB_RESULTS)}]`
            : "";
        return results.join("\n") + note;
      }),
  };
}

// ----------------------------------------------------------------------------
// grep backends
// ----------------------------------------------------------------------------

/** Run ripgrep if it is on PATH; null means rg is unavailable (caller falls back to the Node scan). */
async function tryRipgrep(
  pattern: string,
  searchRoot: string,
  workspaceDir: string,
): Promise<string[] | null> {
  return await new Promise<string[] | null>((resolvePromise) => {
    let child;
    try {
      child = spawn(
        "rg",
        ["--line-number", "--no-heading", "--color", "never", "--", pattern, searchRoot],
        {
          cwd: workspaceDir,
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
    } catch {
      resolvePromise(null);
      return;
    }
    let out = "";
    let failedToStart = false;
    child.on("error", () => {
      failedToStart = true;
      resolvePromise(null); // rg not installed → fall back
    });
    child.stdout.on("data", (chunk: Buffer) => {
      if (out.length < 1_000_000) out += chunk.toString();
    });
    child.on("close", (code) => {
      if (failedToStart) return;
      // rg exits 1 for "no matches" (not an error) and 2 for a real error; treat 2 as fall back.
      if (code === 2) {
        resolvePromise(null);
        return;
      }
      resolvePromise(rewriteRgPaths(out, workspaceDir));
    });
  });
}

/** Rewrite ripgrep's absolute paths to workspace-relative so output never leaks the data dir. */
function rewriteRgPaths(output: string, workspaceDir: string): string[] {
  const lines: string[] = [];
  for (const line of output.split("\n")) {
    if (line.length === 0) continue;
    // Format: <abs-path>:<line>:<text>. Split only the first two colons after the path.
    const firstColon = line.indexOf(":");
    if (firstColon === -1) {
      lines.push(line);
      continue;
    }
    const absPath = line.slice(0, firstColon);
    const rest = line.slice(firstColon);
    const rel = workspaceRelative(workspaceDir, absPath);
    lines.push(rel + rest);
  }
  return lines;
}

/** A dependency-free recursive grep — used when ripgrep isn't installed. */
function nodeGrep(pattern: string, searchRoot: string, workspaceDir: string): string[] {
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch (err) {
    throw new EngineError(
      "VALIDATION",
      `grep: invalid regular expression: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const matches: string[] = [];
  const search = (file: string): void => {
    let content: string;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      return; // binary/unreadable — skip
    }
    const rel = workspaceRelative(workspaceDir, file);
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (matches.length >= MAX_GREP_MATCHES * 4) return; // hard ceiling before truncation note
      if (re.test(lines[i] ?? "")) matches.push(`${rel}:${String(i + 1)}:${lines[i] ?? ""}`);
    }
  };
  if (statSync(searchRoot).isFile()) {
    search(searchRoot);
  } else {
    walk(searchRoot, workspaceDir, (absPath) => {
      if (statSync(absPath).isFile()) search(absPath);
      return matches.length < MAX_GREP_MATCHES * 4;
    });
  }
  return matches;
}

// ----------------------------------------------------------------------------
// Shared helpers
// ----------------------------------------------------------------------------

/** Depth-first walk of files under `dir`, skipping noise dirs. `visit` returns false to stop early. */
function walk(dir: string, workspaceDir: string, visit: (absPath: string) => boolean): boolean {
  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return true;
  }
  for (const name of entries) {
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue; // dangling symlink etc.
    }
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      if (!walk(full, workspaceDir, visit)) return false;
    } else if (st.isFile()) {
      if (!visit(full)) return false;
    }
  }
  return true;
}

/** Translate a glob (`*`, `**`, `?`) into an anchored RegExp over a workspace-relative path. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        // `**` matches across directory separators; consume an optional following slash.
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else if (ch !== undefined && /[.+^${}()|[\]\\]/.test(ch)) {
      re += "\\" + ch;
    } else {
      re += ch;
    }
  }
  return new RegExp(`^${re}$`);
}

function occurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    count++;
    from = idx + needle.length;
  }
  return count;
}

function requireString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string") {
    throw new EngineError("VALIDATION", `Tool input "${key}" must be a string.`);
  }
  return value;
}

function optionalPositiveInt(value: unknown, key: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new EngineError(
      "VALIDATION",
      `Tool input "${key}" must be a positive integer when provided.`,
    );
  }
  return value;
}

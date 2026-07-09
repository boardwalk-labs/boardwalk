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
import type { LspService } from "../lsp/index.js";
import { renderDiagnostics } from "../lsp/index.js";
import type { ExecutableTool, RichToolResult } from "../tools.js";
import { createUnifiedDiff } from "./diff.js";
import { capEventText, lineCount } from "./result.js";
import { containedPath, workspaceRelative } from "./sandbox.js";

/**
 * Run a synchronous tool body but hand back a Promise (the ExecutableTool contract), turning a
 * synchronous validation throw into a rejected promise. The sandbox tools' work is sync `fs` —
 * this keeps them honest (a thrown error is awaited as a rejection) without an `async` body that
 * never awaits.
 */
function sync<T>(fn: () => T): Promise<T> {
  try {
    return Promise.resolve(fn());
  } catch (err) {
    return Promise.reject(err instanceof Error ? err : new Error(String(err)));
  }
}

/**
 * Wrap a text-producing built-in (read/ls/grep/glob) as a structured result: the model sees the
 * full `output` (unchanged), observers get a capped copy plus `kind` + tool-specific `extra` fields.
 */
function outputResult(
  kind: string,
  humanSummary: string,
  output: string,
  extra: Record<string, unknown> = {},
): RichToolResult {
  const capped = capEventText(output);
  return {
    llmText: output,
    event: {
      kind,
      humanSummary,
      data: { ...extra, output: capped.text, truncated: capped.truncated },
    },
  };
}

/**
 * Wrap a write/edit as a structured `file_edit` result: the model sees `llmText` (the same summary +
 * diagnostics string as before), observers get a unified diff of the change plus +/- counts.
 */
function fileEditResult(
  path: string,
  before: string,
  after: string,
  llmText: string,
  opts: { created?: boolean } = {},
): RichToolResult {
  const { diff, additions, deletions } = createUnifiedDiff(before, after);
  const capped = capEventText(diff);
  const verb = opts.created === true ? "created" : "edited";
  return {
    llmText,
    event: {
      kind: "file_edit",
      humanSummary: `${verb} ${path} (+${String(additions)} -${String(deletions)})`,
      data: {
        path,
        diff: capped.text,
        diffTruncated: capped.truncated,
        additions,
        deletions,
        ...(opts.created === true ? { created: true } : {}),
      },
    },
  };
}

/** A long read/listing/search result is capped so one tool call can't flood model context. */
const MAX_GREP_MATCHES = 100;
const MAX_GLOB_RESULTS = 500;
const MAX_LS_ENTRIES = 1000;
/**
 * `read` returns at most this many lines when the caller gives no explicit `limit`, and at most
 * MAX_READ_CHARS characters regardless. A whole large file dumped into context is the single
 * biggest source of wasted tokens (and it then rides in context for the rest of the loop); the
 * model can page with `offset`/`limit` or locate with `grep`. The cap is applied at READ time, so
 * it never rewrites history — it is prompt-cache-safe, unlike retroactive pruning.
 */
const DEFAULT_READ_LINES = 2000;
const MAX_READ_CHARS = 100_000;
/** Directories never worth scanning in grep/glob fallbacks — they bloat results and slow scans. */
const SKIP_DIRS = new Set([".git", "node_modules", ".venv", "__pycache__", "dist", ".cache"]);

export function readTool(workspaceDir: string): ExecutableTool {
  return {
    name: "read",
    description:
      `Read a UTF-8 text file from the workspace. Returns at most ${String(DEFAULT_READ_LINES)} ` +
      "lines by default; pass 1-based `offset` and `limit` to page a large file (or `grep` to " +
      "locate the relevant span first).",
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
      sync((): RichToolResult => {
        const path = requireString(input, "path");
        const file = containedPath(workspaceDir, path);
        if (!existsSync(file) || statSync(file).isDirectory()) {
          throw new EngineError("VALIDATION", `read: no such file "${path}".`);
        }
        const whole = readFileSync(file, "utf8");
        const offset = optionalPositiveInt(input["offset"], "offset");
        const limit = optionalPositiveInt(input["limit"], "limit");
        const lines = whole.split("\n");
        const start = (offset ?? 1) - 1;
        // Cap the slice: an explicit `limit` is honored as-is; otherwise default to
        // DEFAULT_READ_LINES so a whole large file never floods context (an `offset` with no
        // `limit` still gets the default cap).
        const end = start + (limit ?? DEFAULT_READ_LINES);
        let content = lines.slice(start, end).join("\n");
        const notes: string[] = [];
        const remaining = lines.length - end;
        if (limit === undefined && remaining > 0) {
          notes.push(
            `${String(remaining)} more line${remaining === 1 ? "" : "s"} not shown — pass offset/limit to page, or grep to locate`,
          );
        }
        if (content.length > MAX_READ_CHARS) {
          content = content.slice(0, MAX_READ_CHARS);
          notes.push(`capped at ${String(MAX_READ_CHARS)} chars — pass offset/limit to page`);
        }
        const body = notes.length > 0 ? `${content}\n…[${notes.join("; ")}]` : content;
        return outputResult(
          "file_read",
          `read ${path} (${String(lineCount(content))} lines)`,
          body,
          {
            path,
          },
        );
      }),
  };
}

export function writeTool(workspaceDir: string, lsp?: LspService): ExecutableTool {
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
    execute: async (input): Promise<RichToolResult> => {
      const path = requireString(input, "path");
      const content = requireString(input, "content");
      const file = containedPath(workspaceDir, path);
      if (existsSync(file) && statSync(file).isDirectory()) {
        throw new EngineError("VALIDATION", `write: "${path}" is a directory.`);
      }
      const existed = existsSync(file);
      const before = existed ? readFileSync(file, "utf8") : "";
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content, "utf8");
      const summary = `wrote ${path} (${String(content.length)} chars)`;
      const llmText = summary + (await diagnosticsAfterWrite(lsp, file, path));
      return fileEditResult(path, before, content, llmText, { created: !existed });
    },
  };
}

export function editTool(workspaceDir: string, lsp?: LspService): ExecutableTool {
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
    execute: async (input) => {
      const path = requireString(input, "path");
      const oldText = requireString(input, "old");
      const newText = requireString(input, "new");
      const replaceAll = input["replaceAll"] === true;
      if (oldText === newText) {
        throw new EngineError("VALIDATION", "edit: `old` and `new` are identical — nothing to do.");
      }
      const file = containedPath(workspaceDir, path);
      if (!existsSync(file) || statSync(file).isDirectory()) {
        throw new EngineError("VALIDATION", `edit: no such file "${path}".`);
      }
      const content = readFileSync(file, "utf8");
      const count = occurrences(content, oldText);
      if (count === 0) {
        // Keep the match STRICT (never silently edit a near-match), but make the failure
        // self-correcting: flag an edit that looks already-applied, and point at the closest lines
        // in the file (the common whitespace/indent-drift case) as a HINT only.
        let hint =
          " It must match the file exactly, whitespace and all. The file may already have been " +
          "changed; re-read it for the current text before retrying.";
        if (newText.length > 0 && content.includes(newText)) {
          hint =
            " The `new` text is already present in the file — this edit looks like it was already " +
            "applied. Re-read the file to confirm before retrying.";
        } else {
          const similar = similarLineHints(content, oldText);
          if (similar.length > 0) hint += `\nClosest lines in the file:\n${similar.join("\n")}`;
        }
        throw new EngineError(
          "VALIDATION",
          `edit: \`old\` text was not found in "${path}".${hint}`,
        );
      }
      if (count > 1 && !replaceAll) {
        const lines = [...new Set(matchLineNumbers(content, oldText))].slice(0, 8);
        throw new EngineError(
          "VALIDATION",
          `edit: \`old\` text appears ${String(count)} times in "${path}" (lines ${lines.join(", ")}) — ` +
            "add surrounding context to make it unique, or pass replaceAll: true.",
        );
      }
      const updated = replaceAll
        ? content.split(oldText).join(newText)
        : content.replace(oldText, newText);
      writeFileSync(file, updated, "utf8");
      const summary = `edited ${path} (${String(replaceAll ? count : 1)} replacement${count === 1 ? "" : replaceAll ? "s" : ""})`;
      const llmText = summary + (await diagnosticsAfterWrite(lsp, file, path));
      return fileEditResult(path, content, updated, llmText);
    },
  };
}

/**
 * After a successful write/edit, append the file's language-server diagnostics so an autonomous
 * agent sees its mistakes immediately and self-corrects. BEST-EFFORT: no LspService, no installed
 * server for the file, or any failure → the plain write result, never an error and never a hang
 * (the LspService's own bounded wait caps the latency). The leading newline only appears when
 * there is something to report.
 */
async function diagnosticsAfterWrite(
  lsp: LspService | undefined,
  absolutePath: string,
  relativePath: string,
): Promise<string> {
  if (lsp === undefined || !lsp.supports(absolutePath)) return "";
  try {
    const result = await lsp.diagnostics(absolutePath);
    if (!result.available || result.diagnostics.length === 0) return "";
    return `\n\n${renderDiagnostics(relativePath, result.diagnostics)}`;
  } catch {
    return ""; // diagnostics are observability — a server hiccup must never fail the write
  }
}

export function lsTool(workspaceDir: string): ExecutableTool {
  return {
    name: "ls",
    description:
      "List a workspace directory (or several): each entry's name, whether it is a file or " +
      "directory, and size.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          description:
            "Workspace-relative director(ies) — a single path OR an array of paths. Defaults to " +
            "the workspace root.",
          anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
        },
      },
      additionalProperties: false,
    },
    execute: (input) =>
      sync((): RichToolResult => {
        const targets = resolvePaths(input, workspaceDir);
        const multi = targets.length > 1;
        const blocks: string[] = [];
        let total = 0;
        for (const { rel, abs } of targets) {
          if (!existsSync(abs) || !statSync(abs).isDirectory()) {
            throw new EngineError("VALIDATION", `ls: no such directory "${rel || "."}".`);
          }
          const entries = readdirSync(abs).sort().slice(0, MAX_LS_ENTRIES);
          total += entries.length;
          const lines = entries.map((name) => {
            const full = join(abs, name);
            const st = statSync(full);
            return st.isDirectory() ? `${name}/  (dir)` : `${name}  (${String(st.size)} bytes)`;
          });
          const body = lines.length > 0 ? lines.join("\n") : "(empty directory)";
          // Multiple dirs get a `path:` header each; a single dir stays byte-identical to before.
          blocks.push(multi ? `${rel || "."}:\n${body}` : body);
        }
        const label = multi
          ? `ls ${String(targets.length)} paths (${String(total)} entries)`
          : `ls ${targets[0]?.rel || "."} (${String(total)} entries)`;
        return outputResult("file_list", label, blocks.join("\n\n"), {
          path: targets.map((t) => t.rel || ".").join(", "),
        });
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
          description:
            "Workspace-relative director(ies) or file(s) to search — a single path OR an array of " +
            "paths. Defaults to the whole workspace.",
          anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
        },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    execute: async (input): Promise<RichToolResult> => {
      const pattern = requireString(input, "pattern");
      const targets = resolvePaths(input, workspaceDir);
      for (const { rel, abs } of targets) {
        if (!existsSync(abs)) {
          throw new EngineError(
            "VALIDATION",
            `grep: no such path "${rel || "."}". Pass a single path, or an array of paths to ` +
              "search several at once.",
          );
        }
      }
      const roots = targets.map((t) => t.abs);
      const rgResult = await tryRipgrep(pattern, roots, workspaceDir);
      const matches = rgResult ?? nodeGrep(pattern, roots, workspaceDir);
      const searched = targets.map((t) => t.rel).filter((rel) => rel !== "");
      const extra: Record<string, unknown> = {
        pattern,
        ...(searched.length > 0 ? { path: searched.join(", ") } : {}),
      };
      if (matches.length === 0) {
        return outputResult("search", `grep "${pattern}" (no matches)`, "(no matches)", extra);
      }
      const shown = matches.slice(0, MAX_GREP_MATCHES);
      const note =
        matches.length > MAX_GREP_MATCHES
          ? `\n…[${String(matches.length - MAX_GREP_MATCHES)} more matches truncated]`
          : "";
      return outputResult(
        "search",
        `grep "${pattern}" (${String(matches.length)} matches)`,
        shown.join("\n") + note,
        extra,
      );
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
      sync((): RichToolResult => {
        const pattern = requireString(input, "pattern");
        const re = globToRegExp(pattern);
        const results: string[] = [];
        walk(workspaceDir, workspaceDir, (absPath) => {
          const rel = relative(workspaceDir, absPath);
          if (re.test(rel)) results.push(rel);
          return results.length < MAX_GLOB_RESULTS;
        });
        results.sort();
        if (results.length === 0) {
          return outputResult("search", `glob "${pattern}" (no files)`, "(no files matched)", {
            pattern,
          });
        }
        const note =
          results.length >= MAX_GLOB_RESULTS
            ? `\n…[results capped at ${String(MAX_GLOB_RESULTS)}]`
            : "";
        return outputResult(
          "search",
          `glob "${pattern}" (${String(results.length)} files)`,
          results.join("\n") + note,
          { pattern },
        );
      }),
  };
}

// ----------------------------------------------------------------------------
// grep backends
// ----------------------------------------------------------------------------

/** Run ripgrep if it is on PATH; null means rg is unavailable (caller falls back to the Node scan). */
async function tryRipgrep(
  pattern: string,
  searchRoots: readonly string[],
  workspaceDir: string,
): Promise<string[] | null> {
  return await new Promise<string[] | null>((resolvePromise) => {
    let child;
    try {
      child = spawn(
        "rg",
        ["--line-number", "--no-heading", "--color", "never", "--", pattern, ...searchRoots],
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

/** A dependency-free recursive grep — used when ripgrep isn't installed. Scans every search root. */
function nodeGrep(pattern: string, searchRoots: readonly string[], workspaceDir: string): string[] {
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
  for (const searchRoot of searchRoots) {
    if (matches.length >= MAX_GREP_MATCHES * 4) break;
    if (statSync(searchRoot).isFile()) {
      search(searchRoot);
    } else {
      walk(searchRoot, workspaceDir, (absPath) => {
        if (statSync(absPath).isFile()) search(absPath);
        return matches.length < MAX_GREP_MATCHES * 4;
      });
    }
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

/** 1-based line numbers where `needle` begins in `haystack` (for an ambiguous-edit error). */
function matchLineNumbers(haystack: string, needle: string): number[] {
  if (needle.length === 0) return [];
  const nums: number[] = [];
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    // Line number = 1 + count of newlines before the match start.
    let line = 1;
    for (let i = 0; i < idx; i++) if (haystack[i] === "\n") line++;
    nums.push(line);
    from = idx + needle.length;
  }
  return nums;
}

/**
 * Up to `limit` file lines most similar to the first meaningful line of `oldText`, rendered as
 * "  L<n>: <text>" hints for a failed edit. Trimmed-exact matches win (the whitespace/indent-drift
 * case that most edits fail on); otherwise the closest by bigram similarity above a floor. This is a
 * HINT for the model's next attempt only — it is NEVER used to choose what actually gets edited.
 */
function similarLineHints(content: string, oldText: string, limit = 3): string[] {
  const target = oldText
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (target === undefined) return [];
  const lines = content.split("\n");
  const exact: string[] = [];
  for (let i = 0; i < lines.length && exact.length < limit; i++) {
    if ((lines[i] ?? "").trim() === target) exact.push(`  L${String(i + 1)}: ${lines[i] ?? ""}`);
  }
  if (exact.length > 0) return exact;
  return lines
    .map((line, i) => ({ i, line, score: diceCoefficient(target, line.trim()) }))
    .filter((s) => s.score >= 0.6)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => `  L${String(s.i + 1)}: ${s.line}`);
}

/** Sørensen–Dice similarity over character bigrams (0..1); dependency-free fuzzy string score. */
function diceCoefficient(a: string, b: string): number {
  if (a === b) return a.length === 0 ? 0 : 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigrams = (s: string): Map<string, number> => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const bg = s.slice(i, i + 2);
      m.set(bg, (m.get(bg) ?? 0) + 1);
    }
    return m;
  };
  const a2 = bigrams(a);
  const b2 = bigrams(b);
  let overlap = 0;
  for (const [bg, n] of a2) {
    const m = b2.get(bg);
    if (m !== undefined) overlap += Math.min(n, m);
  }
  return (2 * overlap) / (a.length - 1 + (b.length - 1));
}

function requireString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string") {
    throw new EngineError("VALIDATION", `Tool input "${key}" must be a string.`);
  }
  return value;
}

/**
 * Resolve a tool's `path` input — a single workspace-relative path OR an array of them — to a list
 * of `{ rel, abs }` pairs, each run through containedPath so the sandbox invariant holds for EVERY
 * entry (one escaping path in an array still fails loudly). Absent/empty ⇒ the workspace root. This
 * lets `grep`/`ls` accept the several paths a model naturally reaches for in one call instead of
 * failing when it passes more than one.
 */
function resolvePaths(
  input: Record<string, unknown>,
  workspaceDir: string,
): { rel: string; abs: string }[] {
  const raw: unknown = input["path"];
  let rels: string[];
  if (typeof raw === "string") {
    rels = [raw];
  } else if (Array.isArray(raw)) {
    rels = [];
    for (let i = 0; i < raw.length; i++) {
      const item: unknown = raw[i];
      if (typeof item !== "string") {
        throw new EngineError("VALIDATION", `Tool input "path[${String(i)}]" must be a string.`);
      }
      rels.push(item);
    }
  } else {
    rels = [""];
  }
  if (rels.length === 0) rels = [""];
  return rels.map((rel) => ({ rel, abs: containedPath(workspaceDir, rel) }));
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

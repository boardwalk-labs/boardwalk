// SPDX-License-Identifier: Apache-2.0

// The `bash` built-in: run a shell command in the run's workspace. This is a SECURITY BOUNDARY —
// the command text is model-chosen and runs autonomously (no human in the loop confirms it), so
// it is parsed and policy-checked BEFORE it ever reaches a shell, not sanitized after.
//
// The policy, in order:
//   1. Reject command substitution (`$(...)`, backticks, `<(...)`/`>(...)`) and I/O redirection
//      (`>`, `>>`, `<`, `2>`, `&>`, `2>&1`, heredocs `<<`). These are the allowlist-bypass
//      vectors: substitution smuggles a denied command inside an allowed one, redirection writes
//      outside the tool's intent. They are refused outright — the tool does not try to make them safe.
//   2. Split the command into segments on the shell control operators (`;`, `&&`, `||`, `|`, `&`)
//      AND on newlines (a newline separates commands to `/bin/sh -c`, so a second line must be
//      allowlist-checked too), quote-aware so a `;`/newline inside a string is not a separator.
//   3. Each segment's ROOT command (the first word, after leading `VAR=val` assignments) must be on
//      the allowlist; the denylist always wins (so `git`-allowed cannot smuggle `sudo`). An unknown
//      command fails the call with a clear message — the model picks another approach.
//
// The shell still runs (so allowed pipelines like `git log | head` work), but only after every
// segment passed the allowlist and no substitution/redirection was present. Output is captured
// separately (stdout/stderr), bounded by a byte cap and a wall-clock timeout.

import { spawn } from "node:child_process";
import { sep } from "node:path";
import { EngineError } from "../../errors.js";
import type { ExecutableTool, RichToolResult } from "../tools.js";
import { capEventText } from "./result.js";
import { containedPath } from "./sandbox.js";

/** Default per-call timeout; the model can lower it, never raise it past {@link MAX_TIMEOUT_MS}. */
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 600_000;
/** Output cap — a runaway command (e.g. `cat` of a huge file) can't flood the model context. */
const MAX_OUTPUT_BYTES = 64 * 1024;

/**
 * Root commands allowed to start a segment. A coding-agent set: VCS, the JS/Python toolchains,
 * read-only file inspection, text processing, and build/test runners. Anything not here is
 * refused — extend deliberately, never with a wildcard.
 */
export const DEFAULT_BASH_ALLOWLIST: ReadonlySet<string> = new Set([
  // version control + hosting
  "git",
  "gh",
  // JS/TS toolchain
  "node",
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "tsc",
  "vitest",
  "eslint",
  "prettier",
  // Python toolchain
  "python",
  "python3",
  "pip",
  "pip3",
  "pytest",
  "ruff",
  // build runners
  "make",
  "cargo",
  "go",
  // file inspection (read-only)
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "stat",
  "file",
  "realpath",
  "pwd",
  // search
  "grep",
  "rg",
  "find",
  "fd",
  // text processing
  "sed",
  "awk",
  "sort",
  "uniq",
  "cut",
  "tr",
  "diff",
  "patch",
  "jq",
  "basename",
  "dirname",
  // misc shell builtins-as-commands that are harmless and useful in pipelines
  "echo",
  "printf",
  "test",
  "which",
  "true",
  "false",
  "env",
  "date",
  "seq",
  "tee",
]);

/**
 * Commands refused even when an allowlist would permit them — the denylist always wins. Privilege
 * escalation, cloud control planes, and obviously destructive forms. (`rm`/`chmod` are not on the
 * allowlist at all; the patterns here catch them appearing as a root command anyway, e.g. via a
 * future allowlist edit, and catch the specific dangerous shapes.)
 */
const DENYLISTED_COMMANDS: ReadonlySet<string> = new Set([
  "sudo",
  "su",
  "doas",
  "aws",
  "gcloud",
  "az",
  "kubectl",
  "ssh",
  "scp",
  "curl",
  "wget",
  "nc",
  "ncat",
  "telnet",
  "dd",
  "mkfs",
  "shutdown",
  "reboot",
  "halt",
  "kill",
  "killall",
  "pkill",
  "eval",
  "exec",
  "source",
  ".",
  "chmod",
  "chown",
  "rm",
  "rmdir",
  "mv",
  "cp",
]);

interface ForbiddenPattern {
  re: RegExp;
  what: string;
}

/**
 * SUBSTITUTION patterns. In a POSIX shell these expand inside double quotes too — only single
 * quotes make them literal — so they are checked against text with ONLY single-quoted spans
 * stripped (double-quoted content is still scanned).
 */
const SUBSTITUTION_PATTERNS: readonly ForbiddenPattern[] = [
  { re: /\$\(/, what: "command substitution $(...)" },
  { re: /`/, what: "command substitution with backticks" },
  { re: /<\(/, what: "process substitution <(...)" },
  { re: />\(/, what: "process substitution >(...)" },
  { re: /\$\{[^}]*[^A-Za-z0-9_}][^}]*\}/, what: "parameter expansion with operators ${...}" },
];

/**
 * REDIRECTION patterns. The shell treats `<`/`>`/heredocs literally inside quotes (single OR
 * double), so these are checked against text with BOTH quote types stripped — that is what stops
 * an arrow function `() =>` or a string literal containing `>` from a false positive while still
 * catching a real `cmd > file`.
 */
const REDIRECTION_PATTERNS: readonly ForbiddenPattern[] = [
  { re: /<<</, what: "here-string <<<" },
  { re: /<</, what: "heredoc <<" },
  { re: /&>/, what: "output redirection &>" },
  { re: />>/, what: "output redirection >>" },
  { re: /\d*>&\d*/, what: "fd redirection >&" },
  { re: /\d+\s*>/, what: "fd redirection N>" },
  { re: /(^|[^0-9&])>/, what: "output redirection >" },
  { re: /(^|[^&0-9])<(?![(<])/, what: "input redirection <" },
];

/** Shell control operators that separate segments — quote-aware splitting respects these. Newlines
 *  (`\n`/`\r`) are separators too: `/bin/sh -c` runs each line as its own command, so every line's
 *  root command must clear the allowlist (otherwise `echo ok\nrm -rf ~` would slip past on `echo`). */
const SEGMENT_SEPARATORS = new Set([";", "&&", "||", "|", "&", "\n", "\r"]);

export interface BashToolOptions {
  workspaceDir: string;
  allowlist?: ReadonlySet<string>;
}

/** The `bash` built-in tool. Confined to the workspace; allowlist-gated; substitution/redirection refused. */
export function bashTool(options: BashToolOptions): ExecutableTool {
  const allowlist = options.allowlist ?? DEFAULT_BASH_ALLOWLIST;
  return {
    name: "bash",
    description:
      "Run a shell command in the run's workspace. Only a fixed set of commands is allowed " +
      "(git, gh, node, npm/pnpm, python, build/test runners, and read-only file/text tools); " +
      "command substitution, process substitution, and I/O redirection are rejected. Pipelines " +
      "of allowed commands are fine. stdout and stderr are returned separately.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to run." },
        cwd: {
          type: "string",
          description:
            "Optional workspace-relative working directory (defaults to the workspace root).",
        },
        timeoutMs: {
          type: "number",
          description: `Optional timeout in milliseconds (default ${String(DEFAULT_TIMEOUT_MS)}, max ${String(MAX_TIMEOUT_MS)}).`,
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
    execute: (input) => runBash(input, options.workspaceDir, allowlist),
  };
}

async function runBash(
  input: Record<string, unknown>,
  workspaceDir: string,
  allowlist: ReadonlySet<string>,
): Promise<RichToolResult> {
  const command = input["command"];
  if (typeof command !== "string" || command.trim().length === 0) {
    throw new EngineError("VALIDATION", "bash requires a non-empty `command` string.");
  }
  assertNoForbiddenConstructs(command);
  assertEverySegmentAllowed(command, allowlist);

  const cwd = resolveCwd(input["cwd"], workspaceDir);
  const timeoutMs = resolveTimeout(input["timeoutMs"]);
  const startedAt = Date.now();

  return await new Promise<RichToolResult>((resolvePromise, reject) => {
    const child = spawn("/bin/sh", ["-c", command], {
      cwd,
      // No stdin: a command that blocks on input must not hang the run (the timeout would catch it,
      // but closing stdin makes interactive reads return EOF immediately).
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = new BoundedBuffer(MAX_OUTPUT_BYTES);
    const stderr = new BoundedBuffer(MAX_OUTPUT_BYTES);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new EngineError("PROGRAM_ERROR", `bash failed to start: ${err.message}`));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(
          new EngineError(
            "PROGRAM_ERROR",
            `bash command timed out after ${String(timeoutMs)}ms and was killed.`,
          ),
        );
        return;
      }
      resolvePromise(
        buildBashResult(command, code, signal, stdout, stderr, Date.now() - startedAt),
      );
    });
  });
}

/** Assemble the structured result: the model sees the same formatted string as before; observers
 *  get stdout/stderr/exit/duration as data (each text field capped for the event stream). */
function buildBashResult(
  command: string,
  code: number | null,
  signal: NodeJS.Signals | null,
  stdout: BoundedBuffer,
  stderr: BoundedBuffer,
  durationMs: number,
): RichToolResult {
  const out = capEventText(stdout.text());
  const err = capEventText(stderr.text());
  const exit = signal !== null ? `signal ${signal}` : `exit ${String(code ?? 0)}`;
  return {
    llmText: formatResult(code, signal, stdout, stderr),
    event: {
      kind: "shell",
      humanSummary: `$ ${commandSummary(command)} → ${exit}`,
      data: {
        command,
        exitCode: code,
        signal,
        stdout: out.text,
        stderr: err.text,
        truncated: stdout.wasTruncated() || stderr.wasTruncated() || out.truncated || err.truncated,
        durationMs,
      },
    },
  };
}

/** First line of the command, shortened — for the one-line humanSummary. */
function commandSummary(command: string): string {
  const firstLine = command.split("\n")[0] ?? command;
  return firstLine.length <= 80 ? firstLine : `${firstLine.slice(0, 79)}…`;
}

function resolveCwd(raw: unknown, workspaceDir: string): string {
  if (raw === undefined || raw === null || raw === "") return workspaceDir;
  if (typeof raw !== "string") {
    throw new EngineError("VALIDATION", "bash `cwd` must be a string when provided.");
  }
  return containedPath(workspaceDir, raw);
}

function resolveTimeout(raw: unknown): number {
  if (raw === undefined || raw === null) return DEFAULT_TIMEOUT_MS;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    throw new EngineError("VALIDATION", "bash `timeoutMs` must be a positive number.");
  }
  return Math.min(Math.floor(raw), MAX_TIMEOUT_MS);
}

/** Refuse substitution + redirection before splitting — these are the allowlist-bypass vectors. */
export function assertNoForbiddenConstructs(command: string): void {
  // Substitution: scan with only single-quoted spans neutralized (double quotes don't disable it).
  const noSingle = stripQuoted(command, true, false);
  for (const { re, what } of SUBSTITUTION_PATTERNS) {
    if (re.test(noSingle)) throw forbidden(what);
  }
  // Redirection: scan with BOTH quote types neutralized (quotes make `<`/`>` literal in any shell).
  const noQuotes = stripQuoted(command, true, true);
  for (const { re, what } of REDIRECTION_PATTERNS) {
    if (re.test(noQuotes)) throw forbidden(what);
  }
}

function forbidden(what: string): EngineError {
  return new EngineError(
    "VALIDATION",
    `bash rejected ${what}: it can bypass the command allowlist. ` +
      `Run the commands separately, or have the program do file I/O via the write/edit tools.`,
  );
}

/** Every segment's root command must be allowlisted; the denylist wins. */
export function assertEverySegmentAllowed(command: string, allowlist: ReadonlySet<string>): void {
  for (const segment of splitSegments(command)) {
    const root = rootCommandOf(segment);
    if (root === null) continue; // empty segment (e.g. trailing `;`) — nothing to run
    const base = basename(root);
    if (DENYLISTED_COMMANDS.has(base) || DENYLISTED_COMMANDS.has(root)) {
      throw new EngineError(
        "VALIDATION",
        `bash refused the command "${base}": it is on the denylist (privilege escalation, ` +
          `network fetch, or destructive file ops are never allowed autonomously).`,
      );
    }
    if (!allowlist.has(base)) {
      throw new EngineError(
        "VALIDATION",
        `bash refused the command "${base}": it is not on the allowlist of permitted commands. ` +
          `Allowed roots include git, gh, node, npm/pnpm, python, and read-only file/text tools.`,
      );
    }
  }
}

/** The base name of a command path (`/usr/bin/git` → `git`), so an absolute path can't dodge the lists. */
function basename(command: string): string {
  const slash = command.lastIndexOf(sep);
  return slash === -1 ? command : command.slice(slash + 1);
}

/**
 * Split a command into segments on the unquoted control operators (`;`, `&&`, `||`, `|`, `&`).
 * Quote-aware: separators inside single or double quotes are literal. Returns the raw segment text.
 */
export function splitSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote !== null) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "\\") {
      // Backslash escapes the next char from being an operator; keep both verbatim.
      current += ch;
      if (i + 1 < command.length) {
        current += command[i + 1];
        i++;
      }
      continue;
    }
    const two = command.slice(i, i + 2);
    if (two === "&&" || two === "||") {
      segments.push(current);
      current = "";
      i++;
      continue;
    }
    if (ch !== undefined && SEGMENT_SEPARATORS.has(ch)) {
      segments.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments;
}

/**
 * The root command of a segment: the first bare word, after skipping leading `VAR=value`
 * assignments (which shells allow before a command). Quote-aware. Returns null for an empty segment.
 */
export function rootCommandOf(segment: string): string | null {
  for (const word of tokenizeWords(segment)) {
    if (isAssignment(word)) continue;
    return word;
  }
  return null;
}

/** A leading `VAR=value` assignment (not a command) — `=` before any of the word's other chars. */
function isAssignment(word: string): boolean {
  const eq = word.indexOf("=");
  if (eq <= 0) return false;
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(word.slice(0, eq));
}

/** Split a segment into shell words, quote-aware, stripping the surrounding quotes from each word. */
function tokenizeWords(segment: string): string[] {
  const words: string[] = [];
  let current = "";
  let started = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
      else current += ch;
      started = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (ch === "\\" && i + 1 < segment.length) {
      current += segment[i + 1];
      started = true;
      i++;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\n") {
      if (started) {
        words.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += ch;
    started = true;
  }
  if (started) words.push(current);
  return words;
}

/**
 * Replace the contents of quoted spans with spaces so they can't trip the forbidden-construct
 * patterns. Quote state is tracked correctly for BOTH types (inside `'…'` a `"` is literal and
 * vice-versa), but only the spans of the selected types are blanked: `neutralizeSingle` blanks
 * `'…'` spans, `neutralizeDouble` blanks `"…"` spans. A backslash escapes the next char.
 */
function stripQuoted(
  command: string,
  neutralizeSingle: boolean,
  neutralizeDouble: boolean,
): string {
  let out = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    const blanked = quote === "'" ? neutralizeSingle : quote === '"' ? neutralizeDouble : false;
    if (quote !== null) {
      out += blanked ? " " : (ch ?? "");
      if (ch === quote) {
        // The closing quote char itself: blank it if we blanked the span, else keep it.
        quote = null;
      }
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      out += ch + (command[i + 1] ?? "");
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      const willBlank = ch === "'" ? neutralizeSingle : neutralizeDouble;
      out += willBlank ? " " : ch;
      continue;
    }
    out += ch ?? "";
  }
  return out;
}

function formatResult(
  code: number | null,
  signal: NodeJS.Signals | null,
  stdout: BoundedBuffer,
  stderr: BoundedBuffer,
): string {
  const parts: string[] = [];
  const exit = signal !== null ? `signal ${signal}` : `exit code ${String(code ?? 0)}`;
  parts.push(`[${exit}]`);
  const out = stdout.text();
  const err = stderr.text();
  parts.push(`stdout:\n${out.length > 0 ? out : "(empty)"}${stdout.truncatedNote()}`);
  parts.push(`stderr:\n${err.length > 0 ? err : "(empty)"}${stderr.truncatedNote()}`);
  return parts.join("\n");
}

/** A byte-bounded accumulator — stops collecting past the cap and remembers it truncated. */
class BoundedBuffer {
  private readonly chunks: Buffer[] = [];
  private size = 0;
  private truncated = false;

  constructor(private readonly limit: number) {}

  push(chunk: Buffer): void {
    if (this.size >= this.limit) {
      this.truncated = true;
      return;
    }
    const room = this.limit - this.size;
    if (chunk.length > room) {
      this.chunks.push(chunk.subarray(0, room));
      this.size = this.limit;
      this.truncated = true;
    } else {
      this.chunks.push(chunk);
      this.size += chunk.length;
    }
  }

  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }

  wasTruncated(): boolean {
    return this.truncated;
  }

  truncatedNote(): string {
    return this.truncated ? `\n…[output truncated at ${String(this.limit)} bytes]` : "";
  }
}

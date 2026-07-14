// SPDX-License-Identifier: Apache-2.0

// The `apply_patch` built-in: apply a multi-file patch ATOMICALLY. Every file action and every
// hunk is parsed and validated against the current workspace contents BEFORE a single byte is
// written; if anything fails to validate (missing file, ambiguous/absent context, a target that
// already exists for an add, an escaping path), the WHOLE patch is rejected and the workspace is
// untouched. Partial application is never allowed — that is the entire point of this tool over a
// sequence of edits.
//
// The patch envelope (documented + validated strictly):
//
//   *** Begin Patch
//   *** Add File: path/to/new.ts
//   +line one
//   +line two
//   *** Update File: path/to/existing.ts
//   *** Move to: path/to/renamed.ts        (optional — present only for a rename)
//   @@ optional anchor text
//    context line (leading space)
//   -removed line
//   +added line
//    context line
//   *** Delete File: path/to/old.ts
//   *** End Patch
//
// Add: every body line is prefixed `+`; the file must NOT already exist.
// Update: standard unified-diff hunks (` ` context, `-` removed, `+` added) located by matching
//   the removed+context lines to a UNIQUE spot — exact, else tolerating trailing whitespace or a
//   uniform leading-indent shift (the replacement is re-indented to match); an optional
//   `*** Move to:` renames the file. Trailing text on the `@@` header (Codex-style
//   `@@ function name()`) is an optional ANCHOR — a line at or above the target — used only to
//   disambiguate a hunk that matches several spots; it narrows, it never guesses.
// Delete: the file must exist; it is removed.

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { EngineError } from "../../errors.js";
import type { ExecutableTool, RichToolResult } from "../tools.js";
import { createUnifiedDiff } from "./diff.js";
import { nearMissPathHint } from "./fs_tools.js";
import { capEventText } from "./result.js";
import { containedPath } from "./sandbox.js";

type FileAction =
  | { kind: "add"; path: string; content: string }
  | { kind: "delete"; path: string }
  | { kind: "update"; path: string; movePath: string | null; hunks: Hunk[] };

interface Hunk {
  /** Lines as they must appear in the source (context + removed), in order. */
  before: string[];
  /** Lines as they should appear after (context + added), in order. */
  after: string[];
  /** Optional anchor from the `@@` header's trailing text (Codex-style `@@ function name()`): a
   *  line ABOVE the target that scopes the match when the hunk alone is ambiguous. Null when the
   *  header is a bare `@@`. */
  anchor: string | null;
}

export function applyPatchTool(workspaceDir: string): ExecutableTool {
  return {
    name: "apply_patch",
    description:
      "Apply a multi-file patch atomically (all files validated before any write; partial " +
      "application never happens). Envelope: `*** Begin Patch` … `*** End Patch` with " +
      "`*** Add File:`, `*** Update File:` (unified-diff `@@` hunks, optional `*** Move to:`), " +
      "and `*** Delete File:` sections. Text after `@@` (e.g. `@@ function name()`) is an " +
      "optional anchor — a line at or above the target — that pins a hunk matching several spots.",
    inputSchema: {
      type: "object",
      properties: {
        patch: {
          type: "string",
          description: "The full patch text, including the Begin/End markers.",
        },
      },
      required: ["patch"],
      additionalProperties: false,
    },
    // The body is synchronous (parse → validate-all → commit); the wrapper turns any throw into a
    // rejected promise so the loop awaits failure as a rejection (and partial application is impossible).
    execute: (input): Promise<RichToolResult> => {
      try {
        const patch = input["patch"];
        if (typeof patch !== "string") {
          throw new EngineError("VALIDATION", "apply_patch requires a `patch` string.");
        }
        const actions = parsePatch(patch);
        // validates everything (throws on any problem) AND captures per-file before/after for diffs
        const { writes, edits } = planWrites(actions, workspaceDir);
        commitWrites(writes); // only reached when the whole patch validated
        return Promise.resolve(patchResult(actions, edits));
      } catch (err) {
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
    },
  };
}

/** One file's change in an apply_patch result — a unified diff plus counts, for observers. */
interface FileEdit {
  path: string;
  diff: string;
  diffTruncated: boolean;
  additions: number;
  deletions: number;
  created?: boolean;
  deleted?: boolean;
  movedTo?: string;
}

/** Assemble the structured result: the model sees the same summary string; observers get a
 *  per-file unified diff. The `data.files` array is deep-redacted by the leaf before it persists. */
function patchResult(actions: readonly FileAction[], edits: readonly FileEdit[]): RichToolResult {
  return {
    llmText: summarize(actions),
    event: {
      kind: "file_edit",
      humanSummary: `apply_patch: ${String(actions.length)} change${actions.length === 1 ? "" : "s"}`,
      data: { files: [...edits] },
    },
  };
}

/** Build a FileEdit from a before/after pair, capping the diff for the event stream. */
function fileEdit(
  path: string,
  before: string,
  after: string,
  extra: { created?: boolean; deleted?: boolean; movedTo?: string } = {},
): FileEdit {
  const { diff, additions, deletions } = createUnifiedDiff(before, after);
  const capped = capEventText(diff);
  return {
    path,
    diff: capped.text,
    diffTruncated: capped.truncated,
    additions,
    deletions,
    ...(extra.created === true ? { created: true } : {}),
    ...(extra.deleted === true ? { deleted: true } : {}),
    ...(extra.movedTo !== undefined ? { movedTo: extra.movedTo } : {}),
  };
}

// ----------------------------------------------------------------------------
// Parse
// ----------------------------------------------------------------------------

const BEGIN = "*** Begin Patch";
const END = "*** End Patch";
const ADD = "*** Add File: ";
const UPDATE = "*** Update File: ";
const DELETE = "*** Delete File: ";
const MOVE = "*** Move to: ";

/** Parse the envelope into typed file actions. Structural errors fail loudly here, pre-validation. */
export function parsePatch(patch: string): FileAction[] {
  const lines = patch.split("\n");
  // Tolerate a trailing empty line from a final newline.
  if (lines.at(-1) === "") lines.pop();
  if (lines[0]?.trim() !== BEGIN) {
    throw new EngineError("VALIDATION", `apply_patch: patch must start with "${BEGIN}".`);
  }
  if (lines.at(-1)?.trim() !== END) {
    throw new EngineError("VALIDATION", `apply_patch: patch must end with "${END}".`);
  }

  const actions: FileAction[] = [];
  let i = 1;
  const body = lines.slice(0, -1); // drop the END marker
  while (i < body.length) {
    const line = body[i] ?? "";
    if (line.startsWith(ADD)) {
      const path = line.slice(ADD.length).trim();
      const content: string[] = [];
      i++;
      while (i < body.length && !isActionHeader(body[i] ?? "")) {
        const l = body[i] ?? "";
        if (!l.startsWith("+")) {
          throw new EngineError(
            "VALIDATION",
            `apply_patch: every line of an added file must start with "+" (file "${path}").`,
          );
        }
        content.push(l.slice(1));
        i++;
      }
      actions.push({ kind: "add", path, content: content.join("\n") });
    } else if (line.startsWith(DELETE)) {
      actions.push({ kind: "delete", path: line.slice(DELETE.length).trim() });
      i++;
    } else if (line.startsWith(UPDATE)) {
      const path = line.slice(UPDATE.length).trim();
      i++;
      let movePath: string | null = null;
      if ((body[i] ?? "").startsWith(MOVE)) {
        movePath = (body[i] ?? "").slice(MOVE.length).trim();
        i++;
      }
      const hunks: Hunk[] = [];
      while (i < body.length && (body[i] ?? "").startsWith("@@")) {
        // Trailing text on the @@ header is an optional anchor scoping an ambiguous hunk.
        const anchorText = (body[i] ?? "").slice(2).trim();
        const anchor = anchorText.length > 0 ? anchorText : null;
        i++; // consume the @@ line
        const before: string[] = [];
        const after: string[] = [];
        while (
          i < body.length &&
          !isActionHeader(body[i] ?? "") &&
          !(body[i] ?? "").startsWith("@@")
        ) {
          const l = body[i] ?? "";
          const marker = l[0];
          const text = l.slice(1);
          if (marker === " " || l === "") {
            before.push(text);
            after.push(text);
          } else if (marker === "-") {
            before.push(text);
          } else if (marker === "+") {
            after.push(text);
          } else {
            throw new EngineError(
              "VALIDATION",
              `apply_patch: hunk line must start with " ", "-", or "+" (file "${path}"): ${JSON.stringify(l)}`,
            );
          }
          i++;
        }
        hunks.push({ before, after, anchor });
      }
      if (hunks.length === 0) {
        throw new EngineError("VALIDATION", `apply_patch: update of "${path}" has no @@ hunks.`);
      }
      actions.push({ kind: "update", path, movePath, hunks });
    } else if (line.trim() === "") {
      i++; // blank line between sections
    } else {
      throw new EngineError(
        "VALIDATION",
        `apply_patch: unexpected line outside a file section: ${JSON.stringify(line)}`,
      );
    }
  }
  if (actions.length === 0) {
    throw new EngineError("VALIDATION", "apply_patch: the patch declared no file actions.");
  }
  return actions;
}

function isActionHeader(line: string): boolean {
  return (
    line.startsWith(ADD) ||
    line.startsWith(UPDATE) ||
    line.startsWith(DELETE) ||
    line.startsWith(MOVE)
  );
}

// ----------------------------------------------------------------------------
// Validate + plan (no writes)
// ----------------------------------------------------------------------------

type Write = { kind: "write"; path: string; content: string } | { kind: "delete"; path: string };

/**
 * Turn validated actions into a flat write plan, AND capture each file's before/after so a unified
 * diff can be shown to observers. EVERYTHING is checked here against the live workspace; any failure
 * throws and no write has happened yet. Two actions touching the same path (e.g. update-then-delete)
 * are rejected — the patch should be unambiguous.
 */
function planWrites(
  actions: readonly FileAction[],
  workspaceDir: string,
): { writes: Write[]; edits: FileEdit[] } {
  const touched = new Set<string>();
  const writes: Write[] = [];
  const edits: FileEdit[] = [];
  const claim = (rel: string): void => {
    if (touched.has(rel)) {
      throw new EngineError(
        "VALIDATION",
        `apply_patch: path "${rel}" is touched by more than one action.`,
      );
    }
    touched.add(rel);
  };

  for (const action of actions) {
    const abs = containedPath(workspaceDir, action.path);
    if (action.kind === "add") {
      claim(action.path);
      if (existsSync(abs)) {
        throw new EngineError(
          "VALIDATION",
          `apply_patch: cannot add "${action.path}" — it already exists.`,
        );
      }
      writes.push({ kind: "write", path: abs, content: action.content });
      edits.push(fileEdit(action.path, "", action.content, { created: true }));
    } else if (action.kind === "delete") {
      claim(action.path);
      if (!existsSync(abs) || statSync(abs).isDirectory()) {
        throw new EngineError(
          "VALIDATION",
          `apply_patch: cannot delete "${action.path}" — no such file.` +
            nearMissPathHint(workspaceDir, action.path),
        );
      }
      writes.push({ kind: "delete", path: abs });
      edits.push(fileEdit(action.path, readFileSync(abs, "utf8"), "", { deleted: true }));
    } else {
      claim(action.path);
      if (!existsSync(abs) || statSync(abs).isDirectory()) {
        throw new EngineError(
          "VALIDATION",
          `apply_patch: cannot update "${action.path}" — no such file.` +
            nearMissPathHint(workspaceDir, action.path),
        );
      }
      const original = readFileSync(abs, "utf8");
      const updated = applyHunks(original, action.hunks, action.path);
      if (action.movePath !== null) {
        const moveAbs = containedPath(workspaceDir, action.movePath);
        claim(action.movePath);
        if (existsSync(moveAbs)) {
          throw new EngineError(
            "VALIDATION",
            `apply_patch: cannot move "${action.path}" to "${action.movePath}" — the target exists.`,
          );
        }
        writes.push({ kind: "delete", path: abs });
        writes.push({ kind: "write", path: moveAbs, content: updated });
        edits.push(fileEdit(action.path, original, updated, { movedTo: action.movePath }));
      } else {
        writes.push({ kind: "write", path: abs, content: updated });
        edits.push(fileEdit(action.path, original, updated));
      }
    }
  }
  return { writes, edits };
}

/** Apply each hunk by locating its `before` block exactly once in the (progressively updated) text. */
function applyHunks(original: string, hunks: readonly Hunk[], path: string): string {
  let lines = original.split("\n");
  for (const hunk of hunks) {
    const { at, reindent } = locate(lines, hunk, path);
    // reindent re-applies the file's actual indentation to the replacement when the hunk matched a
    // differently-indented block — so a whitespace-tolerant match never de-indents the result.
    const after = reindent(hunk.after);
    lines = [...lines.slice(0, at), ...after, ...lines.slice(at + hunk.before.length)];
  }
  return lines.join("\n");
}

/** A located hunk: the start index, and how to re-indent the replacement lines (identity unless a
 *  leading-whitespace-tolerant tier matched a differently-indented block). */
interface Located {
  at: number;
  reindent: (after: readonly string[]) => string[];
}

const asIs = (after: readonly string[]): string[] => [...after];

/** Count of leading SPACE characters (tabs are treated as content, so tab-indented code never
 *  matches the leading-offset tier — a safe fallback rather than a wrong-indent guess). */
function leadSpaces(line: string): number {
  const m = /^ */.exec(line);
  return m ? m[0].length : 0;
}

/** Start indices where `before` matches `lines` under `normalize` (every line equal once normalized). */
function findBlockMatches(
  lines: readonly string[],
  before: readonly string[],
  normalize: (line: string) => string,
): number[] {
  const norm = before.map(normalize);
  const matches: number[] = [];
  for (let i = 0; i + before.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < before.length; j++) {
      if (normalize(lines[i + j] ?? "") !== norm[j]) {
        ok = false;
        break;
      }
    }
    if (ok) matches.push(i);
  }
  return matches;
}

/**
 * Start indices where `before` matches `lines` ignoring a UNIFORM leading-indentation difference —
 * every line's content agrees (after trimming leading spaces + trailing whitespace) AND the file is
 * indented by the same delta on every line of the block. The uniform delta is returned so the
 * replacement can be re-indented to match, never de-indenting the result.
 */
function findLeadingOffsetMatches(
  lines: readonly string[],
  before: readonly string[],
): { at: number; delta: number }[] {
  const out: { at: number; delta: number }[] = [];
  for (let i = 0; i + before.length <= lines.length; i++) {
    let ok = true;
    let delta: number | null = null;
    for (let j = 0; j < before.length; j++) {
      const fLine = lines[i + j] ?? "";
      const bLine = before[j] ?? "";
      const fN = leadSpaces(fLine);
      const bN = leadSpaces(bLine);
      if (fLine.slice(fN).replace(/\s+$/, "") !== bLine.slice(bN).replace(/\s+$/, "")) {
        ok = false;
        break;
      }
      const d = fN - bN;
      if (delta === null) delta = d;
      else if (d !== delta) {
        ok = false; // indentation differs non-uniformly — not a safe re-indent
        break;
      }
    }
    // delta === 0 would be a pure trailing-whitespace match, already handled by an earlier tier.
    if (ok && delta !== null && delta !== 0) out.push({ at: i, delta });
  }
  return out;
}

/** Apply a uniform indent delta to a replacement line: prepend spaces (delta > 0) or drop up to
 *  |delta| leading spaces (delta < 0), so the replacement keeps the file's real indentation. */
function applyIndentDelta(line: string, delta: number): string {
  if (delta > 0) return " ".repeat(delta) + line;
  if (delta < 0) return line.slice(Math.min(-delta, leadSpaces(line)));
  return line;
}

function ambiguousHunkError(
  path: string,
  matches: readonly number[],
  anchor: string | null,
): EngineError {
  // Name the matching line numbers so the model can add the surrounding context that pins the one it
  // means — instead of guessing blindly and burning turns (or abandoning apply_patch for a slower
  // one-edit-per-call fallback).
  const nums = matches.map((i) => i + 1);
  const shown = nums.slice(0, 5).map(String).join(", ");
  const more = nums.length > 5 ? `, …(+${String(nums.length - 5)} more)` : "";
  const anchorAdvice =
    anchor === null
      ? "put an anchor on the @@ header — a unique line at or above the target, e.g. " +
        '"@@ function name()" —'
      : `the "@@ ${anchor}" anchor did not single one out; use a more specific anchor`;
  return new EngineError(
    "VALIDATION",
    `apply_patch: a hunk for "${path}" matched ${String(matches.length)} locations ` +
      `(lines ${shown}${more}) — ${anchorAdvice} or add enough surrounding context lines to the ` +
      "hunk to pin the one you mean.",
  );
}

/** 0-based indices of lines matching an `@@` anchor: trimmed-exact matches when any exist (the
 *  strongest signal), else substring matches (a model often anchors on a fragment of the line). */
function findAnchorLines(lines: readonly string[], anchor: string): number[] {
  const exact: number[] = [];
  const loose: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === anchor) exact.push(i);
    else if (line.includes(anchor)) loose.push(i);
  }
  return exact.length > 0 ? exact : loose;
}

/**
 * Disambiguate multiple hunk matches with the hunk's `@@` anchor: the anchor names a line at or
 * above the intended match, so each anchor occurrence claims the nearest match at/after itself.
 * Exactly one distinct claimed match wins; an absent anchor line or a still-ambiguous claim set
 * returns null and the caller fails loudly — the anchor narrows, it never guesses.
 */
function resolveWithAnchor(
  lines: readonly string[],
  matches: readonly number[],
  anchor: string,
): number | null {
  const anchorLines = findAnchorLines(lines, anchor);
  if (anchorLines.length === 0) return null;
  const claimed = new Set<number>();
  for (const anchorAt of anchorLines) {
    const match = matches.find((at) => at >= anchorAt);
    if (match !== undefined) claimed.add(match);
  }
  if (claimed.size !== 1) return null;
  return [...claimed][0] ?? null;
}

/**
 * Find where `before` matches. Tiers of increasing tolerance, each still requiring a UNIQUE match so
 * a tolerant tier never silently edits the wrong place: (1) exact, (2) ignore trailing whitespace,
 * (3) uniform leading-indent difference (with the replacement re-indented to match). Absent or
 * ambiguous is a loud failure. Matches how Codex/Aider/Cline apply patches — content-forgiving on
 * whitespace, never fuzzy on the actual text.
 */
function locate(lines: readonly string[], hunk: Hunk, path: string): Located {
  const { before, anchor } = hunk;
  if (before.length === 0) {
    throw new EngineError(
      "VALIDATION",
      `apply_patch: a hunk for "${path}" has no context or removed lines.`,
    );
  }
  // Multiple matches in a tier fall through to the hunk's `@@` anchor (when present) before failing.
  const disambiguate = (matches: readonly number[]): number => {
    const resolved = anchor === null ? null : resolveWithAnchor(lines, matches, anchor);
    if (resolved === null) throw ambiguousHunkError(path, matches, anchor);
    return resolved;
  };
  const tiers: ((line: string) => string)[] = [
    (line) => line, // exact
    (line) => line.replace(/[ \t]+$/, ""), // ignore trailing whitespace
  ];
  for (const normalize of tiers) {
    const matches = findBlockMatches(lines, before, normalize);
    if (matches.length === 1) return { at: matches[0] ?? 0, reindent: asIs };
    if (matches.length > 1) return { at: disambiguate(matches), reindent: asIs };
  }
  // Leading-indent-tolerant tier: re-indent the replacement by the matched uniform delta.
  const lead = findLeadingOffsetMatches(lines, before);
  if (lead.length === 1) {
    const { at, delta } = lead[0] ?? { at: 0, delta: 0 };
    return { at, reindent: (after) => after.map((l) => applyIndentDelta(l, delta)) };
  }
  if (lead.length > 1) {
    const at = disambiguate(lead.map((m) => m.at));
    const delta = lead.find((m) => m.at === at)?.delta ?? 0;
    return { at, reindent: (after) => after.map((l) => applyIndentDelta(l, delta)) };
  }

  throw new EngineError(
    "VALIDATION",
    `apply_patch: a hunk for "${path}" did not match the file's current contents — the context and ` +
      "removed lines must match (ignoring only indentation and surrounding whitespace), and the " +
      "file may already have been changed. Re-read it and rebuild the hunk from the current text.",
  );
}

// ----------------------------------------------------------------------------
// Commit (only after full validation)
// ----------------------------------------------------------------------------

function commitWrites(writes: readonly Write[]): void {
  for (const write of writes) {
    if (write.kind === "delete") {
      rmSync(write.path, { force: true });
    } else {
      mkdirSync(dirname(write.path), { recursive: true });
      writeFileSync(write.path, write.content, "utf8");
    }
  }
}

function summarize(actions: readonly FileAction[]): string {
  const parts = actions.map((a) =>
    a.kind === "update" && a.movePath !== null
      ? `moved ${a.path} → ${a.movePath}`
      : `${a.kind === "add" ? "added" : a.kind === "delete" ? "deleted" : "updated"} ${a.path}`,
  );
  return `apply_patch applied ${String(actions.length)} change${actions.length === 1 ? "" : "s"}:\n${parts.join("\n")}`;
}

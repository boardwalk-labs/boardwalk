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
//   @@
//    context line (leading space)
//   -removed line
//   +added line
//    context line
//   *** Delete File: path/to/old.ts
//   *** End Patch
//
// Add: every body line is prefixed `+`; the file must NOT already exist.
// Update: standard unified-diff hunks (` ` context, `-` removed, `+` added) located by matching
//   the removed+context lines exactly once; an optional `*** Move to:` renames the file.
// Delete: the file must exist; it is removed.

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { EngineError } from "../../errors.js";
import type { ExecutableTool } from "../tools.js";
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
}

export function applyPatchTool(workspaceDir: string): ExecutableTool {
  return {
    name: "apply_patch",
    description:
      "Apply a multi-file patch atomically (all files validated before any write; partial " +
      "application never happens). Envelope: `*** Begin Patch` … `*** End Patch` with " +
      "`*** Add File:`, `*** Update File:` (unified-diff `@@` hunks, optional `*** Move to:`), " +
      "and `*** Delete File:` sections.",
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
    execute: (input) => {
      try {
        const patch = input["patch"];
        if (typeof patch !== "string") {
          throw new EngineError("VALIDATION", "apply_patch requires a `patch` string.");
        }
        const actions = parsePatch(patch);
        const writes = planWrites(actions, workspaceDir); // validates everything; throws on any problem
        commitWrites(writes); // only reached when the whole patch validated
        return Promise.resolve(summarize(actions));
      } catch (err) {
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
    },
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
        hunks.push({ before, after });
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
 * Turn validated actions into a flat write plan. EVERYTHING is checked here against the live
 * workspace; any failure throws and no write has happened yet. Two actions touching the same path
 * (e.g. update-then-delete) are rejected — the patch should be unambiguous.
 */
function planWrites(actions: readonly FileAction[], workspaceDir: string): Write[] {
  const touched = new Set<string>();
  const writes: Write[] = [];
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
    } else if (action.kind === "delete") {
      claim(action.path);
      if (!existsSync(abs) || statSync(abs).isDirectory()) {
        throw new EngineError(
          "VALIDATION",
          `apply_patch: cannot delete "${action.path}" — no such file.`,
        );
      }
      writes.push({ kind: "delete", path: abs });
    } else {
      claim(action.path);
      if (!existsSync(abs) || statSync(abs).isDirectory()) {
        throw new EngineError(
          "VALIDATION",
          `apply_patch: cannot update "${action.path}" — no such file.`,
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
      } else {
        writes.push({ kind: "write", path: abs, content: updated });
      }
    }
  }
  return writes;
}

/** Apply each hunk by locating its `before` block exactly once in the (progressively updated) text. */
function applyHunks(original: string, hunks: readonly Hunk[], path: string): string {
  let lines = original.split("\n");
  for (const hunk of hunks) {
    const at = locate(lines, hunk.before, path);
    lines = [...lines.slice(0, at), ...hunk.after, ...lines.slice(at + hunk.before.length)];
  }
  return lines.join("\n");
}

/** Find the unique index where `before` matches; absent or ambiguous is a loud failure. */
function locate(lines: readonly string[], before: readonly string[], path: string): number {
  if (before.length === 0) {
    throw new EngineError(
      "VALIDATION",
      `apply_patch: a hunk for "${path}" has no context or removed lines.`,
    );
  }
  const matches: number[] = [];
  for (let i = 0; i + before.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < before.length; j++) {
      if (lines[i + j] !== before[j]) {
        ok = false;
        break;
      }
    }
    if (ok) matches.push(i);
  }
  if (matches.length === 0) {
    throw new EngineError(
      "VALIDATION",
      `apply_patch: a hunk for "${path}" did not match the file's current contents.`,
    );
  }
  if (matches.length > 1) {
    throw new EngineError(
      "VALIDATION",
      `apply_patch: a hunk for "${path}" matched ${String(matches.length)} locations — add more context to disambiguate.`,
    );
  }
  return matches[0] ?? 0;
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

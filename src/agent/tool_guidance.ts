// SPDX-License-Identifier: Apache-2.0

// The base tool-use preamble: a thin, GENERIC set of conventions prepended (most-general, FIRST) to
// every agent() leaf that has tools. It shapes HOW the model uses whatever tools it has — batch
// independent calls, edit precisely, verify, stop when done — with NO task- or domain-specific
// opinions (those belong in the author's AGENTS.md, which is concatenated AFTER this block and so
// overrides it). Deliberately short: the smallest set of high-signal instructions that move
// behavior, drawn from the convergent practice across OSS harnesses (Cline v4, Codex, Claude Code,
// OpenHands, Goose, Aider, OpenCode) — parallel tool calls, no wasteful re-reads, targeted edits,
// fully-implemented code, verify-with-evidence, and stop-when-done.
//
// Gated on the leaf actually HAVING tools — a pure-inference leaf (`builtins: "none"` with no inline
// tools) gets nothing. Individual lines are gated on the relevant tool being present, so the model
// is never told about a capability it doesn't have. Takes a minimal `{ name }` shape to avoid an
// import cycle with tools.ts.

const HEADER = "# Tool-use conventions";

/**
 * Build the base tool-use preamble for a leaf's resolved tool set, or "" when the leaf has no tools
 * (nothing to guide). Lines naming a specific tool are included only when that tool is present.
 */
export function buildToolUseGuidance(tools: readonly { name: string }[]): string {
  if (tools.length === 0) return "";
  const has = (name: string): boolean => tools.some((t) => t.name === name);
  const canEdit = has("edit") || has("apply_patch");
  const lines: string[] = [];

  // Parallelism — the highest-value line (unanimous across harnesses). A turn's tool calls dispatch
  // CONCURRENTLY here, so batching independent work is a real speedup; splitting it across turns is
  // pure waste (the "one edit per turn" failure mode).
  lines.push(
    "- Work in parallel: in a single response, issue ALL the tool calls whose inputs don't depend " +
      "on another call's result — reading several files, running independent checks, editing " +
      "different files. Only sequence calls that genuinely need a prior result.",
  );

  // Don't repeat work already in context.
  lines.push(
    "- Reuse what's already in context: don't re-read a file or re-run a command whose output you " +
      "already have." +
      (canEdit
        ? " In particular, don't re-read a file just to confirm an edit — the edit tools report " +
          "success and fail loudly, so a confirming re-read only burns tokens."
        : ""),
  );

  // Editing discipline — only when the leaf can modify files.
  if (canEdit || has("write")) {
    const parts = [
      "Make targeted changes — edit only the lines that must change rather than rewriting whole files.",
    ];
    if (has("apply_patch")) {
      parts.push("Use apply_patch to make several edits (across one or more files) in one call.");
    }
    if (has("edit")) {
      parts.push(
        "When matching by text, include enough surrounding context that the target is unique; the " +
          "match must be exact (whitespace included) or the edit is rejected.",
      );
    }
    parts.push(
      'Fully implement what you change — never leave a placeholder comment ("// ... unchanged") in ' +
        "place of real code.",
    );
    lines.push(`- ${parts.join(" ")}`);
  }

  // Verify — actionable only when the leaf can run things.
  if (has("bash")) {
    lines.push(
      "- Verify your work: after making changes, run the relevant tests / build / linter and read " +
        "the result before claiming success. Show the evidence rather than asserting it.",
    );
  }

  // Planning — only when the todo tool is present.
  if (has("todo")) {
    lines.push(
      "- For a task of roughly three or more steps, track it with the todo tool and keep it current " +
        "(one item in progress at a time); skip it for trivial single-step work.",
    );
  }

  // Stop + concision + cost — universal close.
  lines.push(
    "- Stop when the task is done and verified — don't keep exploring or gold-plating past what was " +
      "asked. Be concise; each tool call and turn has a real cost.",
  );

  return `${HEADER}\n${lines.join("\n")}`;
}

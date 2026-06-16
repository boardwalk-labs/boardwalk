// SPDX-License-Identifier: Apache-2.0

// A dependency-free, line-level unified diff — for showing run OBSERVERS (the web UI) what a file
// edit changed. The model never sees this; it is display-only, so it favors clarity + cheapness
// over minimality:
//   1. Trim the common prefix/suffix (the usual "edit in the middle of a big file" case) so the
//      expensive step runs only on the divergent middle.
//   2. Diff that middle by longest-common-subsequence, UNLESS it is large enough that the O(n·m)
//      table would be costly — then fall back to a coarse "delete all, add all" block.
//   3. Format standard unified-diff hunks (` `/`-`/`+` lines under `@@` headers). The file PATH is
//      carried alongside the result, not in the text, so a renderer labels the block itself.

export interface UnifiedDiff {
  /** Unified-diff hunk text (empty when `before === after`). */
  diff: string;
  additions: number;
  deletions: number;
}

/** Context lines kept around each change in a hunk. */
const CONTEXT = 3;
/** Above this LCS table size, skip the O(n·m) diff for a coarse block (display-only — never blocks). */
const MAX_DIFF_CELLS = 2_000_000;

interface Op {
  tag: " " | "-" | "+";
  text: string;
}

/** Build a unified diff between two file bodies. `before`/`after` are the whole file contents. */
export function createUnifiedDiff(before: string, after: string): UnifiedDiff {
  if (before === after) return { diff: "", additions: 0, deletions: 0 };
  const ops = diffOps(splitLines(before), splitLines(after));
  let additions = 0;
  let deletions = 0;
  for (const op of ops) {
    if (op.tag === "+") additions++;
    else if (op.tag === "-") deletions++;
  }
  return { diff: formatHunks(ops), additions, deletions };
}

/** Split into lines; an empty string is zero lines (not one empty line) so add/delete counts are exact. */
function splitLines(text: string): string[] {
  return text.length === 0 ? [] : text.split("\n");
}

/** Trim the common prefix/suffix to context, diff the divergent middle, reassemble. */
function diffOps(a: string[], b: string[]): Op[] {
  let lo = 0;
  while (lo < a.length && lo < b.length && a[lo] === b[lo]) lo++;
  let aHi = a.length;
  let bHi = b.length;
  while (aHi > lo && bHi > lo && a[aHi - 1] === b[bHi - 1]) {
    aHi--;
    bHi--;
  }

  const ops: Op[] = [];
  for (let i = 0; i < lo; i++) ops.push({ tag: " ", text: a[i] ?? "" });
  ops.push(...diffMiddle(a.slice(lo, aHi), b.slice(lo, bHi)));
  for (let i = aHi; i < a.length; i++) ops.push({ tag: " ", text: a[i] ?? "" });
  return ops;
}

function diffMiddle(a: string[], b: string[]): Op[] {
  if (a.length === 0) return b.map((text) => ({ tag: "+" as const, text }));
  if (b.length === 0) return a.map((text) => ({ tag: "-" as const, text }));
  if (a.length * b.length > MAX_DIFF_CELLS) {
    // Coarse fallback for a very large divergent region: delete-all then add-all (display-only).
    return [
      ...a.map((text) => ({ tag: "-" as const, text })),
      ...b.map((text) => ({ tag: "+" as const, text })),
    ];
  }
  return lcsDiff(a, b);
}

/** Longest-common-subsequence line diff over a flat DP table (no nested-array index churn). */
function lcsDiff(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const dp = new Array<number>((n + 1) * width).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] =
        a[i] === b[j]
          ? (dp[(i + 1) * width + (j + 1)] ?? 0) + 1
          : Math.max(dp[(i + 1) * width + j] ?? 0, dp[i * width + (j + 1)] ?? 0);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ tag: " ", text: a[i] ?? "" });
      i++;
      j++;
    } else if ((dp[(i + 1) * width + j] ?? 0) >= (dp[i * width + (j + 1)] ?? 0)) {
      ops.push({ tag: "-", text: a[i] ?? "" });
      i++;
    } else {
      ops.push({ tag: "+", text: b[j] ?? "" });
      j++;
    }
  }
  while (i < n) ops.push({ tag: "-", text: a[i++] ?? "" });
  while (j < m) ops.push({ tag: "+", text: b[j++] ?? "" });
  return ops;
}

/** Group ops into hunks (≤CONTEXT context lines per side, merged when context windows touch) with
 *  `@@ -old,count +new,count @@` headers. */
function formatHunks(ops: Op[]): string {
  // Old/new 1-based line number occupied by each op (for the hunk headers).
  const oldNo: number[] = [];
  const newNo: number[] = [];
  let oldLine = 0;
  let newLine = 0;
  for (const op of ops) {
    if (op.tag === " ") {
      oldLine++;
      newLine++;
    } else if (op.tag === "-") {
      oldLine++;
    } else {
      newLine++;
    }
    oldNo.push(oldLine);
    newNo.push(newLine);
  }

  const changes = ops.map((op, i) => (op.tag === " " ? -1 : i)).filter((i) => i >= 0);
  if (changes.length === 0) return "";

  // Split changes into groups whose ±CONTEXT windows don't overlap (a gap > 2·CONTEXT starts a new hunk).
  const groups: Array<{ first: number; last: number }> = [];
  let first = changes[0] ?? 0;
  let prev = first;
  for (const idx of changes.slice(1)) {
    if (idx - prev > 2 * CONTEXT + 1) {
      groups.push({ first, last: prev });
      first = idx;
    }
    prev = idx;
  }
  groups.push({ first, last: prev });

  const lines: string[] = [];
  for (const group of groups) {
    const s = Math.max(0, group.first - CONTEXT);
    const e = Math.min(ops.length - 1, group.last + CONTEXT);
    let oldCount = 0;
    let newCount = 0;
    for (let i = s; i <= e; i++) {
      const op = ops[i];
      if (op === undefined) continue;
      if (op.tag !== "+") oldCount++;
      if (op.tag !== "-") newCount++;
    }
    const oldStart = oldNo[s] ?? 0;
    const newStart = newNo[s] ?? 0;
    lines.push(
      `@@ -${String(oldStart)},${String(oldCount)} +${String(newStart)},${String(newCount)} @@`,
    );
    for (let i = s; i <= e; i++) {
      const op = ops[i];
      if (op !== undefined) lines.push(`${op.tag}${op.text}`);
    }
  }
  return lines.join("\n");
}

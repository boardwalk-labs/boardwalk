// SPDX-License-Identifier: Apache-2.0

// How diagnostics are rendered into model-bound tool text — shared by the diagnostics-after-edit
// append (fs_tools) and the `diagnostics` built-in tool so both speak the same compact format:
// `<severity> <path>:<line> <message> [<source>]`, capped so one query can't flood model context.

import type { Diagnostic } from "./client.js";

/** Cap on diagnostics rendered per file — a file with hundreds of errors can't flood the context. */
export const MAX_RENDERED_DIAGNOSTICS = 50;

/** Order errors first, then by line, so the most actionable diagnostics survive the cap. */
const SEVERITY_RANK: Record<Diagnostic["severity"], number> = {
  error: 0,
  warning: 1,
  information: 2,
  hint: 3,
};

/**
 * Render a file's diagnostics as lines. `path` is the workspace-relative path (never the absolute
 * data dir). Returns the rendered block plus a truncation note when the cap dropped any.
 */
export function renderDiagnostics(path: string, diagnostics: readonly Diagnostic[]): string {
  if (diagnostics.length === 0) return `No diagnostics for ${path}.`;
  const sorted = [...diagnostics].sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.line - b.line,
  );
  const shown = sorted.slice(0, MAX_RENDERED_DIAGNOSTICS);
  const lines = shown.map((d) => {
    const suffix = d.source !== undefined ? ` [${d.source}]` : "";
    return `${d.severity} ${path}:${String(d.line)} ${d.message}${suffix}`;
  });
  const counts = countBySeverity(diagnostics);
  const header = `${path}: ${counts}`;
  const note =
    diagnostics.length > MAX_RENDERED_DIAGNOSTICS
      ? `\n…[${String(diagnostics.length - MAX_RENDERED_DIAGNOSTICS)} more diagnostics truncated]`
      : "";
  return `${header}\n${lines.join("\n")}${note}`;
}

/** A one-line summary like "2 errors, 1 warning" for the header. */
function countBySeverity(diagnostics: readonly Diagnostic[]): string {
  let errors = 0;
  let warnings = 0;
  let other = 0;
  for (const d of diagnostics) {
    if (d.severity === "error") errors += 1;
    else if (d.severity === "warning") warnings += 1;
    else other += 1;
  }
  const parts: string[] = [];
  if (errors > 0) parts.push(plural(errors, "error"));
  if (warnings > 0) parts.push(plural(warnings, "warning"));
  if (other > 0) parts.push(plural(other, "diagnostic"));
  return parts.join(", ") || plural(diagnostics.length, "diagnostic");
}

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? "" : "s"}`;
}

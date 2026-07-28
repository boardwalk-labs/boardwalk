// SPDX-License-Identifier: Apache-2.0

// How language-server results are rendered into model-bound tool text — shared by the
// diagnostics-after-edit append (fs_tools), the `diagnostics` built-in, and the `navigate` built-in
// so they all speak one compact format. Diagnostics render as
// `<severity> <path>:<line> <message> [<source>]`; navigation results as `<path>:<line>:<col>  <text>`.
// Both are capped: a symbol with four hundred references must not flood model context.

import type { Diagnostic } from "./client.js";

/** Cap on diagnostics rendered per file — a file with hundreds of errors can't flood the context. */
export const MAX_RENDERED_DIAGNOSTICS = 50;

/** Cap on navigation results rendered per query, for the same reason. */
export const MAX_RENDERED_LOCATIONS = 50;

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

/** One navigation result: where it is, plus the text that explains what it is. */
export interface RenderedLocation {
  /** Workspace-relative path — never the absolute workspace root. */
  path: string;
  line: number;
  character: number;
  /**
   * The trailing column: a symbol's `kind name`, or the source line at a reference. Blank when the
   * file couldn't be read, which renders as a bare location rather than a dangling separator.
   */
  text?: string;
}

/**
 * Render navigation results as `<path>:<line>:<col>  <text>` under a summary header. The location
 * leads every line because that is what the model acts on next — it feeds straight back into `read`.
 */
export function renderLocations(summary: string, locations: readonly RenderedLocation[]): string {
  if (locations.length === 0) return `No results for ${summary}.`;
  const shown = locations.slice(0, MAX_RENDERED_LOCATIONS);
  const lines = shown.map((entry) => {
    const at = `${entry.path}:${String(entry.line)}:${String(entry.character)}`;
    return entry.text !== undefined && entry.text.length > 0 ? `${at}  ${entry.text}` : at;
  });
  const note =
    locations.length > MAX_RENDERED_LOCATIONS
      ? `\n…[${String(locations.length - MAX_RENDERED_LOCATIONS)} more results truncated]`
      : "";
  const header = `${plural(locations.length, "result")} for ${summary}:`;
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

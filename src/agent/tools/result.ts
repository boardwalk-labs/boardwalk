// SPDX-License-Identifier: Apache-2.0

// Helpers for the STRUCTURED tool result a built-in publishes to run observers (the web UI),
// distinct from the text the model sees. The model's copy of a tool's output is bounded by that
// tool's own limits; these caps protect the observer EVENT STREAM (Redis hot store + S3 archive)
// from a single huge result (e.g. `read` of a large file) bloating every frame.

/** Per-text-field cap for an observer event payload. ~500 lines of typical output; the model's
 *  copy is unaffected. Two-field results (shell stdout+stderr) stay comfortably frame-sized. */
export const MAX_EVENT_TEXT = 32_000;

/** Cap a text field for an observer event, flagging when it was shortened. */
export function capEventText(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_EVENT_TEXT) return { text, truncated: false };
  return { text: `${text.slice(0, MAX_EVENT_TEXT)}\n…[truncated]`, truncated: true };
}

/** Line count of a chunk of text (`""` → 0). */
export function lineCount(text: string): number {
  return text.length === 0 ? 0 : text.split("\n").length;
}

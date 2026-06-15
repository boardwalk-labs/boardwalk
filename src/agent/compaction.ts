// SPDX-License-Identifier: Apache-2.0

// Context-window compaction for the agent() loop. A long tool loop (or one fat tool result)
// grows `messages` without bound until the provider rejects the request; this is the safety
// valve. When the conversation's estimated size crosses a budget, the OLDEST middle is replaced
// with a single model-written summary, while the task framing and the most recent exchanges
// survive verbatim. The decision of WHAT to compress is the pure math below (planCompaction);
// the summarization model call lives in leaf.ts, which feeds the plan back through io.streamModel.
//
// Preservation rules (why each):
//  - The FIRST message is always kept verbatim — it carries the task, any skill preamble, and the
//    schema instruction; lose it and the agent forgets what it was asked to do.
//  - The most recent RECENT_TURNS_KEPT messages are kept verbatim — recent context must stay
//    intact for the model to make its next move; summarizing what just happened is lossy churn.
//  - A compression boundary never splits an assistant-with-toolCalls from its tool_results: a
//    dangling tool_use (results dropped) or orphaned tool_results would be a malformed request to
//    every provider. The range is snapped outward to a clean turn boundary.

import type { ChatMessage } from "./conversation.js";

/**
 * Default compaction budget, in CHARACTERS of serialized message text (see estimateChars).
 * Deliberately GENEROUS — at the ~4-chars-per-token heuristic this is roughly 150k tokens, so
 * normal runs and every conformance workflow stay far below it. Compaction is a last resort for
 * a genuinely long run, never routine behavior that could change a short run's observable shape.
 */
export const DEFAULT_COMPACTION_BUDGET_CHARS = 600_000;

/**
 * Newest messages kept verbatim past the summary. Six leaves room for the latest
 * assistant+tool_results pair (plus a little history) intact after a boundary snap; the snap can
 * only ever keep MORE, never fewer, so the latest exchange is always whole.
 */
export const RECENT_TURNS_KEPT = 6;

/** Per-message serialization overhead added to the char estimate (role tag, JSON punctuation). */
const PER_MESSAGE_OVERHEAD_CHARS = 16;

/** The contiguous, inclusive range of message indices to replace with one summary message. */
export interface CompactionPlan {
  /** First index to compress (always ≥ 1 — index 0, the task message, is never touched). */
  start: number;
  /** Last index to compress (inclusive). */
  end: number;
}

/**
 * Estimate a message's size in characters: its serialized text plus a small fixed overhead. The
 * provider has no token counter we can reach with zero deps, and char count tracks token count
 * closely enough for a guardrail (English ≈ 4 chars/token; JSON tool I/O runs denser, which only
 * makes us compact SOONER — the safe direction).
 */
export function estimateChars(message: ChatMessage): number {
  switch (message.role) {
    case "user":
      return message.text.length + PER_MESSAGE_OVERHEAD_CHARS;
    case "assistant": {
      let chars = message.text.length;
      for (const call of message.toolCalls) {
        chars += call.name.length + JSON.stringify(call.input).length;
      }
      return chars + PER_MESSAGE_OVERHEAD_CHARS;
    }
    case "tool_results": {
      let chars = 0;
      for (const result of message.results) chars += result.content.length;
      return chars + PER_MESSAGE_OVERHEAD_CHARS;
    }
  }
}

/** Total estimated size of a conversation, in characters. */
export function estimateConversationChars(messages: readonly ChatMessage[]): number {
  let total = 0;
  for (const message of messages) total += estimateChars(message);
  return total;
}

/**
 * Decide what (if anything) to compress so the conversation fits the budget, preserving the first
 * message and the most recent turns and never splitting a tool_use/tool_results pair.
 *
 * Returns `null` when the conversation is already within budget, OR when there is no compressible
 * middle (nothing sits between the preserved head and the preserved tail). A non-null plan's range
 * is always `1 ≤ start ≤ end ≤ messages.length - 1 - RECENT_TURNS_KEPT`-ish, snapped so:
 *  - it never includes index 0,
 *  - it leaves at least `recentKept` messages after it,
 *  - it does not END on an assistant-with-toolCalls (that would orphan the following results),
 *  - it does not START on a tool_results (that would orphan its preceding assistant).
 */
export function planCompaction(
  messages: readonly ChatMessage[],
  budgetChars: number = DEFAULT_COMPACTION_BUDGET_CHARS,
  recentKept: number = RECENT_TURNS_KEPT,
): CompactionPlan | null {
  if (estimateConversationChars(messages) <= budgetChars) return null;

  // The head (index 0) and the tail (last `recentKept`) are sacrosanct; the candidate middle is
  // everything in between. With nothing in between, there is nothing to compress.
  const tailStart = Math.max(1, messages.length - recentKept);
  let start = 1;
  let end = tailStart - 1;
  if (start > end) return null;

  // Snap the START forward off a tool_results: compressing it without its assistant would orphan
  // the results. (The assistant is at start-1; including the orphaned results alone is invalid.)
  while (start <= end && messages[start]?.role === "tool_results") start += 1;

  // Snap the END backward off an assistant-with-toolCalls: ending there drops the tool_results
  // that answer it, leaving a dangling tool_use the provider will reject. Pull the whole turn out
  // of the compressed range (its results stay in the verbatim tail).
  while (end >= start && isAssistantWithTools(messages[end])) end -= 1;

  if (start > end) return null;
  return { start, end };
}

function isAssistantWithTools(message: ChatMessage | undefined): boolean {
  return message?.role === "assistant" && message.toolCalls.length > 0;
}

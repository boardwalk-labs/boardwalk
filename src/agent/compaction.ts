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

import type { ChatMessage, ContentPart } from "./conversation.js";

/** Held back from the window: covers everything appended after a check passes — the turn's output
 *  plus its tool results (worst case a parallel `read` fan-out). What keeps a 200k model safe. */
export const CONTEXT_RESERVE_TOKENS = 64_000;

/** Budget when the window is unknown: no catalog (`boardwalk dev`, BYO), or turn 1 on a router lane. */
export const UNKNOWN_WINDOW_BUDGET_TOKENS = 150_000;

/** Share of a SMALL window the conversation may occupy, when the flat reserve won't fit inside it.
 *  Below a ~128k window the reserve becomes proportional rather than absolute. */
export const SMALL_WINDOW_BUDGET_FRACTION = 0.5;

/**
 * Tokens a conversation may reach before compacting: the model's window minus room for what lands
 * next.
 *
 * Scale with the window rather than fixing a number — compacting a 1M-capable run at a fixed 100k
 * discards context the model could simply have held, and pays a summary call to do it.
 *
 * The reserve is the flat {@link CONTEXT_RESERVE_TOKENS} where the window can spare it, and half the
 * window where it can't. A flat floor would exceed a small window outright (a 16k model would get a
 * 32k budget and never compact before the provider rejected the request); a reserve can only ever be
 * held back from room that exists.
 */
export function compactionBudget(contextTokens: number | undefined): number {
  if (contextTokens === undefined || !Number.isFinite(contextTokens) || contextTokens <= 0) {
    return UNKNOWN_WINDOW_BUDGET_TOKENS;
  }
  return Math.max(
    contextTokens - CONTEXT_RESERVE_TOKENS,
    Math.floor(contextTokens * SMALL_WINDOW_BUDGET_FRACTION),
  );
}

/**
 * Chars-per-token by content kind, measured against `o200k_base` (2026-07-15): English prose 4.02,
 * TypeScript source 4.13, JSON tool results 2.87. We keep two buckets rather than one flat number
 * because the difference between them is the whole bug this replaces.
 *
 * These are ESTIMATES for a guardrail, not a tokenizer — the engine takes no tokenizer dependency
 * (it would be per-provider wrong anyway). The loop calibrates them against the provider's OWN
 * reported input-token count after every turn (see leaf.ts), so a bad constant self-corrects.
 */
const CHARS_PER_TOKEN_TEXT = 4.0;
const CHARS_PER_TOKEN_JSON = 2.87;

/**
 * Newest messages kept verbatim past the summary. Six leaves room for the latest
 * assistant+tool_results pair (plus a little history) intact after a boundary snap; the snap can
 * only ever keep MORE, never fewer, so the latest exchange is always whole.
 */
export const RECENT_TURNS_KEPT = 6;

/** Per-message serialization overhead added to the token estimate (role tag, JSON punctuation). */
const PER_MESSAGE_OVERHEAD_TOKENS = 4;

/** Estimated TOKEN cost of a file part (image or document). A file has no character length but does
 *  occupy real model context (hundreds+ of vision/document tokens); count it as a fixed chunk so a
 *  file-heavy loop compacts SOONER, never later (the safe direction). */
const FILE_ESTIMATE_TOKENS = 1_500;

/** Token estimate for message content that may be a bare string or content parts (text + file).
 *  `charsPerToken` selects the density bucket — tool results are JSON-dense, prose is not. */
function contentTokens(content: string | readonly ContentPart[], charsPerToken: number): number {
  if (typeof content === "string") return content.length / charsPerToken;
  return content.reduce(
    (sum, part) =>
      sum + (part.type === "text" ? part.text.length / charsPerToken : FILE_ESTIMATE_TOKENS),
    0,
  );
}

/** The contiguous, inclusive range of message indices to replace with one summary message. */
export interface CompactionPlan {
  /** First index to compress (always ≥ 1 — index 0, the task message, is never touched). */
  start: number;
  /** Last index to compress (inclusive). */
  end: number;
}

/**
 * Estimate a message's size in TOKENS, bucketing by how the content actually tokenizes:
 *  - `user` prose and an assistant's natural-language text → CHARS_PER_TOKEN_TEXT
 *  - `tool_results` content and an assistant's serialized `toolCalls` → CHARS_PER_TOKEN_JSON
 *
 * The provider exposes no token counter we can reach without a (per-provider wrong) tokenizer
 * dependency, so this is a guardrail estimate. It is deliberately bucketed rather than flat: an
 * agent loop's bulk is JSON tool I/O, and treating that as prose is what let the old char budget
 * fire ~40% later than intended. The loop scales the result by a live calibration factor derived
 * from the provider's own reported usage (leaf.ts), so residual error self-corrects.
 */
export function estimateTokens(message: ChatMessage): number {
  switch (message.role) {
    case "user":
      return contentTokens(message.content, CHARS_PER_TOKEN_TEXT) + PER_MESSAGE_OVERHEAD_TOKENS;
    case "assistant": {
      // Natural-language text tokenizes as prose; the serialized tool-call inputs are JSON-dense.
      let tokens = message.text.length / CHARS_PER_TOKEN_TEXT;
      for (const call of message.toolCalls) {
        tokens += (call.name.length + JSON.stringify(call.input).length) / CHARS_PER_TOKEN_JSON;
      }
      return tokens + PER_MESSAGE_OVERHEAD_TOKENS;
    }
    case "tool_results": {
      let tokens = 0;
      for (const result of message.results) {
        tokens += contentTokens(result.content, CHARS_PER_TOKEN_JSON);
      }
      return tokens + PER_MESSAGE_OVERHEAD_TOKENS;
    }
  }
}

/** Total estimated size of a conversation, in tokens. */
export function estimateConversationTokens(messages: readonly ChatMessage[]): number {
  let total = 0;
  for (const message of messages) total += estimateTokens(message);
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
  budgetTokens: number = UNKNOWN_WINDOW_BUDGET_TOKENS,
  recentKept: number = RECENT_TURNS_KEPT,
): CompactionPlan | null {
  if (estimateConversationTokens(messages) <= budgetTokens) return null;

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

/**
 * Minimum estimated TOKENS a summary compaction must reclaim to be worth its own model call. Below
 * this, the cheap dedupe pass (or just proceeding) is preferable to paying for a summarization turn.
 * (Was 50_000 CHARS, which at the JSON density this file now models is ~17k tokens — 15k keeps the
 * same practical threshold while being expressed in the unit the budget is actually in.)
 */
export const MIN_COMPACTION_RECLAIM_TOKENS = 15_000;

/**
 * Replace all-but-the-newest `read` of each file path with a short pointer, IN PLACE, and return the
 * estimated chars reclaimed. Pure (NO model call): an agent that reads a file, edits it, and reads
 * again accumulates stale full-content copies, but only the latest reflects the current bytes — the
 * earlier ones are dead weight. This is the cheap first move when the conversation overflows; it
 * often drops the size back under budget without any summary call. It rewrites history (so it costs
 * prompt cache), which is why the leaf runs it only on overflow, in one pass — never per turn.
 *
 * Only `read` is deduped: write/edit/apply_patch results are diffs+summaries (already small), and
 * grep/ls/glob are searches, not file snapshots. The tool-call id on each result is matched back to
 * its `read` call's `path`; the result's structure (id/isError) is untouched, so the tool_use ↔
 * tool_result pairing every provider requires stays valid — only the `content` string shrinks.
 */
export function dedupeFileReads(messages: ChatMessage[]): number {
  // result.id → the read path, for `read` calls only (the tool that returns whole-file bytes).
  const readPathById = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const call of message.toolCalls) {
      const path = call.input["path"];
      if (call.name === "read" && typeof path === "string") readPathById.set(call.id, path);
    }
  }
  if (readPathById.size === 0) return 0;

  // Every read-result location (message index + result index), grouped by path, in order.
  const locsByPath = new Map<string, { mi: number; ri: number }[]>();
  messages.forEach((message, mi) => {
    if (message.role !== "tool_results") return;
    message.results.forEach((result, ri) => {
      const path = readPathById.get(result.id);
      if (path === undefined) return;
      const locs = locsByPath.get(path) ?? [];
      locs.push({ mi, ri });
      locsByPath.set(path, locs);
    });
  });

  let reclaimed = 0;
  for (const [path, locs] of locsByPath) {
    if (locs.length < 2) continue; // a single read of this file — nothing stale to drop
    // Keep the newest read verbatim; replace every earlier one with a pointer.
    for (const { mi, ri } of locs.slice(0, -1)) {
      const message = messages[mi];
      if (message?.role !== "tool_results") continue;
      const old = message.results[ri];
      if (old === undefined) continue;
      if (typeof old.content !== "string") continue; // a `read` result is always text; skip content parts
      const pointer = `[earlier read of "${path}" elided to save context — a newer read of this file appears later; re-read it if you need the current contents.]`;
      if (pointer.length >= old.content.length) continue; // never grow a result
      reclaimed += old.content.length - pointer.length;
      // results is readonly: rebuild the message with the one result's content swapped.
      const results = message.results.map((r, i) => (i === ri ? { ...r, content: pointer } : r));
      messages[mi] = { role: "tool_results", results };
    }
  }
  return reclaimed;
}

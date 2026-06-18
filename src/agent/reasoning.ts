// SPDX-License-Identifier: Apache-2.0

// Provider wire encoding for the neutral reasoning control (SDK `AgentOptions.reasoning`, already
// normalized to `NormalizedReasoning` by the SDK's `normalizeReasoning`). ONE neutral knob maps to
// three wire shapes — the same split the loop already has across its two-and-a-bit protocols:
//   - unified `reasoning` object (OpenAI-compatible) → the managed `boardwalk` lane.
//   - OpenAI `reasoning_effort` string               → a BYO OpenAI / OpenAI-compatible endpoint.
//   - Anthropic `thinking` token budget              → BYO Anthropic + Bedrock (the Messages schema).
//
// Pure functions (no fetch, no I/O), tested directly; the adapters in providers.ts / bedrock.ts call
// them, and the backend's hosted broker imports them (via core.ts) so both paths encode identically.

import type { NormalizedReasoning } from "@boardwalk-labs/workflow";

/**
 * Effort → fraction-of-max-tokens, the standard effort→budget normalization (used to DERIVE an
 * Anthropic token budget from an effort level, since Anthropic takes a budget, not an effort).
 * `none` is 0 — the caller reads that as "thinking off".
 */
const EFFORT_RATIOS: Record<string, number> = {
  none: 0,
  minimal: 0.1,
  low: 0.2,
  medium: 0.5,
  high: 0.8,
  xhigh: 0.95,
};

/** Anthropic's minimum thinking budget (the API floor). */
const MIN_THINKING_BUDGET = 1024;

/**
 * The unified `reasoning` object (OpenAI-compatible) for the managed lane. Pass-through of the
 * neutral fields (`effort` XOR `max_tokens`, plus `exclude`). Returns `undefined` when there is
 * nothing to send so the caller can omit the field entirely.
 */
export function reasoningToUnified(
  r: NormalizedReasoning | undefined,
): Record<string, unknown> | undefined {
  if (r === undefined) return undefined;
  const out: Record<string, unknown> = {};
  if (r.effort !== undefined) out.effort = r.effort;
  else if (typeof r.maxTokens === "number") out.max_tokens = r.maxTokens;
  if (r.exclude === true) out.exclude = true;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * OpenAI chat-completions `reasoning_effort` (a bare effort string). Only `effort` maps — a raw
 * `maxTokens` budget has no chat-completions equivalent, so it is dropped (the OpenAI surface only
 * accepts an effort level). Returns `undefined` when there is no effort to send.
 */
export function reasoningToOpenAiEffort(r: NormalizedReasoning | undefined): string | undefined {
  return r?.effort;
}

/** The Anthropic `thinking` directive plus the `max_tokens` the request must use so the cap stays
 *  strictly above the reasoning budget (the API requires `max_tokens > budget_tokens`). */
export interface AnthropicThinking {
  thinking: { type: "enabled"; budget_tokens: number };
  /** The `max_tokens` the request body should send (grown past the budget when necessary). */
  maxTokens: number;
}

/**
 * Anthropic Messages `thinking` block (BYO Anthropic + Bedrock). The Messages API takes a TOKEN
 * BUDGET, so an effort level is converted via {@link EFFORT_RATIOS} against the request's own
 * `max_tokens`; an explicit `maxTokens` is used directly. The budget is floored at the API minimum,
 * and `max_tokens` is grown when needed to stay above it. Returns `undefined` (thinking off) for
 * `effort: "none"` or when neither an effort nor a budget is given.
 */
export function reasoningToAnthropicThinking(
  r: NormalizedReasoning | undefined,
  requestMaxTokens: number,
): AnthropicThinking | undefined {
  if (r === undefined) return undefined;

  let budget: number | undefined;
  if (typeof r.maxTokens === "number") {
    budget = r.maxTokens;
  } else if (r.effort !== undefined && r.effort !== "none") {
    budget = Math.round(requestMaxTokens * (EFFORT_RATIOS[r.effort] ?? 0));
  }
  if (budget === undefined || budget <= 0) return undefined; // "none" / unset → no thinking

  budget = Math.max(MIN_THINKING_BUDGET, budget);
  // Anthropic rejects a request whose max_tokens is not strictly greater than budget_tokens; grow
  // the response cap past the budget (by the floor) when the chosen budget would otherwise meet it.
  const maxTokens = Math.max(requestMaxTokens, budget + MIN_THINKING_BUDGET);
  return { thinking: { type: "enabled", budget_tokens: budget }, maxTokens };
}

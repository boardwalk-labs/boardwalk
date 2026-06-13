// SPDX-License-Identifier: Apache-2.0

// The approximate token-price table behind budget.max_usd (SPEC §2.2: "USD via a bundled
// approximate rate table, documented as approximate").
//
// This is a GUARDRAIL, not a bill: the engine never charges anyone — it terminates a run that
// crosses the author's declared ceiling. Prices drift; entries here are deliberately coarse
// pattern matches with a conservative default, so an unknown model still consumes budget
// rather than running unmetered.

export interface TokenRate {
  /** USD per million input tokens. */
  inUsdPerMtok: number;
  /** USD per million output tokens. */
  outUsdPerMtok: number;
}

interface RateRule {
  /** Matched against the canonical `<provider>/<model-id>` ref, case-insensitive. */
  pattern: RegExp;
  rate: TokenRate;
}

// Order matters: first match wins, most-specific first.
const RULES: readonly RateRule[] = [
  { pattern: /claude-opus/i, rate: { inUsdPerMtok: 15, outUsdPerMtok: 75 } },
  { pattern: /claude-sonnet/i, rate: { inUsdPerMtok: 3, outUsdPerMtok: 15 } },
  { pattern: /claude-haiku/i, rate: { inUsdPerMtok: 1, outUsdPerMtok: 5 } },
  { pattern: /\bo[13](-|$)/i, rate: { inUsdPerMtok: 15, outUsdPerMtok: 60 } },
  { pattern: /gpt-4o-mini/i, rate: { inUsdPerMtok: 0.15, outUsdPerMtok: 0.6 } },
  { pattern: /gpt-4o|gpt-4\.1/i, rate: { inUsdPerMtok: 2.5, outUsdPerMtok: 10 } },
  { pattern: /gemini-.*-pro/i, rate: { inUsdPerMtok: 1.25, outUsdPerMtok: 10 } },
  { pattern: /gemini-.*-flash/i, rate: { inUsdPerMtok: 0.15, outUsdPerMtok: 0.6 } },
];

/** Why mid-tier: an unknown model priced at zero would make max_usd unenforceable. */
const DEFAULT_RATE: TokenRate = { inUsdPerMtok: 3, outUsdPerMtok: 15 };

/** The approximate rate for a model ref. Never returns zero — budgets must always accrue. */
export function rateFor(modelRef: string): TokenRate {
  for (const rule of RULES) {
    if (rule.pattern.test(modelRef)) return rule.rate;
  }
  return DEFAULT_RATE;
}

/** Approximate cost of a usage report in micro-USD (integers end-to-end; SQLite-friendly). */
export function usageUsdMicros(
  modelRef: string,
  usage: { inputTokens?: number | undefined; outputTokens?: number | undefined },
): number {
  const rate = rateFor(modelRef);
  const inUsd = ((usage.inputTokens ?? 0) / 1_000_000) * rate.inUsdPerMtok;
  const outUsd = ((usage.outputTokens ?? 0) / 1_000_000) * rate.outUsdPerMtok;
  return Math.round((inUsd + outUsd) * 1_000_000);
}

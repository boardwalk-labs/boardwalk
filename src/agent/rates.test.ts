import { describe, expect, it } from "vitest";
import { rateFor, usageUsdMicros } from "./rates.js";

describe("rateFor", () => {
  it("matches model families case-insensitively on the full ref", () => {
    expect(rateFor("anthropic/claude-sonnet-4-5")).toEqual({ inUsdPerMtok: 3, outUsdPerMtok: 15 });
    expect(rateFor("anthropic/Claude-Opus-4-8")).toEqual({ inUsdPerMtok: 15, outUsdPerMtok: 75 });
    expect(rateFor("openai/gpt-4o-mini")).toEqual({ inUsdPerMtok: 0.15, outUsdPerMtok: 0.6 });
    expect(rateFor("google/gemini-2.5-flash")).toEqual({ inUsdPerMtok: 0.15, outUsdPerMtok: 0.6 });
  });

  it("more specific patterns win (gpt-4o-mini is not billed as gpt-4o)", () => {
    expect(rateFor("openai/gpt-4o-mini").inUsdPerMtok).toBeLessThan(
      rateFor("openai/gpt-4o").inUsdPerMtok,
    );
  });

  it("unknown models get the non-zero default so budgets always accrue", () => {
    const rate = rateFor("ollama/llama3.3");
    expect(rate.inUsdPerMtok).toBeGreaterThan(0);
    expect(rate.outUsdPerMtok).toBeGreaterThan(0);
  });
});

describe("usageUsdMicros", () => {
  it("prices input and output at their own rates, in integer micro-USD", () => {
    // 1M in @ $3 + 1M out @ $15 = $18 = 18_000_000 µUSD
    expect(
      usageUsdMicros("anthropic/claude-sonnet-4-5", {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      }),
    ).toBe(18_000_000);
  });

  it("treats missing counts as zero", () => {
    expect(usageUsdMicros("anthropic/claude-sonnet-4-5", {})).toBe(0);
    expect(usageUsdMicros("anthropic/claude-sonnet-4-5", { outputTokens: 1000 })).toBe(15_000);
  });
});

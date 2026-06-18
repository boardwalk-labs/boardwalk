// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  reasoningToAnthropicThinking,
  reasoningToOpenAiEffort,
  reasoningToUnified,
} from "./reasoning.js";

describe("reasoningToUnified", () => {
  it("passes an effort through", () => {
    expect(reasoningToUnified({ effort: "high" })).toEqual({ effort: "high" });
    expect(reasoningToUnified({ effort: "xhigh" })).toEqual({ effort: "xhigh" });
    expect(reasoningToUnified({ effort: "none" })).toEqual({ effort: "none" });
  });

  it("maps a token budget to max_tokens", () => {
    expect(reasoningToUnified({ maxTokens: 2000 })).toEqual({ max_tokens: 2000 });
  });

  it("carries exclude alongside (and on its own)", () => {
    expect(reasoningToUnified({ effort: "high", exclude: true })).toEqual({
      effort: "high",
      exclude: true,
    });
    expect(reasoningToUnified({ exclude: true })).toEqual({ exclude: true });
  });

  it("is undefined for nothing to send", () => {
    expect(reasoningToUnified(undefined)).toBeUndefined();
    expect(reasoningToUnified({})).toBeUndefined();
  });
});

describe("reasoningToOpenAiEffort", () => {
  it("returns the bare effort string", () => {
    expect(reasoningToOpenAiEffort({ effort: "medium" })).toBe("medium");
  });

  it("drops a raw token budget (no chat-completions equivalent)", () => {
    expect(reasoningToOpenAiEffort({ maxTokens: 2000 })).toBeUndefined();
  });

  it("is undefined when absent", () => {
    expect(reasoningToOpenAiEffort(undefined)).toBeUndefined();
  });
});

describe("reasoningToAnthropicThinking", () => {
  it("is undefined for no reasoning and for effort:none", () => {
    expect(reasoningToAnthropicThinking(undefined, 8192)).toBeUndefined();
    expect(reasoningToAnthropicThinking({ effort: "none" }, 8192)).toBeUndefined();
  });

  it("derives a budget from effort as a fraction of max_tokens", () => {
    // high = 0.8 → round(8192 * 0.8) = 6554; max_tokens already exceeds it.
    expect(reasoningToAnthropicThinking({ effort: "high" }, 8192)).toEqual({
      thinking: { type: "enabled", budget_tokens: 6554 },
      maxTokens: 8192,
    });
  });

  it("floors a tiny derived budget to the API minimum (1024)", () => {
    // minimal = 0.1 → round(819.2) = 819 → floored to 1024.
    expect(reasoningToAnthropicThinking({ effort: "minimal" }, 8192)).toEqual({
      thinking: { type: "enabled", budget_tokens: 1024 },
      maxTokens: 8192,
    });
  });

  it("grows max_tokens to stay strictly above the budget (xhigh near the cap)", () => {
    // xhigh = 0.95 → round(7782.4) = 7782; max(8192, 7782 + 1024) = 8806.
    expect(reasoningToAnthropicThinking({ effort: "xhigh" }, 8192)).toEqual({
      thinking: { type: "enabled", budget_tokens: 7782 },
      maxTokens: 8806,
    });
  });

  it("uses an explicit maxTokens budget directly, growing the cap when it would exceed it", () => {
    expect(reasoningToAnthropicThinking({ maxTokens: 4096 }, 8192)).toEqual({
      thinking: { type: "enabled", budget_tokens: 4096 },
      maxTokens: 8192,
    });
    expect(reasoningToAnthropicThinking({ maxTokens: 10000 }, 8192)).toEqual({
      thinking: { type: "enabled", budget_tokens: 10000 },
      maxTokens: 11024,
    });
  });

  it("floors an explicit sub-minimum budget", () => {
    expect(reasoningToAnthropicThinking({ maxTokens: 500 }, 8192)).toEqual({
      thinking: { type: "enabled", budget_tokens: 1024 },
      maxTokens: 8192,
    });
  });
});

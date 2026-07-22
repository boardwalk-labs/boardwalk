// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  CONTEXT_RESERVE_TOKENS,
  SMALL_WINDOW_BUDGET_FRACTION,
  UNKNOWN_WINDOW_BUDGET_TOKENS,
  compactionBudget,
  dedupeFileReads,
  estimateConversationTokens,
  estimateTokens,
  planCompaction,
} from "./compaction.js";
import type { ChatMessage } from "./conversation.js";

const user = (text: string): ChatMessage => ({ role: "user", content: text });
const assistantText = (text: string): ChatMessage => ({ role: "assistant", text, toolCalls: [] });
const assistantCall = (id: string, name = "t"): ChatMessage => ({
  role: "assistant",
  text: "",
  toolCalls: [{ id, name, input: { x: 1 } }],
});
const toolResults = (id: string, content: string): ChatMessage => ({
  role: "tool_results",
  results: [{ id, content, isError: false }],
});

const FAT = "X".repeat(1000); // one message big enough to blow a small test budget

describe("estimateTokens", () => {
  const OVERHEAD = 4;

  it("counts prose at the text density plus a per-message overhead", () => {
    expect(estimateTokens(user("abcd"))).toBeCloseTo(4 / 4.0 + OVERHEAD, 5);
    expect(estimateTokens(assistantText("hi"))).toBeCloseTo(2 / 4.0 + OVERHEAD, 5);
  });

  it("counts tool results at the DENSER json density, not the prose one", () => {
    const body = "result-body";
    expect(estimateTokens(toolResults("c1", body))).toBeCloseTo(body.length / 2.87 + OVERHEAD, 5);
  });

  it("splits an assistant turn: prose text, json-dense tool-call input", () => {
    const call = assistantCall("c1", "lookup");
    const jsonChars = "lookup".length + JSON.stringify({ x: 1 }).length;
    expect(estimateTokens(call)).toBeCloseTo(0 / 4.0 + jsonChars / 2.87 + OVERHEAD, 5);
  });

  /**
   * The regression this whole change exists for. The old estimator treated every role as ~4
   * chars/token, so a tool-result-dominated conversation — i.e. every real agent loop — was
   * under-counted by ~40%, and the budget fired far later than intended (measured: a 600k-char
   * trigger was really ~209k tokens, past a 200k model's window).
   */
  it("does NOT under-count a tool-result-heavy conversation the way a flat 4.0 ratio would", () => {
    const body = "Y".repeat(100_000);
    const flatFourEstimate = body.length / 4.0;
    const actual = estimateTokens(toolResults("c1", body));
    expect(actual).toBeGreaterThan(flatFourEstimate * 1.3);
    expect(actual).toBeCloseTo(body.length / 2.87 + OVERHEAD, 0);
  });

  it("sums a whole conversation", () => {
    const msgs = [user("aaaa"), assistantText("bb")];
    expect(estimateConversationTokens(msgs)).toBeCloseTo(
      estimateTokens(msgs[0]!) + estimateTokens(msgs[1]!),
      5,
    );
  });
});

describe("planCompaction", () => {
  it("returns null when the conversation is within budget", () => {
    const msgs = [user("task"), assistantText("answer")];
    expect(planCompaction(msgs)).toBeNull();
    // The generous default budget never trips a small conversation.
    expect(estimateConversationTokens(msgs)).toBeLessThan(UNKNOWN_WINDOW_BUDGET_TOKENS);
  });

  it("returns null when over budget but there is no compressible middle", () => {
    const msgs = [user("task"), assistantText(FAT), ...range(6).map((i) => assistantText(`m${i}`))];
    // recentKept=6 ⇒ tail begins at index length-6, leaving index 1 as the lone candidate middle…
    expect(planCompaction(msgs, 100, 6)).toEqual({ start: 1, end: 1 });
    // …and with recentKept=7 the tail swallows index 1 too, so there is nothing to compress.
    expect(planCompaction(msgs, 100, 7)).toBeNull();
  });

  it("preserves the first message (start ≥ 1) and the most recent K (end < tail)", () => {
    const msgs = [
      user("task"),
      assistantText(FAT),
      ...range(6).map((i) => assistantText(`recent-${i}`)),
    ];
    const plan = planCompaction(msgs, 100, 6);
    expect(plan).not.toBeNull();
    expect(plan!.start).toBeGreaterThanOrEqual(1);
    expect(plan!.end).toBeLessThan(msgs.length - 6);
    expect(plan).toEqual({ start: 1, end: 1 });
  });

  it("never ENDS the range on an assistant-with-toolCalls (would orphan its results)", () => {
    const msgs = [
      user("task"),
      assistantText(FAT), // index 1
      assistantCall("c1"), // index 2 — the would-be end; pulling it keeps the tool_use whole
      toolResults("c1", "answer"), // index 3 (in the verbatim tail)
      assistantText("r1"),
      assistantText("r2"),
      assistantText("r3"),
    ];
    // recentKept=4 ⇒ tail = 3..6, candidate middle = 1..2; index 2 is assistant-with-tools → end
    // snaps back to 1.
    expect(planCompaction(msgs, 100, 4)).toEqual({ start: 1, end: 1 });
  });

  it("never STARTS the range on a tool_results (would orphan its assistant)", () => {
    const msgs = [
      user("task"),
      toolResults("c0", FAT), // index 1 — candidate start, but tool_results → snap forward
      ...range(5).map((i) => assistantText(`m${i}`)),
    ];
    const plan = planCompaction(msgs, 100, 3);
    expect(plan).not.toBeNull();
    expect(plan!.start).toBeGreaterThanOrEqual(2);
    expect(msgs[plan!.start]?.role).not.toBe("tool_results");
  });

  it("keeps an assistant+tool_results PAIR together inside the compressed range", () => {
    const msgs = [
      user("task"),
      assistantCall("c1"), // 1
      toolResults("c1", FAT), // 2
      assistantCall("c2"), // 3
      toolResults("c2", "more"), // 4
      assistantText("r1"),
      assistantText("r2"),
      assistantText("r3"),
      assistantText("r4"),
    ];
    // recentKept=4 ⇒ tail = 5..8, candidate middle = 1..4; both pairs are whole → clean range.
    const plan = planCompaction(msgs, 100, 4);
    expect(plan).toEqual({ start: 1, end: 4 });
    expect(msgs[plan!.start]?.role).toBe("assistant");
    expect(msgs[plan!.end]?.role).toBe("tool_results");
  });
});

describe("dedupeFileReads", () => {
  const readCall = (id: string, path: string): ChatMessage => ({
    role: "assistant",
    text: "",
    toolCalls: [{ id, name: "read", input: { path } }],
  });

  it("replaces all but the newest read of a path with a pointer, keeping the newest verbatim", () => {
    const msgs: ChatMessage[] = [
      user("task"),
      readCall("r1", "a.ts"),
      toolResults("r1", FAT),
      readCall("r2", "a.ts"),
      toolResults("r2", "NEWEST-CONTENT"),
    ];
    const reclaimed = dedupeFileReads(msgs);
    expect(reclaimed).toBeGreaterThan(0);
    const first = msgs[2];
    const second = msgs[4];
    expect(first?.role === "tool_results" && first.results[0]?.content).toContain(
      'earlier read of "a.ts" elided',
    );
    // The newest read is untouched; the result id/isError survive (tool_use ↔ tool_result intact).
    expect(second?.role === "tool_results" && second.results[0]?.content).toBe("NEWEST-CONTENT");
    expect(first?.role === "tool_results" && first.results[0]?.id).toBe("r1");
  });

  it("treats different paths independently and leaves a single read of a path alone", () => {
    const msgs: ChatMessage[] = [
      user("task"),
      readCall("r1", "a.ts"),
      toolResults("r1", FAT),
      readCall("r2", "b.ts"),
      toolResults("r2", FAT),
    ];
    expect(dedupeFileReads(msgs)).toBe(0); // one read each — nothing stale
    expect(msgs[2]?.role === "tool_results" && msgs[2].results[0]?.content).toBe(FAT);
  });

  it("only dedupes `read` — write/edit/grep results are left intact", () => {
    const editCall = (id: string, path: string): ChatMessage => ({
      role: "assistant",
      text: "",
      toolCalls: [{ id, name: "edit", input: { path } }],
    });
    const msgs: ChatMessage[] = [
      user("task"),
      editCall("e1", "a.ts"),
      toolResults("e1", FAT),
      editCall("e2", "a.ts"),
      toolResults("e2", FAT),
    ];
    expect(dedupeFileReads(msgs)).toBe(0);
  });

  it("never grows a result (a pointer longer than the original content is skipped)", () => {
    const msgs: ChatMessage[] = [
      user("task"),
      readCall("r1", "a.ts"),
      toolResults("r1", "tiny"), // shorter than the pointer → must be left as-is
      readCall("r2", "a.ts"),
      toolResults("r2", "also-newest"),
    ];
    expect(dedupeFileReads(msgs)).toBe(0);
    expect(msgs[2]?.role === "tool_results" && msgs[2].results[0]?.content).toBe("tiny");
  });
});

function range(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}

describe("compactionBudget", () => {
  /**
   * The rule: use the model's WINDOW minus a reserve. Claude Code — same workload shape — compacts a
   * 1M session at ~967k, not at a fixed low number. A flat budget would discard context a 1M model
   * could simply have held.
   */
  it("derives the budget from the window on the models we route to", () => {
    expect(compactionBudget(1_000_000)).toBe(1_000_000 - CONTEXT_RESERVE_TOKENS); // 936k
    expect(compactionBudget(200_000)).toBe(200_000 - CONTEXT_RESERVE_TOKENS); // Haiku 4.5 → 136k
    expect(compactionBudget(400_000)).toBe(400_000 - CONTEXT_RESERVE_TOKENS);
  });

  it("keeps a 1M model near its window rather than at a fixed low budget", () => {
    expect(compactionBudget(1_000_000)).toBeGreaterThan(900_000);
  });

  it("always reserves room for the turn that lands after the check passes", () => {
    for (const window of [200_000, 400_000, 1_000_000]) {
      expect(window - compactionBudget(window)).toBeGreaterThanOrEqual(CONTEXT_RESERVE_TOKENS);
    }
  });

  /**
   * THE invariant. A budget at or above the window can never fire in time: the loop checks, decides
   * it is in budget, appends a turn, and the provider rejects the request -- the run dies of the
   * exact overflow this guardrail exists to prevent. A flat floor did this to every model below a
   * ~32k window (16k model -> 32k budget, twice its window). Reserve room that EXISTS.
   */
  it("never budgets past the window, at any window size", () => {
    const windows = [
      1_000, 4_095, 8_192, 16_384, 32_768, 65_536, 96_000, 128_000, 200_000, 1_000_000,
    ];
    for (const window of windows) {
      const budget = compactionBudget(window);
      expect(budget).toBeLessThan(window);
      // Room left is never a rounding sliver: the flat reserve, or half the window when the window
      // can't spare that much.
      const roomOwed = Math.min(CONTEXT_RESERVE_TOKENS, Math.floor(window * 0.5));
      expect(window - budget).toBeGreaterThanOrEqual(roomOwed);
    }
  });

  it("holds back HALF a window too small to spare the flat reserve", () => {
    // 16k model: 16_384 - 64_000 is negative, so the proportional reserve takes over.
    expect(compactionBudget(16_384)).toBe(Math.floor(16_384 * SMALL_WINDOW_BUDGET_FRACTION));
    expect(compactionBudget(32_768)).toBe(16_384);
    expect(compactionBudget(4_095)).toBe(2_047);
  });

  it("crosses over from proportional to flat reserve at 2x the reserve", () => {
    // Below 128k the half-window reserve is larger; above it the flat 64k is. Monotonic either way.
    expect(compactionBudget(128_000)).toBe(64_000); // both rules agree exactly here
    expect(compactionBudget(96_000)).toBe(48_000); // proportional wins
    expect(compactionBudget(200_000)).toBe(136_000); // flat wins
  });

  it("is monotonic in the window — a bigger model never gets a smaller budget", () => {
    const windows = [1_000, 8_192, 16_384, 32_768, 65_536, 128_000, 200_000, 400_000, 1_000_000];
    const budgets = windows.map(compactionBudget);
    expect(budgets).toEqual([...budgets].sort((a, b) => a - b));
  });

  it("falls back to a conservative absolute when the window is unknown", () => {
    // No catalog (local engines / BYO), or turn 1 on a router lane.
    expect(compactionBudget(undefined)).toBe(UNKNOWN_WINDOW_BUDGET_TOKENS);
  });

  it("ignores a nonsense window rather than trusting it", () => {
    expect(compactionBudget(0)).toBe(UNKNOWN_WINDOW_BUDGET_TOKENS);
    expect(compactionBudget(-1)).toBe(UNKNOWN_WINDOW_BUDGET_TOKENS);
    expect(compactionBudget(Number.NaN)).toBe(UNKNOWN_WINDOW_BUDGET_TOKENS);
    expect(compactionBudget(Number.POSITIVE_INFINITY)).toBe(UNKNOWN_WINDOW_BUDGET_TOKENS);
  });

  it("keeps a tiny window usable rather than budgeting past it", () => {
    // window < reserve would otherwise yield a negative budget.
    expect(compactionBudget(8_000)).toBe(4_000);
  });
});

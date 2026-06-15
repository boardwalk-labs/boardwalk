// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  DEFAULT_COMPACTION_BUDGET_CHARS,
  estimateChars,
  estimateConversationChars,
  planCompaction,
} from "./compaction.js";
import type { ChatMessage } from "./conversation.js";

const user = (text: string): ChatMessage => ({ role: "user", text });
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

describe("estimateChars", () => {
  it("counts text plus a per-message overhead for each role", () => {
    expect(estimateChars(user("abcd"))).toBe(4 + 16);
    expect(estimateChars(assistantText("hi"))).toBe(2 + 16);
    const call = assistantCall("c1", "lookup");
    expect(estimateChars(call)).toBe("lookup".length + JSON.stringify({ x: 1 }).length + 16);
    expect(estimateChars(toolResults("c1", "result-body"))).toBe("result-body".length + 16);
  });

  it("sums a whole conversation", () => {
    const msgs = [user("aaaa"), assistantText("bb")];
    expect(estimateConversationChars(msgs)).toBe(estimateChars(msgs[0]!) + estimateChars(msgs[1]!));
  });
});

describe("planCompaction", () => {
  it("returns null when the conversation is within budget", () => {
    const msgs = [user("task"), assistantText("answer")];
    expect(planCompaction(msgs)).toBeNull();
    // The generous default budget never trips a small conversation.
    expect(estimateConversationChars(msgs)).toBeLessThan(DEFAULT_COMPACTION_BUDGET_CHARS);
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

function range(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}

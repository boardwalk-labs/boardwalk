// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { pruneStaleImages, type ChatMessage, type ContentPart } from "./conversation.js";

function imageResult(id: string, data: string): ChatMessage {
  return {
    role: "tool_results",
    results: [
      {
        id,
        content: [
          { type: "text", text: `shot ${id}` },
          { type: "file", file: { mimeType: "image/png", data } },
        ],
        isError: false,
      },
    ],
  };
}

const placeholder = (parts: string | readonly ContentPart[]): boolean =>
  typeof parts !== "string" &&
  parts.some((p) => p.type === "text" && p.text.includes("image removed from context"));

function images(messages: readonly ChatMessage[]): number {
  let count = 0;
  for (const m of messages) {
    if (m.role !== "tool_results") continue;
    for (const r of m.results) {
      if (typeof r.content === "string") continue;
      count += r.content.filter(
        (p) => p.type === "file" && p.file.mimeType.startsWith("image/"),
      ).length;
    }
  }
  return count;
}

describe("pruneStaleImages", () => {
  it("leaves a conversation at or under the keep budget untouched", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "go" },
      imageResult("t1", "a"),
      imageResult("t2", "b"),
    ];
    const before = structuredClone(messages);
    pruneStaleImages(messages, 3);
    expect(messages).toEqual(before);
  });

  it("replaces only the oldest images past the budget, keeping their text parts", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "go" },
      imageResult("t1", "a"),
      imageResult("t2", "b"),
      imageResult("t3", "c"),
      imageResult("t4", "d"),
    ];
    pruneStaleImages(messages, 3);
    expect(images(messages)).toBe(3);
    const first = messages[1];
    if (first === undefined || first.role !== "tool_results" || first.results[0] === undefined) {
      throw new Error("unexpected shape");
    }
    expect(placeholder(first.results[0].content)).toBe(true);
    expect(
      typeof first.results[0].content !== "string" &&
        first.results[0].content.some((p) => p.type === "text" && p.text === "shot t1"),
    ).toBe(true);
  });

  it("is idempotent and rolls forward as new screenshots arrive", () => {
    const messages: ChatMessage[] = [imageResult("t1", "a"), imageResult("t2", "b")];
    pruneStaleImages(messages, 1);
    pruneStaleImages(messages, 1);
    expect(images(messages)).toBe(1);
    messages.push(imageResult("t3", "c"));
    pruneStaleImages(messages, 1);
    expect(images(messages)).toBe(1);
    const last = messages[2];
    if (last === undefined || last.role !== "tool_results" || last.results[0] === undefined) {
      throw new Error("unexpected shape");
    }
    expect(placeholder(last.results[0].content)).toBe(false);
  });

  it("never touches user attachments, documents, or string results", () => {
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "go" },
          { type: "file", file: { mimeType: "image/png", data: "attached" } },
        ],
      },
      {
        role: "tool_results",
        results: [
          {
            id: "doc",
            content: [{ type: "file", file: { mimeType: "application/pdf", data: "pdf" } }],
            isError: false,
          },
          { id: "plain", content: "just text", isError: false },
        ],
      },
      imageResult("t1", "a"),
      imageResult("t2", "b"),
    ];
    pruneStaleImages(messages, 1);
    const before = messages[0];
    if (before === undefined || before.role !== "user" || typeof before.content === "string") {
      throw new Error("unexpected shape");
    }
    expect(before.content[1]).toEqual({
      type: "file",
      file: { mimeType: "image/png", data: "attached" },
    });
    const docMsg = messages[1];
    if (docMsg === undefined || docMsg.role !== "tool_results") throw new Error("unexpected shape");
    expect(docMsg.results[0]?.content).toEqual([
      { type: "file", file: { mimeType: "application/pdf", data: "pdf" } },
    ]);
    expect(docMsg.results[1]?.content).toBe("just text");
    expect(images(messages)).toBe(1);
  });
});

// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { anthropicMessagesBody, chatOpenAi, type ChatArgs, type ProviderIo } from "./providers.js";

function baseArgs(overrides: Partial<ChatArgs> = {}): ChatArgs {
  return {
    baseUrl: "https://api.example.com/v1",
    apiKey: "sk-test",
    headers: {},
    model: "some-model",
    messages: [{ role: "user", text: "hello" }],
    tools: [],
    ...overrides,
  };
}

/** Capture the request the adapter makes, returning a single canned completion. */
function recordingFetch(): {
  io: ProviderIo;
  body: () => Record<string, unknown>;
} {
  let captured = "";
  const fetchImpl: typeof fetch = (_input, init) => {
    captured = typeof init?.body === "string" ? init.body : "";
    return Promise.resolve(
      Response.json({
        choices: [{ finish_reason: "stop", message: { content: "ok" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    );
  };
  return {
    io: { fetchImpl, sleepImpl: () => Promise.resolve() },
    body: () => JSON.parse(captured) as Record<string, unknown>,
  };
}

describe("chatOpenAi reasoning encoding", () => {
  it("emits OpenRouter's unified `reasoning` object on the managed lane (openrouter style)", async () => {
    const { io, body } = recordingFetch();
    await chatOpenAi(baseArgs({ reasoning: { effort: "high" }, reasoningStyle: "openrouter" }), io);
    expect(body().reasoning).toEqual({ effort: "high" });
    expect(body().reasoning_effort).toBeUndefined();
  });

  it("passes a token budget + exclude through the unified object", async () => {
    const { io, body } = recordingFetch();
    await chatOpenAi(
      baseArgs({ reasoning: { maxTokens: 2000, exclude: true }, reasoningStyle: "openrouter" }),
      io,
    );
    expect(body().reasoning).toEqual({ max_tokens: 2000, exclude: true });
  });

  it("emits `reasoning_effort` for a BYO OpenAI-compatible endpoint (openai_effort style)", async () => {
    const { io, body } = recordingFetch();
    await chatOpenAi(
      baseArgs({ reasoning: { effort: "xhigh" }, reasoningStyle: "openai_effort" }),
      io,
    );
    expect(body().reasoning_effort).toBe("xhigh");
    expect(body().reasoning).toBeUndefined();
  });

  it("sends no reasoning field when none is requested", async () => {
    const { io, body } = recordingFetch();
    await chatOpenAi(baseArgs(), io);
    expect(body().reasoning).toBeUndefined();
    expect(body().reasoning_effort).toBeUndefined();
  });
});

describe("anthropicMessagesBody reasoning encoding", () => {
  it("derives a `thinking` budget from an effort level", () => {
    const body = anthropicMessagesBody({
      messages: [{ role: "user", text: "hi" }],
      tools: [],
      maxTokens: 8192,
      reasoning: { effort: "high" },
    });
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 6554 });
    expect(body.max_tokens).toBe(8192);
  });

  it("grows max_tokens to stay above an explicit budget", () => {
    const body = anthropicMessagesBody({
      messages: [{ role: "user", text: "hi" }],
      tools: [],
      maxTokens: 8192,
      reasoning: { maxTokens: 10000 },
    });
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 10000 });
    expect(body.max_tokens).toBe(11024);
  });

  it("omits `thinking` when no reasoning is requested", () => {
    const body = anthropicMessagesBody({
      messages: [{ role: "user", text: "hi" }],
      tools: [],
    });
    expect(body.thinking).toBeUndefined();
  });
});

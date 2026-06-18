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

/** Capture the request the adapter makes, returning a single canned (streamed) completion. */
function recordingFetch(): {
  io: ProviderIo;
  body: () => Record<string, unknown>;
} {
  let captured = "";
  const sse =
    `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: null }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n` +
    `data: [DONE]\n\n`;
  const fetchImpl: typeof fetch = (_input, init) => {
    captured = typeof init?.body === "string" ? init.body : "";
    return Promise.resolve(new Response(sse, { status: 200 }));
  };
  return {
    io: { fetchImpl, sleepImpl: () => Promise.resolve() },
    body: () => JSON.parse(captured) as Record<string, unknown>,
  };
}

/** A fetch returning a fixed SSE body, capturing onDelta-less responses for the streaming parser. */
function sseFetch(...events: object[]): typeof fetch {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
  return () => Promise.resolve(new Response(body, { status: 200 }));
}

describe("chatOpenAi streaming", () => {
  it("requests a stream with usage included", async () => {
    const { io, body } = recordingFetch();
    await chatOpenAi(baseArgs(), io);
    expect(body().stream).toBe(true);
    expect(body().stream_options).toEqual({ include_usage: true });
  });

  it("accumulates text deltas (firing onDelta per chunk) and reads usage from the final chunk", async () => {
    const deltas: string[] = [];
    const io: ProviderIo = {
      fetchImpl: sseFetch(
        { choices: [{ delta: { content: "Hel" }, finish_reason: null }] },
        { choices: [{ delta: { content: "lo" }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
        { choices: [], usage: { prompt_tokens: 7, completion_tokens: 2 } },
      ),
      sleepImpl: () => Promise.resolve(),
      onDelta: (t) => deltas.push(t),
    };
    const turn = await chatOpenAi(baseArgs(), io);
    expect(turn.text).toBe("Hello");
    expect(deltas).toEqual(["Hel", "lo"]);
    expect(turn.usage).toEqual({ inputTokens: 7, outputTokens: 2 });
    expect(turn.wantsTools).toBe(false);
  });

  it("assembles streamed tool calls from indexed argument fragments", async () => {
    const io: ProviderIo = {
      fetchImpl: sseFetch(
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: "c1", function: { name: "search", arguments: '{"q":' } },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [
            {
              delta: { tool_calls: [{ index: 0, function: { arguments: '"cats"}' } }] },
              finish_reason: null,
            },
          ],
        },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ),
      sleepImpl: () => Promise.resolve(),
    };
    const turn = await chatOpenAi(
      baseArgs({ tools: [{ name: "search", description: "x", inputSchema: { type: "object" } }] }),
      io,
    );
    expect(turn.wantsTools).toBe(true);
    expect(turn.toolCalls).toEqual([{ id: "c1", name: "search", input: { q: "cats" } }]);
  });
});

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

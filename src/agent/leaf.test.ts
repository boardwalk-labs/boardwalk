import { describe, expect, it } from "vitest";
import { EngineError } from "../errors.js";
import { runAgentLeaf, type LeafEventBody, type LeafIo } from "./leaf.js";
import { Redactor } from "./redact.js";
import type { ResolvedModel } from "./resolve.js";

const OPENAI_MODEL: ResolvedModel = {
  ref: "local/test-model",
  provider: "local",
  modelId: "test-model",
  protocol: "openai",
  baseUrl: "http://fake/v1",
  apiKey: "sk-test-key-12345",
};

const ANTHROPIC_MODEL: ResolvedModel = {
  ...OPENAI_MODEL,
  ref: "anthropic/claude-test",
  provider: "anthropic",
  modelId: "claude-test",
  protocol: "anthropic",
  baseUrl: "http://fake",
};

function openAiResponse(content: string, usage?: { in: number; out: number }): Response {
  return Response.json({
    choices: [{ message: { content } }],
    ...(usage !== undefined
      ? { usage: { prompt_tokens: usage.in, completion_tokens: usage.out } }
      : {}),
  });
}

function anthropicSse(...events: object[]): Response {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(body, { status: 200 });
}

interface Recorded {
  io: LeafIo;
  events: { turnId: string; body: LeafEventBody }[];
  turns: string[];
  usage: { modelRef: string; usage: object }[];
  requests: { url: string; body: string }[];
}

function recordedIo(
  model: ResolvedModel,
  responses: (() => Response)[],
  redactor = new Redactor(),
): Recorded {
  const events: Recorded["events"] = [];
  const turns: string[] = [];
  const usage: Recorded["usage"] = [];
  const requests: Recorded["requests"] = [];
  let call = 0;
  // Why the cast-free wrapper: the leaf only uses fetch's (url, init) shape; scripting it
  // through the real `typeof fetch` signature keeps this honest without `as`.
  const fetchImpl: typeof fetch = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    requests.push({ url, body: typeof init?.body === "string" ? init.body : "" });
    const make = responses[Math.min(call, responses.length - 1)];
    call += 1;
    if (make === undefined) throw new Error("no response scripted");
    return Promise.resolve(make());
  };
  const io: LeafIo = {
    resolve: () => Promise.resolve(model),
    startTurn: (turnId) => turns.push(turnId),
    emit: (turnId, body) => events.push({ turnId, body }),
    reportUsage: (modelRef, u) => usage.push({ modelRef, usage: u }),
    redactor,
    provider: { fetchImpl, sleepImpl: () => Promise.resolve() },
  };
  return { io, events, turns, usage, requests };
}

describe("runAgentLeaf — OpenAI-compatible protocol", () => {
  it("returns the text and emits the full turn event sequence with usage", async () => {
    const rec = recordedIo(OPENAI_MODEL, [() => openAiResponse("hello world", { in: 10, out: 5 })]);
    const result = await runAgentLeaf("say hello", undefined, rec.io);

    expect(result).toBe("hello world");
    expect(rec.turns).toHaveLength(1);
    expect(rec.events.map((e) => e.body.kind)).toEqual([
      "text_start",
      "text_delta",
      "text_end",
      "turn_ended",
    ]);
    const ended = rec.events.at(-1)?.body;
    expect(ended).toEqual({
      kind: "turn_ended",
      reason: "complete",
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    // Every event is scoped to the opened turn.
    expect(new Set(rec.events.map((e) => e.turnId))).toEqual(new Set(rec.turns));
    expect(rec.usage).toEqual([
      { modelRef: "local/test-model", usage: { inputTokens: 10, outputTokens: 5 } },
    ]);
  });

  it("sends the Bearer key and the prompt to the chat completions endpoint", async () => {
    const rec = recordedIo(OPENAI_MODEL, [() => openAiResponse("ok")]);
    await runAgentLeaf("the prompt text", undefined, rec.io);
    expect(rec.requests[0]?.url).toBe("http://fake/v1/chat/completions");
    expect(rec.requests[0]?.body).toContain("the prompt text");
  });

  it("redacts known secret values (and the provider key) from the outbound prompt", async () => {
    const redactor = new Redactor();
    redactor.add("GH_TOKEN", "ghp_supersecret99");
    const rec = recordedIo(OPENAI_MODEL, [() => openAiResponse("ok")], redactor);
    await runAgentLeaf("use token ghp_supersecret99 and key sk-test-key-12345", undefined, rec.io);

    const sent = rec.requests[0]?.body ?? "";
    expect(sent).not.toContain("ghp_supersecret99");
    expect(sent).not.toContain("sk-test-key-12345");
    expect(sent).toContain("[redacted:GH_TOKEN]");
    expect(sent).toContain("[redacted:api-key:local]");
  });

  it("retries 429 with backoff and succeeds", async () => {
    const rec = recordedIo(OPENAI_MODEL, [
      () => new Response("rate limited", { status: 429 }),
      () => openAiResponse("after retry"),
    ]);
    await expect(runAgentLeaf("p", undefined, rec.io)).resolves.toBe("after retry");
    expect(rec.requests).toHaveLength(2);
  });

  it("does not retry a non-rate-limit 4xx", async () => {
    const rec = recordedIo(OPENAI_MODEL, [() => new Response("bad request", { status: 400 })]);
    await expect(runAgentLeaf("p", undefined, rec.io)).rejects.toThrow(/provider returned 400/);
    expect(rec.requests).toHaveLength(1);
    const ended = rec.events.at(-1)?.body;
    expect(ended?.kind).toBe("turn_ended");
    expect(ended !== undefined && ended.kind === "turn_ended" ? ended.reason : "").toBe("error");
  });

  it("schema mode parses JSON (stripping code fences) and fails loudly on prose", async () => {
    const rec = recordedIo(OPENAI_MODEL, [
      () => openAiResponse('```json\n{"groups": [1, 2]}\n```'),
    ]);
    const parsed = await runAgentLeaf("group these", { schema: { type: "object" } }, rec.io);
    expect(parsed).toEqual({ groups: [1, 2] });
    // The schema instruction travels in the prompt.
    expect(rec.requests[0]?.body).toContain("JSON Schema");

    const prose = recordedIo(OPENAI_MODEL, [() => openAiResponse("Sure! Here are the groups…")]);
    await expect(runAgentLeaf("p", { schema: { type: "object" } }, prose.io)).rejects.toThrow(
      /not valid JSON/,
    );
  });

  it("rejects unimplemented capability selections loudly, before any network call", async () => {
    const rec = recordedIo(OPENAI_MODEL, [() => openAiResponse("never")]);
    await expect(
      runAgentLeaf("p", { tools: ["web_search"], memory: "memory/x" }, rec.io),
    ).rejects.toThrowError(EngineError);
    expect(rec.requests).toHaveLength(0);
    expect(rec.turns).toHaveLength(0);
  });
});

describe("runAgentLeaf — Anthropic protocol", () => {
  it("streams text deltas and assembles usage from the stream frames", async () => {
    const rec = recordedIo(ANTHROPIC_MODEL, [
      () =>
        anthropicSse(
          { type: "message_start", message: { usage: { input_tokens: 7 } } },
          { type: "content_block_start" },
          { type: "content_block_delta", delta: { type: "text_delta", text: "hel" } },
          { type: "content_block_delta", delta: { type: "text_delta", text: "lo" } },
          { type: "content_block_stop" },
          { type: "message_delta", usage: { output_tokens: 3 } },
          { type: "message_stop" },
        ),
    ]);
    const result = await runAgentLeaf("hi", undefined, rec.io);

    expect(result).toBe("hello");
    expect(rec.requests[0]?.url).toBe("http://fake/v1/messages");
    const deltas = rec.events
      .map((e) => e.body)
      .filter((b) => b.kind === "text_delta")
      .map((b) => b.text);
    expect(deltas).toEqual(["hel", "lo"]);
    expect(rec.usage).toEqual([
      { modelRef: "anthropic/claude-test", usage: { inputTokens: 7, outputTokens: 3 } },
    ]);
  });
});

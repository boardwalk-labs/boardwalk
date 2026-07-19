// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EngineError } from "../errors.js";
import { startFakeMcpServer } from "../testing/fake_mcp.js";
import {
  ContextCalibrator,
  DEFAULT_MAX_ITERATIONS,
  extractJsonCandidate,
  rebuildSeenObservations,
  runAgentLeaf,
  type LeafEventBody,
  type LeafIo,
  type ModelTurnRequest,
  type ModelTurnResult,
} from "./leaf.js";
import type { ChatMessage } from "./conversation.js";
import { chatAnthropic, chatOpenAi, type ChatArgs, type ProviderIo } from "./providers.js";
import { Redactor } from "./redact.js";
import type { ResolvedModel } from "./resolve.js";
import type { McpTokenResult } from "./tools.js";
import type { AgentOptions } from "@boardwalk-labs/workflow";

// Until the SDK build that surfaces `maxIterations` is published + the engine dep bumped, author
// capped calls through this local intersection so the tests compile against the pinned SDK type.
// The engine reads the knob defensively (Reflect.get), so behavior is version-agnostic; once
// AgentOptions carries the field, the intersection is a harmless no-op.
type LeafOpts = AgentOptions & { maxIterations?: number };

const OPENAI_MODEL: ResolvedModel = {
  provider: "local",
  model: "test-model",
  protocol: "openai",
  baseUrl: "http://fake/v1",
  apiKey: "sk-test-key-12345",
  headers: {},
  secretHeaderNames: [],
};

const ANTHROPIC_MODEL: ResolvedModel = {
  ...OPENAI_MODEL,
  provider: "anthropic",
  model: "claude-test",
  protocol: "anthropic",
  baseUrl: "http://fake",
};

// ----------------------------------------------------------------------------
// Scripted responses
// ----------------------------------------------------------------------------

// OpenAI chat completions stream as SSE chunks (chatOpenAi requests stream: true). These build the
// chunk sequence for a turn: text/tool-call deltas, a finish chunk, then a usage chunk + [DONE].
function openAiSse(...events: object[]): Response {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, { status: 200 });
}

function openAiText(content: string, usage?: { in: number; out: number }): Response {
  return openAiSse(
    { choices: [{ delta: { content }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
    ...(usage !== undefined
      ? [{ choices: [], usage: { prompt_tokens: usage.in, completion_tokens: usage.out } }]
      : []),
  );
}

function openAiToolCalls(
  calls: { id: string; name: string; args: Record<string, unknown> }[],
  text = "",
): Response {
  return openAiSse(
    ...(text.length > 0 ? [{ choices: [{ delta: { content: text }, finish_reason: null }] }] : []),
    {
      choices: [
        {
          delta: {
            tool_calls: calls.map((c, index) => ({
              index,
              id: c.id,
              function: { name: c.name, arguments: JSON.stringify(c.args) },
            })),
          },
          finish_reason: null,
        },
      ],
    },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    { choices: [], usage: { prompt_tokens: 5, completion_tokens: 5 } },
  );
}

function anthropicSse(...events: object[]): Response {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(body, { status: 200 });
}

// ----------------------------------------------------------------------------
// A local streamModel seam mirroring child_host's: resolve from a fixture, register the key +
// env-sourced headers with the redactor, then call the REAL provider adapter through the stubbed
// fetchImpl. This keeps the provider adapters (chatAnthropic/chatOpenAi) under test end-to-end —
// the seam moved WHERE the call is invoked, not whether the adapters are exercised.
// ----------------------------------------------------------------------------

function localStreamModel(model: ResolvedModel, redactor: Redactor) {
  let registered = false;
  return async (
    req: ModelTurnRequest,
    providerIo: ProviderIo,
  ): Promise<{ turn: Awaited<ReturnType<typeof chatOpenAi>>; modelRef: string }> => {
    if (!registered) {
      registered = true;
      if (model.apiKey !== null) redactor.add(`api-key:${model.provider}`, model.apiKey);
      for (const name of model.secretHeaderNames) {
        const value = model.headers[name];
        if (value !== undefined) redactor.add(`header:${name}`, value);
      }
    }
    const args: ChatArgs = {
      baseUrl: model.baseUrl,
      apiKey: model.apiKey,
      headers: model.headers,
      model: model.model,
      // Mirror the local child_host seam: scrub model-bound text after the key is registered.
      messages: req.messages.map((message) => {
        switch (message.role) {
          case "user":
            return { role: "user", content: redactor.redactContent(message.content) };
          case "assistant":
            return {
              role: "assistant",
              text: redactor.redact(message.text),
              toolCalls: message.toolCalls,
            };
          case "tool_results":
            return {
              role: "tool_results",
              results: message.results.map((result) => ({
                ...result,
                content: redactor.redactContent(result.content),
              })),
            };
        }
      }),
      tools: req.tools,
    };
    // providerIo arrives with the loop's fetchImpl/sleepImpl (from io.provider) + onDelta — the
    // adapters call through it exactly as the local child_host seam does in production.
    const turn =
      model.protocol === "anthropic"
        ? await chatAnthropic(args, providerIo)
        : await chatOpenAi(args, providerIo);
    return { turn, modelRef: model.model };
  };
}

// ----------------------------------------------------------------------------
// Recorded io
// ----------------------------------------------------------------------------

interface Recorded {
  io: LeafIo;
  events: { turnId: string; body: LeafEventBody }[];
  turns: string[];
  usage: { modelRef: string; usage: object }[];
  memoryUsed: string[];
  requests: { url: string; body: string }[];
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function recordedIo(
  model: ResolvedModel,
  responses: (() => Response)[],
  opts: {
    redactor?: Redactor;
    workspaceDir?: string;
    skillsDir?: string | null;
    agentName?: string;
    mcpToken?: (serverUrl: string, invalidateToken?: string) => Promise<McpTokenResult>;
  } = {},
): Recorded {
  const events: Recorded["events"] = [];
  const turns: string[] = [];
  const usage: Recorded["usage"] = [];
  const memoryUsed: string[] = [];
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
  const redactor = opts.redactor ?? new Redactor();
  const io: LeafIo = {
    identity: {
      agentId: "agent-1",
      ...(opts.agentName !== undefined ? { agentName: opts.agentName } : {}),
    },
    streamModel: localStreamModel(model, redactor),
    startTurn: (turnId) => {
      turns.push(turnId);
    },
    emit: (turnId, body) => {
      events.push({ turnId, body });
    },
    reportUsage: (modelRef, u) => {
      usage.push({ modelRef, usage: u });
    },
    memoryUsed: (dir) => {
      memoryUsed.push(dir);
    },
    mcpToken: opts.mcpToken ?? (() => Promise.resolve({ accessToken: null })),
    redactor,
    capabilities: {
      workspaceDir: opts.workspaceDir ?? tempDir("bw-leaf-ws-"),
      skillsDir: opts.skillsDir ?? null,
    },
    provider: { fetchImpl, sleepImpl: () => Promise.resolve() },
  };
  return { io, events, turns, usage, memoryUsed, requests };
}

function kinds(rec: Recorded): string[] {
  return rec.events.map((e) => e.body.kind);
}

// ----------------------------------------------------------------------------
// Plain inference
// ----------------------------------------------------------------------------

describe("runAgentLeaf — plain inference", () => {
  it("returns the text and emits the turn event sequence with summed usage", async () => {
    const rec = recordedIo(OPENAI_MODEL, [() => openAiText("hello world", { in: 10, out: 5 })]);
    const result = await runAgentLeaf("say hello", undefined, rec.io);

    expect(result).toBe("hello world");
    expect(rec.turns).toHaveLength(1);
    expect(kinds(rec)).toEqual(["text_start", "text_delta", "text_end", "turn_ended"]);
    expect(rec.events.at(-1)?.body).toEqual({
      kind: "turn_ended",
      agentId: "agent-1",
      reason: "complete",
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    expect(rec.usage).toEqual([
      { modelRef: "test-model", usage: { inputTokens: 10, outputTokens: 5 } },
    ]);
    expect(rec.memoryUsed).toEqual([]);
  });

  it("stamps the leaf's agentName onto turn_ended when the call was named", async () => {
    const rec = recordedIo(OPENAI_MODEL, [() => openAiText("hi", { in: 1, out: 1 })], {
      agentName: "reviewer",
    });
    await runAgentLeaf("review this", undefined, rec.io);

    const ended = rec.events.at(-1)?.body;
    expect(ended?.kind === "turn_ended" ? ended : null).toMatchObject({
      agentId: "agent-1",
      agentName: "reviewer",
    });
  });

  it("redacts known secret values (and the provider key) from the outbound prompt", async () => {
    const redactor = new Redactor();
    redactor.add("GH_TOKEN", "ghp_supersecret99");
    const rec = recordedIo(OPENAI_MODEL, [() => openAiText("ok")], { redactor });
    await runAgentLeaf("use token ghp_supersecret99 and key sk-test-key-12345", undefined, rec.io);

    const sent = rec.requests[0]?.body ?? "";
    expect(sent).not.toContain("ghp_supersecret99");
    expect(sent).not.toContain("sk-test-key-12345");
    expect(sent).toContain("[redacted:GH_TOKEN]");
    expect(sent).toContain("[redacted:api-key:local]");
  });

  it("prepends agent({ attachments }) to the first user message as file content parts", async () => {
    const rec = recordedIo(OPENAI_MODEL, [() => openAiText("done")]);
    await runAgentLeaf(
      "describe this",
      { attachments: [{ mimeType: "image/png", data: "AAAA", filename: "shot.png" }] },
      rec.io,
    );
    const body = rec.requests[0]?.body ?? "";
    // The image reaches the model as an OpenAI image_url data URL, alongside the prompt text.
    expect(body).toContain("image_url");
    expect(body).toContain("data:image/png;base64,AAAA");
    expect(body).toContain("describe this");
  });

  it("passes an attachment URL through to the model without re-encoding to base64", async () => {
    const rec = recordedIo(OPENAI_MODEL, [() => openAiText("done")]);
    await runAgentLeaf(
      "look",
      { attachments: [{ mimeType: "image/png", url: "https://example.com/y.png" }] },
      rec.io,
    );
    const body = rec.requests[0]?.body ?? "";
    expect(body).toContain("https://example.com/y.png");
    // Not fetched-and-re-encoded into a data URI. Assert the data-URI marker specifically — the bare
    // word "base64" now legitimately appears in the bash tool's own description.
    expect(body).not.toContain(";base64,");
  });

  it("keeps the first user message a bare string when there are no attachments", async () => {
    const rec = recordedIo(OPENAI_MODEL, [() => openAiText("done")]);
    await runAgentLeaf("plain prompt", {}, rec.io);
    const body = rec.requests[0]?.body ?? "";
    // The user content is a bare string (the unchanged common case), not a content-part array.
    expect(body).toContain("plain prompt");
    expect(body).not.toContain("image_url");
    expect(body).not.toContain('"content":[');
  });

  it("retries 429 with backoff and does not retry a non-rate-limit 4xx", async () => {
    const retried = recordedIo(OPENAI_MODEL, [
      () => new Response("rate limited", { status: 429 }),
      () => openAiText("after retry"),
    ]);
    await expect(runAgentLeaf("p", undefined, retried.io)).resolves.toBe("after retry");
    expect(retried.requests).toHaveLength(2);

    const fatal = recordedIo(OPENAI_MODEL, [() => new Response("bad request", { status: 400 })]);
    await expect(runAgentLeaf("p", undefined, fatal.io)).rejects.toThrow(/provider returned 400/);
    expect(fatal.requests).toHaveLength(1);
    const ended = fatal.events.at(-1)?.body;
    expect(ended !== undefined && ended.kind === "turn_ended" ? ended.reason : "").toBe("error");
  });

  it("REDACTS the provider key from a provider-error path — into the event AND the thrown error", async () => {
    // A provider echoing request headers (the API key) into a 4xx body must not persist it:
    // the error text rides both the turn_ended event and the rethrown error (the run's failed row).
    const rec = recordedIo(OPENAI_MODEL, [
      () => new Response(`bad key: ${OPENAI_MODEL.apiKey ?? ""}`, { status: 400 }),
    ]);
    let thrown: unknown;
    await runAgentLeaf("p", undefined, rec.io).catch((err: unknown) => {
      thrown = err;
    });
    const ended = rec.events.at(-1)?.body;
    const eventMessage =
      ended !== undefined && ended.kind === "turn_ended" ? (ended.error?.message ?? "") : "";
    expect(eventMessage).not.toContain("sk-test-key-12345");
    expect(eventMessage).toContain("[redacted:api-key:local]");
    const thrownMessage = thrown instanceof Error ? thrown.message : String(thrown);
    expect(thrownMessage).not.toContain("sk-test-key-12345");
  });

  it("schema mode parses JSON (stripping fences), recovers prose-wrapped JSON, fails on real prose", async () => {
    const rec = recordedIo(OPENAI_MODEL, [() => openAiText('```json\n{"groups": [1, 2]}\n```')]);
    const parsed = await runAgentLeaf("group these", { schema: { type: "object" } }, rec.io);
    expect(parsed).toEqual({ groups: [1, 2] });
    expect(rec.requests[0]?.body).toContain("JSON Schema");

    // A model that wraps valid JSON in commentary is recovered, not failed.
    const wrapped = recordedIo(OPENAI_MODEL, [
      () => openAiText('Sure, here you go:\n{"groups": [3, 4]}\nLet me know if you need more.'),
    ]);
    expect(await runAgentLeaf("p", { schema: { type: "object" } }, wrapped.io)).toEqual({
      groups: [3, 4],
    });

    // Genuinely non-JSON prose (twice, since the fake clamps to its last response) fails loudly.
    const prose = recordedIo(OPENAI_MODEL, [() => openAiText("Sure! Here are the groups…")]);
    await expect(runAgentLeaf("p", { schema: { type: "object" } }, prose.io)).rejects.toThrow(
      /not valid JSON \(after a retry\)/,
    );
  });

  it("schema mode spends ONE corrective turn when the first answer isn't JSON, then parses it", async () => {
    const rec = recordedIo(OPENAI_MODEL, [
      () => openAiText("Sure! Here are the groups you asked for."),
      () => openAiText('{"groups": [5, 6]}'),
    ]);
    const parsed = await runAgentLeaf("group these", { schema: { type: "object" } }, rec.io);
    expect(parsed).toEqual({ groups: [5, 6] });
    // Two model turns: the original + exactly one correction, whose request demands JSON only.
    expect(rec.requests).toHaveLength(2);
    expect(rec.requests[1]?.body).toContain("was not valid JSON");
    expect(rec.requests[1]?.body).toContain("JSON Schema");
    // The correction's usage is metered (not silently dropped).
    expect(rec.usage.length).toBeGreaterThanOrEqual(2);
  });

  it("schema mode retries only ONCE — a second non-JSON answer fails the run", async () => {
    const rec = recordedIo(OPENAI_MODEL, [
      () => openAiText("first prose answer"),
      () => openAiText("second prose answer, still no JSON"),
      () => openAiText('{"never": "reached"}'),
    ]);
    await expect(runAgentLeaf("p", { schema: { type: "object" } }, rec.io)).rejects.toThrow(
      /not valid JSON \(after a retry\)/,
    );
    // Original + one retry = 2 requests; the third scripted response is never consumed.
    expect(rec.requests).toHaveLength(2);
  });

  it("extractJsonCandidate recovers JSON from fences, prose, and nested structures", () => {
    expect(extractJsonCandidate('{"a":1}')).toBe('{"a":1}');
    expect(extractJsonCandidate('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(extractJsonCandidate('Here you go: {"a": {"b": [1,2]}} done')).toBe(
      '{"a": {"b": [1,2]}}',
    );
    expect(extractJsonCandidate("result: [1, 2, 3].")).toBe("[1, 2, 3]");
    // A brace inside a string literal must not end the carve early.
    expect(extractJsonCandidate('x {"a": "}"} y')).toBe('{"a": "}"}');
    // No JSON at all → returned as-is (the caller's parse then fails loudly).
    expect(extractJsonCandidate("just prose")).toBe("just prose");
  });

  it("rejects malformed MCP refs and duplicate server names before anything connects", async () => {
    const rec = recordedIo(OPENAI_MODEL, [() => openAiText("never")]);
    await expect(
      runAgentLeaf("p", { mcp: [{ name: "gh", transport: "http", url: "not-a-url" }] }, rec.io),
    ).rejects.toThrow(/malformed MCP server ref/);
    await expect(
      runAgentLeaf(
        "p",
        {
          mcp: [
            { name: "gh", transport: "http", url: "https://mcp.example.com" },
            { name: "gh", transport: "stdio", command: "gh-mcp" },
          ],
        },
        rec.io,
      ),
    ).rejects.toThrow(/Duplicate MCP server name/);
    await expect(
      runAgentLeaf("p", { mcp: [{ name: "bad name!", transport: "stdio", command: "x" }] }, rec.io),
    ).rejects.toThrowError(EngineError);
    expect(rec.requests).toHaveLength(0);
    expect(rec.turns).toHaveLength(0);
  });
});

// ----------------------------------------------------------------------------
// MCP servers (inline http refs against a real local fake server)
// ----------------------------------------------------------------------------

describe("runAgentLeaf — MCP", () => {
  it("advertises namespaced server tools and round-trips a call through the loop", async () => {
    const mcp = await startFakeMcpServer({
      tools: [
        {
          name: "lookup",
          description: "Looks things up",
          handler: (args) => ({ text: `looked up ${String(args["key"])}` }),
        },
      ],
    });
    cleanups.push(() => void mcp.close());
    const rec = recordedIo(OPENAI_MODEL, [
      () => openAiToolCalls([{ id: "c1", name: "db__lookup", args: { key: "answer" } }]),
      () => openAiText("found it"),
    ]);

    const result = await runAgentLeaf(
      "look it up",
      { mcp: [{ name: "db", transport: "http", url: mcp.url }] },
      rec.io,
    );

    expect(result).toBe("found it");
    // The namespaced tool (with the server's metadata) was advertised to the model…
    expect(rec.requests[0]?.body).toContain('"db__lookup"');
    expect(rec.requests[0]?.body).toContain("Looks things up");
    // …its result traveled back into model context…
    expect(rec.requests[1]?.body).toContain("looked up answer");
    expect(kinds(rec)).toContain("tool_call_result");
    // …and the connection was torn down at completion (DELETE-less server: check via requests).
    expect(mcp.requests.some((r) => r.rpcMethod === "tools/call")).toBe(true);
  });

  it("an MCP tool error returns to the MODEL as an error result — the run continues", async () => {
    const mcp = await startFakeMcpServer({
      tools: [{ name: "flaky", handler: () => ({ text: "upstream exploded", isError: true }) }],
    });
    cleanups.push(() => void mcp.close());
    const rec = recordedIo(OPENAI_MODEL, [
      () => openAiToolCalls([{ id: "c1", name: "srv__flaky", args: {} }]),
      () => openAiText("recovered"),
    ]);
    const result = await runAgentLeaf(
      "try it",
      { mcp: [{ name: "srv", transport: "http", url: mcp.url }] },
      rec.io,
    );
    expect(result).toBe("recovered");
    expect(kinds(rec)).toContain("tool_call_error");
    expect(rec.requests[1]?.body).toContain("upstream exploded");
  });

  it("excludeTools hides named tools from the model (the program keeps them via its own client)", async () => {
    const mcp = await startFakeMcpServer({
      tools: [
        { name: "read", description: "safe read", handler: () => ({ text: "ok" }) },
        { name: "eval", description: "arbitrary code", handler: () => ({ text: "danger" }) },
      ],
    });
    cleanups.push(() => void mcp.close());
    const rec = recordedIo(OPENAI_MODEL, [() => openAiText("done")]);
    await runAgentLeaf(
      "go",
      { mcp: [{ name: "srv", transport: "http", url: mcp.url, excludeTools: ["eval"] }] },
      rec.io,
    );
    // The safe tool is advertised to the model; the excluded one never reaches its tool set.
    expect(rec.requests[0]?.body).toContain('"srv__read"');
    expect(rec.requests[0]?.body).not.toContain("srv__eval");
  });

  it("defers a large MCP tool set behind find_tools, then advertises only what's searched", async () => {
    // Five MCP tools, each with a long description, clears the progressive-disclosure size gate
    // (>= 5 tools and >= ~16K chars of combined schema). See tool_search.ts.
    const pad = "d".repeat(4000);
    const mcp = await startFakeMcpServer({
      tools: [
        ...["a", "b", "c", "d"].map((n) => ({
          name: `pad_${n}`,
          description: `padding tool ${n}\n${pad}`,
          handler: () => ({ text: "ok" }),
        })),
        {
          name: "lookup",
          description: `Look things up by key\n${pad}`,
          handler: (args: Record<string, unknown>) => ({
            text: `looked up ${String(args["key"])}`,
          }),
        },
      ],
    });
    cleanups.push(() => void mcp.close());

    const rec = recordedIo(OPENAI_MODEL, [
      // Turn 1: the deferred tools aren't advertised, so the model searches for the one it wants.
      () => openAiToolCalls([{ id: "f1", name: "find_tools", args: { query: "lookup" } }]),
      // Turn 2: now that it's loaded, the model calls it.
      () => openAiToolCalls([{ id: "c1", name: "srv__lookup", args: { key: "answer" } }]),
      () => openAiText("found it"),
    ]);

    const result = await runAgentLeaf(
      "look it up",
      { mcp: [{ name: "srv", transport: "http", url: mcp.url }] },
      rec.io,
    );
    expect(result).toBe("found it");

    // Turn 1: find_tools IS advertised and the catalog names the deferred tools, but their full
    // (quoted) tool definitions are NOT in the advertised set.
    const first = rec.requests[0]?.body ?? "";
    expect(first).toContain('"find_tools"');
    expect(first).toContain("<tools>");
    expect(first).toContain("srv__lookup"); // named in the catalog…
    expect(first).not.toContain('"srv__lookup"'); // …but not advertised as a callable tool
    expect(first).not.toContain('"srv__pad_a"');

    // Turn 2: the searched tool is now advertised; the un-searched ones stay deferred.
    const second = rec.requests[1]?.body ?? "";
    expect(second).toContain('"srv__lookup"');
    expect(second).not.toContain('"srv__pad_a"');

    // The tool actually executed against the MCP server and its result reached the model.
    expect(rec.requests[2]?.body).toContain("looked up answer");
  });

  it("does NOT defer a small MCP tool set (below the size gate) — advertises everything up front", async () => {
    const mcp = await startFakeMcpServer({
      tools: [{ name: "lookup", description: "Looks things up", handler: () => ({ text: "ok" }) }],
    });
    cleanups.push(() => void mcp.close());
    const rec = recordedIo(OPENAI_MODEL, [() => openAiText("done")]);
    await runAgentLeaf("go", { mcp: [{ name: "srv", transport: "http", url: mcp.url }] }, rec.io);
    const body = rec.requests[0]?.body ?? "";
    // One small tool: advertised directly, no find_tools, no catalog.
    expect(body).toContain('"srv__lookup"');
    expect(body).not.toContain("find_tools");
    expect(body).not.toContain("<tools>");
  });

  it("disconnects (DELETEs the session) on completion AND on a model error", async () => {
    const completed = await startFakeMcpServer({
      tools: [{ name: "noop", handler: () => ({ text: "ok" }) }],
      sessionId: "sess-complete",
    });
    cleanups.push(() => void completed.close());
    const ok = recordedIo(OPENAI_MODEL, [() => openAiText("done")]);
    await runAgentLeaf(
      "p",
      { mcp: [{ name: "srv", transport: "http", url: completed.url }] },
      ok.io,
    );
    expect(completed.deletes).toBe(1);

    const errored = await startFakeMcpServer({
      tools: [{ name: "noop", handler: () => ({ text: "ok" }) }],
      sessionId: "sess-error",
    });
    cleanups.push(() => void errored.close());
    const bad = recordedIo(OPENAI_MODEL, [() => new Response("bad request", { status: 400 })]);
    await expect(
      runAgentLeaf("p", { mcp: [{ name: "srv", transport: "http", url: errored.url }] }, bad.io),
    ).rejects.toThrow(/provider returned 400/);
    expect(errored.deletes).toBe(1);
  });

  it("an unreachable MCP server fails the leaf loudly before any model call", async () => {
    const rec = recordedIo(OPENAI_MODEL, [() => openAiText("never")]);
    await expect(
      runAgentLeaf(
        "p",
        // A port nothing listens on: connection refused at initialize time.
        { mcp: [{ name: "ghost", transport: "http", url: "http://127.0.0.1:9/mcp" }] },
        rec.io,
      ),
    ).rejects.toThrow();
    expect(rec.requests).toHaveLength(0);
  });

  it("a 401 server with no engine token fails with the authorizeMcpServer hint", async () => {
    const mcp = await startFakeMcpServer({
      tools: [],
      auth: { validTokens: new Set(["never-issued"]) },
    });
    cleanups.push(() => void mcp.close());
    const asked: (string | undefined)[] = [];
    const rec = recordedIo(OPENAI_MODEL, [() => openAiText("never")], {
      mcpToken: (serverUrl, invalidateToken) => {
        asked.push(invalidateToken);
        expect(serverUrl).toBe(mcp.url);
        return Promise.resolve({ accessToken: null, hint: "run engine.authorizeMcpServer(...)" });
      },
    });
    const error: unknown = await runAgentLeaf(
      "p",
      { mcp: [{ name: "locked", transport: "http", url: mcp.url }] },
      rec.io,
    ).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(EngineError);
    expect(error instanceof EngineError ? error.message : "").toContain("locked");
    expect(error instanceof EngineError ? (error.hint ?? "") : "").toContain("authorizeMcpServer");
    expect(asked).toEqual([undefined]); // asked once, nothing to invalidate, no retry loop
    expect(rec.requests).toHaveLength(0); // never reached the model
  });

  it("a brokered token is used as a Bearer and registered with the redactor", async () => {
    const redactor = new Redactor();
    const mcp = await startFakeMcpServer({
      tools: [{ name: "noop", handler: () => ({ text: "ok" }) }],
      auth: { validTokens: new Set(["secret-bearer-token"]) },
    });
    cleanups.push(() => void mcp.close());
    const rec = recordedIo(OPENAI_MODEL, [() => openAiText("token is secret-bearer-token")], {
      redactor,
      mcpToken: () => Promise.resolve({ accessToken: "secret-bearer-token" }),
    });
    await runAgentLeaf("p", { mcp: [{ name: "srv", transport: "http", url: mcp.url }] }, rec.io);
    const authed = mcp.requests.find((r) => r.headers.authorization !== undefined);
    expect(authed?.headers.authorization).toBe("Bearer secret-bearer-token");
    // The token is now redactor-known: nothing model-bound may carry it.
    expect(redactor.redact("leak secret-bearer-token")).toBe("leak [redacted:mcp:srv]");
  });
});

// ----------------------------------------------------------------------------
// The tool loop
// ----------------------------------------------------------------------------

describe("runAgentLeaf — custom provider headers", () => {
  it("sends custom headers (winning over computed auth) and redacts env-sourced values", async () => {
    const azureModel: ResolvedModel = {
      provider: "azure",
      model: "gpt-4o",
      protocol: "openai",
      baseUrl: "http://fake/azure",
      apiKey: null,
      headers: { "api-key": "az-secret-headerval", "x-ms-client": "boardwalk" },
      secretHeaderNames: ["api-key"],
    };
    const requests: { headers: Record<string, string>; body: string }[] = [];
    const fetchImpl: typeof fetch = (_input, init) => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(init?.headers ?? {})) {
        if (typeof v === "string") headers[k] = v;
      }
      requests.push({ headers, body: typeof init?.body === "string" ? init.body : "" });
      return Promise.resolve(openAiText("ok"));
    };
    const rec = recordedIo(azureModel, [() => openAiText("ok")]);
    const io: LeafIo = { ...rec.io, provider: { fetchImpl, sleepImpl: () => Promise.resolve() } };

    await runAgentLeaf("the api-key is az-secret-headerval by the way", undefined, io);

    expect(requests[0]?.headers["api-key"]).toBe("az-secret-headerval");
    expect(requests[0]?.headers["x-ms-client"]).toBe("boardwalk");
    expect(requests[0]?.headers["content-type"]).toBe("application/json");
    expect(requests[0]?.headers.authorization).toBeUndefined(); // no apiKey → no bearer
    // The env-sourced header VALUE is redacted from the model-bound prompt…
    expect(requests[0]?.body).not.toContain("az-secret-headerval");
    expect(requests[0]?.body).toContain("[redacted:header:api-key]");
    // …while the static header value is not a secret and passes through.
  });
});

describe("runAgentLeaf — tool loop", () => {
  const doubler = {
    name: "double",
    description: "Doubles a number",
    inputSchema: { type: "object", properties: { n: { type: "number" } }, required: ["n"] },
    execute: (input: unknown) => {
      const n: unknown = typeof input === "object" && input !== null ? Reflect.get(input, "n") : 0;
      return Promise.resolve(typeof n === "number" ? n * 2 : 0);
    },
  };

  it("OpenAI protocol: executes a program-defined tool and feeds the result back", async () => {
    const rec = recordedIo(OPENAI_MODEL, [
      () => openAiToolCalls([{ id: "call-1", name: "double", args: { n: 21 } }]),
      () => openAiText("the answer is 42", { in: 7, out: 3 }),
    ]);
    const result = await runAgentLeaf("double 21", { tools: [doubler] }, rec.io);

    expect(result).toBe("the answer is 42");
    expect(rec.requests).toHaveLength(2);
    // The tool was advertised…
    expect(rec.requests[0]?.body).toContain('"double"');
    // …and its result traveled back with the call id.
    expect(rec.requests[1]?.body).toContain("call-1");
    expect(rec.requests[1]?.body).toContain("42");

    expect(kinds(rec)).toEqual([
      "tool_call_start",
      "tool_call_input_complete",
      "tool_call_executing",
      "tool_call_result",
      "text_start",
      "text_delta",
      "text_end",
      "turn_ended",
    ]);
    // Usage reported per model call — the budget authority sees mid-loop spend.
    expect(rec.usage).toHaveLength(2);
  });

  it("Anthropic protocol: assembles streamed tool_use input from partial JSON deltas", async () => {
    const rec = recordedIo(ANTHROPIC_MODEL, [
      () =>
        anthropicSse(
          { type: "message_start", message: { usage: { input_tokens: 4 } } },
          {
            type: "content_block_start",
            content_block: { type: "tool_use", id: "tu-1", name: "double" },
          },
          {
            type: "content_block_delta",
            delta: { type: "input_json_delta", partial_json: '{"n":' },
          },
          { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "21}" } },
          { type: "content_block_stop" },
          {
            type: "message_delta",
            delta: { stop_reason: "tool_use" },
            usage: { output_tokens: 2 },
          },
        ),
      () =>
        anthropicSse(
          { type: "message_start", message: { usage: { input_tokens: 6 } } },
          { type: "content_block_delta", delta: { type: "text_delta", text: "42" } },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 1 },
          },
        ),
    ]);
    const result = await runAgentLeaf("double 21", { tools: [doubler] }, rec.io);

    expect(result).toBe("42");
    expect(rec.requests).toHaveLength(2);
    // The second request carries the tool_result for tu-1.
    expect(rec.requests[1]?.body).toContain("tool_result");
    expect(rec.requests[1]?.body).toContain("tu-1");
  });

  it("a tool failure returns to the MODEL as an error result — the run continues", async () => {
    const flaky = {
      name: "flaky",
      description: "Always fails",
      inputSchema: { type: "object" },
      execute: () => Promise.reject(new Error("upstream timed out")),
    };
    const rec = recordedIo(OPENAI_MODEL, [
      () => openAiToolCalls([{ id: "c1", name: "flaky", args: {} }]),
      () => openAiText("recovered without the tool"),
    ]);
    const result = await runAgentLeaf("try the tool", { tools: [flaky] }, rec.io);

    expect(result).toBe("recovered without the tool");
    expect(kinds(rec)).toContain("tool_call_error");
    expect(rec.requests[1]?.body).toContain("upstream timed out");
  });

  it("a model-invented tool name becomes an error result, not a run failure", async () => {
    const rec = recordedIo(OPENAI_MODEL, [
      () => openAiToolCalls([{ id: "c1", name: "imaginary", args: {} }]),
      () => openAiText("fine"),
    ]);
    await expect(runAgentLeaf("p", { tools: [doubler] }, rec.io)).resolves.toBe("fine");
    expect(rec.requests[1]?.body).toContain('Unknown tool \\"imaginary\\"');
  });

  it("tool results entering model context are redacted", async () => {
    const redactor = new Redactor();
    redactor.add("DB_PASSWORD", "hunter2-hunter2");
    const leaky = {
      name: "leaky",
      description: "Returns a secret",
      inputSchema: { type: "object" },
      execute: () => Promise.resolve("the password is hunter2-hunter2"),
    };
    const rec = recordedIo(
      OPENAI_MODEL,
      [() => openAiToolCalls([{ id: "c1", name: "leaky", args: {} }]), () => openAiText("done")],
      { redactor },
    );
    await runAgentLeaf("p", { tools: [leaky] }, rec.io);
    expect(rec.requests[1]?.body).not.toContain("hunter2-hunter2");
    expect(rec.requests[1]?.body).toContain("[redacted:DB_PASSWORD]");
  });

  it("runs UNBOUNDED by default — a long tool loop past the old 25-turn cap still completes", async () => {
    // Distinct args each turn so the repetition guard does NOT fire. With no maxIterations there is
    // no fixed ceiling: 30 tool turns (past the retired hard cap of 25) run through to a final answer.
    const rec = recordedIo(OPENAI_MODEL, [
      ...Array.from(
        { length: 30 },
        (_, i) => () => openAiToolCalls([{ id: `c${String(i)}`, name: "double", args: { n: i } }]),
      ),
      () => openAiText("done after a long loop"),
    ]);
    await expect(runAgentLeaf("p", { tools: [doubler] }, rec.io)).resolves.toBe(
      "done after a long loop",
    );
    expect(rec.requests).toHaveLength(31);
  });

  it("rejects duplicate inline tool names and an explicit unknown built-in", async () => {
    const rec = recordedIo(OPENAI_MODEL, [() => openAiText("never")]);
    await expect(runAgentLeaf("p", { tools: [doubler, { ...doubler }] }, rec.io)).rejects.toThrow(
      /Duplicate tool name/,
    );
    // An EXPLICIT builtins selection naming a tool the engine doesn't have fails loudly.
    await expect(
      runAgentLeaf("p", { builtins: ["definitely_not_a_tool"] }, rec.io),
    ).rejects.toThrow(/not available on this engine/);
    expect(rec.requests).toHaveLength(0);
  });

  it("rejects an inline tool that shadows a default-on built-in", async () => {
    const rec = recordedIo(OPENAI_MODEL, [() => openAiText("never")]);
    const shadowsRead = {
      name: "read",
      description: "shadow",
      inputSchema: { type: "object" },
      execute: () => Promise.resolve("x"),
    };
    await expect(runAgentLeaf("p", { tools: [shadowsRead] }, rec.io)).rejects.toThrow(
      /Duplicate tool name/,
    );
    expect(rec.requests).toHaveLength(0);
  });
});

// ----------------------------------------------------------------------------
// Default-on built-in tools + the `builtins` scope
// ----------------------------------------------------------------------------

describe("runAgentLeaf — built-in tools (default-on)", () => {
  it("advertises the full sandbox built-in set with NO tools/builtins named", async () => {
    const rec = recordedIo(OPENAI_MODEL, [() => openAiText("ok")]);
    await runAgentLeaf("do something", undefined, rec.io);
    const body = rec.requests[0]?.body ?? "";
    for (const name of [
      "read",
      "write",
      "edit",
      "ls",
      "grep",
      "glob",
      "bash",
      "apply_patch",
      "clock",
      "todo",
    ]) {
      expect(body).toContain(`"${name}"`);
    }
  });

  it('builtins: "read-only" advertises read/grep but NOT write/edit/bash/apply_patch', async () => {
    const rec = recordedIo(OPENAI_MODEL, [() => openAiText("ok")]);
    await runAgentLeaf("inspect", { builtins: "read-only" }, rec.io);
    const body = rec.requests[0]?.body ?? "";
    for (const name of ["read", "ls", "grep", "glob"]) expect(body).toContain(`"${name}"`);
    for (const name of ["write", "edit", "bash", "apply_patch"]) {
      expect(body).not.toContain(`"${name}"`);
    }
  });

  it('builtins: "none" advertises no built-ins (only inline tools)', async () => {
    const rec = recordedIo(OPENAI_MODEL, [() => openAiText("ok")]);
    await runAgentLeaf("plain", { builtins: "none" }, rec.io);
    const body = rec.requests[0]?.body ?? "";
    // With no inline tools and builtins "none", the request advertises an empty tools array.
    for (const name of ["read", "write", "bash", "grep"]) expect(body).not.toContain(`"${name}"`);
  });

  it("builtins: explicit subset advertises exactly those", async () => {
    const rec = recordedIo(OPENAI_MODEL, [() => openAiText("ok")]);
    await runAgentLeaf("explicit", { builtins: ["read", "bash"] }, rec.io);
    const body = rec.requests[0]?.body ?? "";
    expect(body).toContain('"read"');
    expect(body).toContain('"bash"');
    expect(body).not.toContain('"write"');
    expect(body).not.toContain('"glob"');
  });

  it("a default-on built-in actually executes against the workspace through the loop", async () => {
    const workspaceDir = tempDir("bw-builtin-ws-");
    writeFileSync(join(workspaceDir, "hello.txt"), "the secret is in here", "utf8");
    const rec = recordedIo(
      OPENAI_MODEL,
      [
        () => openAiToolCalls([{ id: "r1", name: "read", args: { path: "hello.txt" } }]),
        () => openAiText("done"),
      ],
      { workspaceDir },
    );
    const result = await runAgentLeaf("read the file", undefined, rec.io);
    expect(result).toBe("done");
    // The file's content came back into model context on the follow-up turn.
    expect(rec.requests[1]?.body).toContain("the secret is in here");
  });

  it("agent({ cwd }) re-roots the leaf through the whole loop: tools resolve checkout-relative", async () => {
    const workspaceDir = tempDir("bw-cwd-ws-");
    mkdirSync(join(workspaceDir, "checkout", "src"), { recursive: true });
    writeFileSync(join(workspaceDir, "checkout", "src", "app.ts"), "repo contents", "utf8");
    const rec = recordedIo(
      OPENAI_MODEL,
      [
        // The model uses a clean checkout-relative path — no prefix guessing.
        () => openAiToolCalls([{ id: "r1", name: "read", args: { path: "src/app.ts" } }]),
        () => openAiText("done"),
      ],
      { workspaceDir },
    );
    const result = await runAgentLeaf("read the file", { cwd: "checkout" }, rec.io);
    expect(result).toBe("done");
    expect(rec.requests[1]?.body).toContain("repo contents");
    // The preamble orients the model with the CWD's entries, not the run root's.
    expect(rec.requests[0]?.body).toContain("The workspace root contains: src/");
  });

  it("deep-redacts a built-in tool's STRUCTURED event data, not just the model-bound text", async () => {
    // A built-in now publishes a structured tool_call_result (kind + data) to observers. If a known
    // secret rides in that data (here, a file `read` returns it), it must be scrubbed there too —
    // the secrets invariant covers the persisted event stream, not only model context.
    const workspaceDir = tempDir("bw-redact-ws-");
    const secret = "sk-file-secret-abcdef99";
    writeFileSync(join(workspaceDir, "creds.txt"), `token=${secret}\n`, "utf8");
    const redactor = new Redactor();
    redactor.add("FILE_SECRET", secret);
    const rec = recordedIo(
      OPENAI_MODEL,
      [
        () => openAiToolCalls([{ id: "r1", name: "read", args: { path: "creds.txt" } }]),
        () => openAiText("done"),
      ],
      { redactor, workspaceDir },
    );
    await runAgentLeaf("read the creds", undefined, rec.io);

    const resultEvent = rec.events.find((e) => e.body.kind === "tool_call_result");
    expect(resultEvent).toBeDefined();
    const serialized = JSON.stringify(resultEvent?.body);
    expect(serialized).not.toContain(secret);
    expect(serialized).toContain("[redacted:FILE_SECRET]");
    // The structured shape is intact (kind + data survive redaction).
    const body = resultEvent?.body;
    expect(body?.kind === "tool_call_result" ? body.result.kind : "").toBe("file_read");
    // The model's copy stays redacted too (existing invariant).
    expect(rec.requests[1]?.body).not.toContain(secret);
  });

  it("streams a built-in tool's output as redacted tool_output_delta events", async () => {
    const redactor = new Redactor();
    redactor.add("STREAM_SECRET", "streamsecret-xyz9");
    const rec = recordedIo(
      OPENAI_MODEL,
      [
        () =>
          openAiToolCalls([
            { id: "b1", name: "bash", args: { command: "echo streamsecret-xyz9" } },
          ]),
        () => openAiText("done"),
      ],
      { redactor },
    );
    await runAgentLeaf("run it", undefined, rec.io);

    const deltas = rec.events.filter((e) => e.body.kind === "tool_output_delta");
    expect(deltas.length).toBeGreaterThan(0);
    const streamed = deltas
      .map((e) => (e.body.kind === "tool_output_delta" ? e.body.text : ""))
      .join("");
    // The live deltas are redacted, just like the final result.
    expect(streamed).toContain("[redacted:STREAM_SECRET]");
    expect(streamed).not.toContain("streamsecret-xyz9");
  });

  it("the host-backed tools are absent without a ToolHost backend, present with one", async () => {
    const withoutHost = recordedIo(OPENAI_MODEL, [() => openAiText("ok")]);
    await runAgentLeaf("p", undefined, withoutHost.io);
    expect(withoutHost.requests[0]?.body ?? "").not.toContain('"webfetch"');
    expect(withoutHost.requests[0]?.body ?? "").not.toContain('"web_search"');

    const withHost = recordedIo(OPENAI_MODEL, [() => openAiText("ok")]);
    withHost.io.capabilities.host = {
      fetchUrl: () =>
        Promise.resolve({ status: 200, contentType: "text/plain", body: "page", truncated: false }),
      webSearch: () => Promise.resolve([{ title: "t", url: "https://x" }]),
      writeArtifact: () => Promise.resolve({ id: "a1", name: "n", url: "file://n" }),
    };
    await runAgentLeaf("p", undefined, withHost.io);
    const body = withHost.requests[0]?.body ?? "";
    expect(body).toContain('"webfetch"');
    expect(body).toContain('"web_search"');
    expect(body).toContain('"artifacts"');
    // No lsp hook → no lsp tool even with a host present.
    expect(body).not.toContain('"lsp"');
  });
});

// ----------------------------------------------------------------------------
// Skills + memory
// ----------------------------------------------------------------------------

describe("runAgentLeaf — run_code (programmatic tool calling)", () => {
  it("advertises run_code by default, not under builtins: none", async () => {
    const on = recordedIo(OPENAI_MODEL, [() => openAiText("ok")]);
    await runAgentLeaf("go", undefined, on.io);
    expect(on.requests[0]?.body).toContain('"run_code"');

    const off = recordedIo(OPENAI_MODEL, [() => openAiText("ok")]);
    await runAgentLeaf("go", { builtins: "none" }, off.io);
    expect(off.requests[0]?.body).not.toContain("run_code");
  });

  it("orchestrates a built-in tool in code so intermediate results stay OUT of model context", async () => {
    const workspaceDir = tempDir("bw-runcode-ws-");
    writeFileSync(join(workspaceDir, "data.txt"), "ALPHA\nBETA\nGAMMA", "utf8");
    const rec = recordedIo(
      OPENAI_MODEL,
      [
        () =>
          openAiToolCalls([
            {
              id: "rc1",
              name: "run_code",
              args: {
                code: 'const c = await tools.read({ path: "data.txt" }); return c.split("\\n").length;',
              },
            },
          ]),
        () => openAiText("done"),
      ],
      { workspaceDir },
    );
    const result = await runAgentLeaf("count the lines in data.txt with code", undefined, rec.io);
    expect(result).toBe("done");

    // The code's SUMMARY (the line count) came back into context on the follow-up turn…
    expect(rec.requests[1]?.body).toContain("return: 3");
    // …but the file's raw contents NEVER entered context on any turn — the whole point of PTC.
    for (const { body } of rec.requests) {
      expect(body).not.toContain("ALPHA");
      expect(body).not.toContain("GAMMA");
    }
  });

  it("surfaces a code error to the model as a tool result so the run continues", async () => {
    const rec = recordedIo(OPENAI_MODEL, [
      () =>
        openAiToolCalls([
          { id: "rc1", name: "run_code", args: { code: 'throw new Error("boom")' } },
        ]),
      () => openAiText("recovered"),
    ]);
    const result = await runAgentLeaf("run some code", undefined, rec.io);
    expect(result).toBe("recovered");
    expect(rec.requests[1]?.body).toContain("boom");
  });
});

describe("runAgentLeaf — skills (folder-per-skill, progressive disclosure)", () => {
  function writeSkill(
    skillsDir: string,
    name: string,
    skillMd: string,
    files: Record<string, string> = {},
  ): void {
    const dir = join(skillsDir, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), skillMd, "utf8");
    for (const [file, content] of Object.entries(files)) {
      writeFileSync(join(dir, file), content, "utf8");
    }
  }

  it("injects a compact catalog (name + description), NOT the full body, into the first message", async () => {
    const skillsDir = tempDir("bw-skills-");
    writeSkill(
      skillsDir,
      "reviewer",
      "---\nname: reviewer\ndescription: Review a PR for SQL injection\n---\nSKILL-BODY-MARKER: check parameterized queries.",
    );
    const rec = recordedIo(OPENAI_MODEL, [() => openAiText("ok")], { skillsDir });
    await runAgentLeaf("review this", { skills: ["reviewer"] }, rec.io);

    const sent = rec.requests[0]?.body ?? "";
    expect(sent).toContain("Review a PR for SQL injection"); // the catalog description
    expect(sent).toContain("<skills>");
    expect(sent).not.toContain("SKILL-BODY-MARKER"); // the body is NOT eagerly injected
  });

  it("advertises a `skill` tool restricted to the pinned set", async () => {
    const skillsDir = tempDir("bw-skills-");
    writeSkill(skillsDir, "reviewer", "---\ndescription: Review PRs\n---\nbody");
    const rec = recordedIo(OPENAI_MODEL, [() => openAiText("ok")], { skillsDir });
    await runAgentLeaf("go", { skills: ["reviewer"] }, rec.io);

    const sent = rec.requests[0]?.body ?? "";
    expect(sent).toContain('"name":"skill"'); // the tool is advertised
    expect(sent).toContain('"enum":["reviewer"]'); // restricted to the pinned set
  });

  it("loads the full body on demand when the model calls the `skill` tool", async () => {
    const skillsDir = tempDir("bw-skills-");
    writeSkill(
      skillsDir,
      "reviewer",
      "---\ndescription: Review PRs\n---\nSKILL-BODY-MARKER: the full procedure.",
    );
    const rec = recordedIo(
      OPENAI_MODEL,
      [
        () => openAiToolCalls([{ id: "s1", name: "skill", args: { name: "reviewer" } }]),
        () => openAiText("done"),
      ],
      { skillsDir },
    );
    await runAgentLeaf("review this", { skills: ["reviewer"] }, rec.io);

    // The body enters context only after the model loads it — the SECOND model request carries it.
    expect(rec.requests[1]?.body ?? "").toContain("SKILL-BODY-MARKER");
  });

  it("reads a bundled resource file on demand via skill({ name, file })", async () => {
    const skillsDir = tempDir("bw-skills-");
    writeSkill(skillsDir, "reviewer", "---\ndescription: Review PRs\n---\nbody", {
      "checklist.md": "RESOURCE-MARKER: parameterize, then escape",
    });
    const rec = recordedIo(
      OPENAI_MODEL,
      [
        () =>
          openAiToolCalls([
            { id: "s1", name: "skill", args: { name: "reviewer", file: "checklist.md" } },
          ]),
        () => openAiText("done"),
      ],
      { skillsDir },
    );
    await runAgentLeaf("review this", { skills: ["reviewer"] }, rec.io);
    expect(rec.requests[1]?.body ?? "").toContain("RESOURCE-MARKER");
  });

  it("fails loudly on a missing skill, a flat-layout skill, and a malformed name", async () => {
    const skillsDir = tempDir("bw-skills-");
    // A leftover flat-layout file gets a migration hint, not the generic missing error.
    writeFileSync(join(skillsDir, "legacy.md"), "old", "utf8");
    const rec = recordedIo(OPENAI_MODEL, [() => openAiText("never")], { skillsDir });

    await expect(runAgentLeaf("p", { skills: ["ghost"] }, rec.io)).rejects.toThrow(
      /no skills\/ghost\/SKILL\.md was deployed/,
    );
    await expect(runAgentLeaf("p", { skills: ["legacy"] }, rec.io)).rejects.toThrow(
      /old flat layout/,
    );
    await expect(runAgentLeaf("p", { skills: ["../etc/passwd"] }, rec.io)).rejects.toThrow(
      /not a valid skill name/,
    );
    expect(rec.requests).toHaveLength(0);
  });
});

// ----------------------------------------------------------------------------
// AGENTS.md auto-load (project context, default-on, no AgentOptions field)
// ----------------------------------------------------------------------------

describe("runAgentLeaf — AGENTS.md auto-load", () => {
  it("auto-loads the workspace's AGENTS.md into the first message — no option named", async () => {
    const workspaceDir = tempDir("bw-agents-ws-");
    writeFileSync(
      join(workspaceDir, "AGENTS.md"),
      "Always run the linter before finishing.",
      "utf8",
    );
    const rec = recordedIo(OPENAI_MODEL, [() => openAiText("ok")], { workspaceDir });
    // Plain agent() with NO options: the convention is auto, not a declared capability.
    await runAgentLeaf("do the task", undefined, rec.io);

    const sent = rec.requests[0]?.body ?? "";
    expect(sent).toContain("Always run the linter before finishing.");
    // Tagged with its tier (workspace) and path (JSON-escaped quotes on the wire).
    expect(sent).toContain('<AGENTS.md source=\\"workspace\\" path=\\"AGENTS.md\\">');
  });

  it("adds nothing when the workspace has no AGENTS.md", async () => {
    const rec = recordedIo(OPENAI_MODEL, [() => openAiText("ok")]);
    await runAgentLeaf("do the task", undefined, rec.io);
    expect(rec.requests[0]?.body ?? "").not.toContain("AGENTS.md");
  });

  it("places project context (AGENTS.md) BEFORE the skills catalog in the preamble", async () => {
    const workspaceDir = tempDir("bw-agents-ws-");
    writeFileSync(join(workspaceDir, "AGENTS.md"), "PROJECT-RULES-MARKER", "utf8");
    const skillsDir = tempDir("bw-skills-");
    const dir = join(skillsDir, "reviewer");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      "---\ndescription: SKILL-CATALOG-MARKER\n---\nbody",
      "utf8",
    );
    const rec = recordedIo(OPENAI_MODEL, [() => openAiText("ok")], { workspaceDir, skillsDir });
    await runAgentLeaf("review this", { skills: ["reviewer"] }, rec.io);

    const sent = rec.requests[0]?.body ?? "";
    expect(sent).toContain("PROJECT-RULES-MARKER");
    expect(sent).toContain("SKILL-CATALOG-MARKER");
    // Project rules frame the task; the skill catalog is the procedure index — AGENTS.md comes first.
    expect(sent.indexOf("PROJECT-RULES-MARKER")).toBeLessThan(sent.indexOf("SKILL-CATALOG-MARKER"));
  });

  it("redacts known secret values out of AGENTS.md before the model call", async () => {
    const workspaceDir = tempDir("bw-agents-ws-");
    writeFileSync(
      join(workspaceDir, "AGENTS.md"),
      "The deploy token is ghp_dont-leak-me-99.",
      "utf8",
    );
    const redactor = new Redactor();
    redactor.add("GH_TOKEN", "ghp_dont-leak-me-99");
    const rec = recordedIo(OPENAI_MODEL, [() => openAiText("ok")], { workspaceDir, redactor });
    await runAgentLeaf("do the task", undefined, rec.io);

    const sent = rec.requests[0]?.body ?? "";
    expect(sent).not.toContain("ghp_dont-leak-me-99");
    expect(sent).toContain("[redacted:GH_TOKEN]");
  });
});

// ----------------------------------------------------------------------------
// Base tool-use conventions (default-on preamble, most-general → first)
// ----------------------------------------------------------------------------

describe("runAgentLeaf — base tool-use conventions", () => {
  it("prepends the conventions to the first message for a default (tool-bearing) leaf", async () => {
    const rec = recordedIo(OPENAI_MODEL, [() => openAiText("ok")]);
    await runAgentLeaf("do the task", undefined, rec.io);
    const sent = rec.requests[0]?.body ?? "";
    expect(sent).toContain("# Tool-use conventions");
    expect(sent).toContain("Work in parallel");
  });

  it("orders the conventions BEFORE AGENTS.md (most-general first; author rules override)", async () => {
    const workspaceDir = tempDir("bw-guidance-ws-");
    writeFileSync(join(workspaceDir, "AGENTS.md"), "PROJECT-RULES-MARKER", "utf8");
    const rec = recordedIo(OPENAI_MODEL, [() => openAiText("ok")], { workspaceDir });
    await runAgentLeaf("do the task", undefined, rec.io);
    const sent = rec.requests[0]?.body ?? "";
    expect(sent.indexOf("# Tool-use conventions")).toBeLessThan(
      sent.indexOf("PROJECT-RULES-MARKER"),
    );
  });

  it("omits edit/verify guidance for a read-only leaf, and everything for builtins:none", async () => {
    const readOnly = recordedIo(OPENAI_MODEL, [() => openAiText("ok")]);
    await runAgentLeaf("look around", { builtins: "read-only" }, readOnly.io);
    const roSent = readOnly.requests[0]?.body ?? "";
    expect(roSent).toContain("Work in parallel");
    expect(roSent).not.toContain("Make targeted changes");
    expect(roSent).not.toContain("Verify your work");

    // No built-ins and no inline tools ⇒ nothing to guide, no conventions block at all.
    const none = recordedIo(OPENAI_MODEL, [() => openAiText("ok")]);
    await runAgentLeaf("just answer", { builtins: "none" }, none.io);
    expect(none.requests[0]?.body ?? "").not.toContain("# Tool-use conventions");
  });
});

// ----------------------------------------------------------------------------
// Context compaction (mid-conversation summarization)
// ----------------------------------------------------------------------------

describe("runAgentLeaf — context compaction", () => {
  // A tool whose result is large enough that a few iterations blow the (generous) default budget.
  const bigReader = {
    name: "read_big",
    description: "Reads a large document",
    inputSchema: { type: "object" },
    execute: () => Promise.resolve("PAYLOAD-".repeat(30_000)), // ~240k chars per call
  };

  it("summarizes the oldest middle once over budget, preserves head + recent turns, meters the summary", async () => {
    // Four tool iterations grow the conversation to 9 messages (~960k chars) — past the default
    // ~600k-char budget — then a fifth turn fires compaction before the final answer.
    const rec = recordedIo(OPENAI_MODEL, [
      () => openAiToolCalls([{ id: "c1", name: "read_big", args: {} }]),
      () => openAiToolCalls([{ id: "c2", name: "read_big", args: {} }]),
      () => openAiToolCalls([{ id: "c3", name: "read_big", args: {} }]),
      () => openAiToolCalls([{ id: "c4", name: "read_big", args: {} }]),
      () => openAiText("SUMMARY: read four big docs; key fact is 42.", { in: 900, out: 30 }),
      () => openAiText("final answer", { in: 20, out: 5 }),
    ]);

    const result = await runAgentLeaf("THE-ORIGINAL-TASK", { tools: [bigReader] }, rec.io);
    expect(result).toBe("final answer");

    // Six model calls total: four tool turns + ONE summarization call + the final answer turn.
    expect(rec.requests).toHaveLength(6);
    // The summarization call (request index 4) REUSES the loop's prefix — the same messages +
    // tools — with the digest instruction appended, so it reads the prompt cache instead of
    // reprocessing a fresh transcript. It therefore carries the task, the tool, and the instruction.
    const summaryReq = rec.requests[4]?.body ?? "";
    expect(summaryReq).toContain("Compact the conversation so far into a concise digest");
    expect(summaryReq).toContain("THE-ORIGINAL-TASK");
    expect(summaryReq).toContain('"read_big"'); // tools advertised for cache-prefix parity
    // The final turn's request carries: the ORIGINAL task (head preserved), the summary text
    // (middle replaced), and the most-recent tool result (recent tail preserved).
    const finalReq = rec.requests[5]?.body ?? "";
    expect(finalReq).toContain("THE-ORIGINAL-TASK");
    expect(finalReq).toContain("SUMMARY: read four big docs; key fact is 42.");
    expect(finalReq).toContain("PAYLOAD-"); // the freshest tool_results survived verbatim

    // The summarization call's usage was reported to the budget authority like any other turn.
    expect(rec.usage).toContainEqual({
      modelRef: "test-model",
      usage: { inputTokens: 900, outputTokens: 30 },
    });
  });

  it("brackets the work with compaction_started/ended carrying the numbers behind it", async () => {
    const rec = recordedIo(OPENAI_MODEL, [
      () => openAiToolCalls([{ id: "c1", name: "read_big", args: {} }]),
      () => openAiToolCalls([{ id: "c2", name: "read_big", args: {} }]),
      () => openAiToolCalls([{ id: "c3", name: "read_big", args: {} }]),
      () => openAiToolCalls([{ id: "c4", name: "read_big", args: {} }]),
      () => openAiText("SUMMARY: four big docs.", { in: 900, out: 30 }),
      () => openAiText("final answer", { in: 20, out: 5 }),
    ]);
    await runAgentLeaf("THE-ORIGINAL-TASK", { tools: [bigReader] }, rec.io);

    const started = rec.events.filter((e) => e.body.kind === "compaction_started");
    const ended = rec.events.filter((e) => e.body.kind === "compaction_ended");
    // Always bracketed: every started gets an ended, whatever the pass managed to do.
    expect(started.length).toBe(ended.length);
    expect(started.length).toBeGreaterThan(0);

    // started: the size that tripped it, and the budget it crossed.
    const s = started[0]?.body as { tokens: number; budget: number; agentId?: string };
    expect(s.tokens).toBeGreaterThan(s.budget);
    expect(s.agentId).toBeDefined(); // required by the SDK schema; concurrent leaves must be separable

    // Exactly ONE pass paid for a digest — matching the single summarization request the loop made.
    const methods = ended.map((e) => (e.body as { method: string }).method);
    expect(methods.filter((m) => m === "summarized")).toHaveLength(1);

    // Compare WITHIN a pair: passes interleave with turns, so the conversation grows between them.
    const i = methods.indexOf("summarized");
    const paidStart = started[i]?.body as { tokens: number };
    const paidEnd = ended[i]?.body as { tokens: number; reclaimed: number };
    expect(paidEnd.reclaimed).toBeGreaterThan(0);
    expect(paidEnd.tokens).toBeLessThan(paidStart.tokens);
    // reclaimed = round(before-after); tokens are round(before) and round(after) — three INDEPENDENT
    // roundings, so the identity holds only to within 1 (don't assert exact equality; it's flaky).
    expect(Math.abs(paidEnd.reclaimed - (paidStart.tokens - paidEnd.tokens))).toBeLessThanOrEqual(
      1,
    );

    /**
     * This payload's recent tail ALONE outweighs the budget, so later iterations go over, find
     * nothing worth reclaiming, and report `none`. That is the documented loop-safety path (proceed
     * and let the provider speak) -- and it is worth surfacing: a run reporting `none` every turn is
     * thrashing at its ceiling, which is precisely the diagnostic these events exist to give.
     */
    for (const m of methods) expect(["summarized", "deduped", "none"]).toContain(m);
  });

  it("reports the window that sized the budget, and omits it when the seam never said", async () => {
    // The local seam reports no contextTokens ⇒ the conservative fallback budget ⇒ no window to show.
    const rec = recordedIo(OPENAI_MODEL, [
      () => openAiToolCalls([{ id: "c1", name: "read_big", args: {} }]),
      () => openAiToolCalls([{ id: "c2", name: "read_big", args: {} }]),
      () => openAiToolCalls([{ id: "c3", name: "read_big", args: {} }]),
      () => openAiToolCalls([{ id: "c4", name: "read_big", args: {} }]),
      () => openAiText("SUMMARY", { in: 9, out: 3 }),
      () => openAiText("done", { in: 1, out: 1 }),
    ]);
    await runAgentLeaf("task", { tools: [bigReader] }, rec.io);
    const started = rec.events.find((e) => e.body.kind === "compaction_started");
    expect(started?.body).not.toHaveProperty("contextTokens");
  });

  it("emits NOTHING when the conversation is in budget — silence is the normal path", async () => {
    const rec = recordedIo(OPENAI_MODEL, [
      () => openAiToolCalls([{ id: "c1", name: "double", args: { n: 21 } }]),
      () => openAiText("42"),
    ]);
    const doubler = {
      name: "double",
      description: "Doubles",
      inputSchema: { type: "object" },
      execute: () => Promise.resolve("42"),
    };
    await runAgentLeaf("double 21", { tools: [doubler] }, rec.io);
    expect(rec.events.some((e) => e.body.kind.startsWith("compaction_"))).toBe(false);
  });

  it("does NOT compact a normal-length conversation (the budget is a safety valve, not routine)", async () => {
    const rec = recordedIo(OPENAI_MODEL, [
      () => openAiToolCalls([{ id: "c1", name: "double", args: { n: 21 } }]),
      () => openAiText("42"),
    ]);
    const doubler = {
      name: "double",
      description: "Doubles",
      inputSchema: { type: "object" },
      execute: () => Promise.resolve("42"),
    };
    await runAgentLeaf("double 21", { tools: [doubler] }, rec.io);
    // Exactly two model calls: a short run never trips summarization.
    expect(rec.requests).toHaveLength(2);
    expect(rec.requests.some((r) => r.body.includes("Compact the conversation so far"))).toBe(
      false,
    );
  });

  it("redacts secret values out of the summary before it re-enters model context", async () => {
    const redactor = new Redactor();
    redactor.add("API_SECRET", "sk-leaky-secret-value");
    const rec = recordedIo(
      OPENAI_MODEL,
      [
        () => openAiToolCalls([{ id: "c1", name: "read_big", args: {} }]),
        () => openAiToolCalls([{ id: "c2", name: "read_big", args: {} }]),
        () => openAiToolCalls([{ id: "c3", name: "read_big", args: {} }]),
        () => openAiToolCalls([{ id: "c4", name: "read_big", args: {} }]),
        // The summarizer (mis)echoes a secret into its output; the loop must scrub it on re-entry.
        () => openAiText("digest mentioning sk-leaky-secret-value verbatim", { in: 5, out: 5 }),
        () => openAiText("ok", { in: 1, out: 1 }),
      ],
      { redactor },
    );
    await runAgentLeaf("task", { tools: [bigReader] }, rec.io);
    const finalReq = rec.requests[5]?.body ?? "";
    expect(finalReq).not.toContain("sk-leaky-secret-value");
    expect(finalReq).toContain("[redacted:API_SECRET]");
  });
});

describe("runAgentLeaf — repetition guard", () => {
  const spin = {
    name: "spin",
    description: "no-op",
    inputSchema: { type: "object" },
    execute: () => Promise.resolve("still spinning"),
  };

  it("ends a run that repeats the identical tool call without progress", async () => {
    const rec = recordedIo(
      OPENAI_MODEL,
      Array.from(
        { length: 5 },
        () => () => openAiToolCalls([{ id: "c", name: "spin", args: { n: 1 } }]),
      ),
    );
    await expect(runAgentLeaf("go", { tools: [spin] }, rec.io)).rejects.toThrow(
      /repeating the same tool call/,
    );
  });

  it("does NOT trip when each turn issues a different tool call (real progress)", async () => {
    const rec = recordedIo(OPENAI_MODEL, [
      () => openAiToolCalls([{ id: "c1", name: "spin", args: { n: 1 } }]),
      () => openAiToolCalls([{ id: "c2", name: "spin", args: { n: 2 } }]),
      () => openAiToolCalls([{ id: "c3", name: "spin", args: { n: 3 } }]),
      () => openAiToolCalls([{ id: "c4", name: "spin", args: { n: 4 } }]),
      () => openAiText("done"),
    ]);
    expect(await runAgentLeaf("go", { tools: [spin] }, rec.io)).toBe("done");
  });

  it("nudges once at the soft threshold, then recovers if the model changes course", async () => {
    const rec = recordedIo(OPENAI_MODEL, [
      () => openAiToolCalls([{ id: "c", name: "spin", args: { n: 1 } }]),
      () => openAiToolCalls([{ id: "c", name: "spin", args: { n: 1 } }]),
      () => openAiToolCalls([{ id: "c", name: "spin", args: { n: 1 } }]), // 3rd repeat → nudge
      () => openAiText("ok, changing course"),
    ]);
    expect(await runAgentLeaf("go", { tools: [spin] }, rec.io)).toBe("ok, changing course");
    // The nudge rode as an appended message on the 4th request.
    expect(rec.requests[3]?.body).toContain("No progress");
  });
});

// ----------------------------------------------------------------------------
// Iteration cap (opt-in, soft landing) + wrap-up hints
// ----------------------------------------------------------------------------

describe("runAgentLeaf — iteration cap + wrap-up hints", () => {
  const doubler = {
    name: "double",
    description: "Doubles a number",
    inputSchema: { type: "object", properties: { n: { type: "number" } }, required: ["n"] },
    // Distinct RESULT per call (echoes the input) so neither the repetition guard (keyed on the call)
    // nor the no-progress guard (keyed on the observation) fires — these tests exercise cap/hints only.
    execute: (input: unknown) => Promise.resolve(`doubled ${String((input as { n: unknown }).n)}`),
  };
  // Distinct args each turn so the repetition guard never fires — these exercise the cap/hints only.
  const toolTurns = (n: number) =>
    Array.from(
      { length: n },
      (_, i) => () => openAiToolCalls([{ id: `c${String(i)}`, name: "double", args: { n: i } }]),
    );

  it("maxIterations forces a tools-off final answer instead of a hard failure", async () => {
    // cap=3: turns 1–3 may call tools; turn 4 runs with tools WITHHELD, so the model must conclude.
    const rec = recordedIo(OPENAI_MODEL, [
      ...toolTurns(3),
      () => openAiText("final answer from the work so far"),
    ]);
    const opts: LeafOpts = { tools: [doubler], maxIterations: 3 };
    await expect(runAgentLeaf("p", opts, rec.io)).resolves.toBe(
      "final answer from the work so far",
    );
    // Exactly cap + 1 model calls: three tool turns, then the forced conclusion.
    expect(rec.requests).toHaveLength(4);
    // The first three turns advertised the tool; the forced final turn advertised NONE.
    expect(rec.requests[0]?.body).toContain('"tools"');
    expect(rec.requests[3]?.body).not.toContain('"tools"');
  });

  it("warns the model as it nears a maxIterations ceiling", async () => {
    // cap=6, CAP_WARN_AT=3 → the countdown fires after turn 3 (3 turns remaining), so it rides the
    // 4th request. Six tool turns + the forced conclusion = 7 model calls.
    const rec = recordedIo(OPENAI_MODEL, [...toolTurns(6), () => openAiText("done")]);
    const opts: LeafOpts = { tools: [doubler], maxIterations: 6 };
    await expect(runAgentLeaf("p", opts, rec.io)).resolves.toBe("done");
    expect(rec.requests).toHaveLength(7);
    expect(rec.requests[3]?.body).toContain("before this agent() call must wrap up");
  });

  it("an unbounded loop gets a periodic wrap-up reminder", async () => {
    // No cap → the reminder fires every TURN_HINT_INTERVAL (20) turns, riding the 21st request.
    const rec = recordedIo(OPENAI_MODEL, [...toolTurns(21), () => openAiText("wrapped up")]);
    await expect(runAgentLeaf("p", { tools: [doubler] }, rec.io)).resolves.toBe("wrapped up");
    expect(rec.requests[20]?.body).toContain("You've now taken 20 tool-calling turns");
  });

  it("ignores a non-positive or non-integer maxIterations (treated as no cap)", async () => {
    // A bogus cap must not silently bound the loop — 30 tool turns still run to completion.
    const rec = recordedIo(OPENAI_MODEL, [...toolTurns(30), () => openAiText("still unbounded")]);
    const opts: LeafOpts = { tools: [doubler], maxIterations: 0 };
    await expect(runAgentLeaf("p", opts, rec.io)).resolves.toBe("still unbounded");
    expect(rec.requests).toHaveLength(31);
  });
});

describe("runAgentLeaf — consecutive-error guard", () => {
  const boom = {
    name: "boom",
    description: "always fails",
    inputSchema: { type: "object" },
    execute: () => Promise.reject(new Error("boom")),
  };
  const ok = {
    name: "ok",
    description: "always succeeds",
    inputSchema: { type: "object" },
    execute: () => Promise.resolve("done-ok"),
  };
  // Distinct args each turn so the repetition guard (which keys on the signature) never fires — this
  // isolates the consecutive-error guard.
  const boomTurns = (n: number) =>
    Array.from(
      { length: n },
      (_, i) => () => openAiToolCalls([{ id: `e${String(i)}`, name: "boom", args: { n: i } }]),
    );

  it("ends the run after five consecutive all-error turns", async () => {
    const rec = recordedIo(OPENAI_MODEL, boomTurns(5));
    await expect(runAgentLeaf("go", { tools: [boom] }, rec.io)).rejects.toThrow(
      /consecutive tool calls that all failed/,
    );
    expect(rec.requests).toHaveLength(5);
  });

  it("nudges once at the third consecutive all-error turn, then lets the model recover", async () => {
    const rec = recordedIo(OPENAI_MODEL, [
      ...boomTurns(3),
      () => openAiText("giving up gracefully"),
    ]);
    expect(await runAgentLeaf("go", { tools: [boom] }, rec.io)).toBe("giving up gracefully");
    // The nudge rode as an appended message on the 4th request.
    expect(rec.requests[3]?.body).toContain("last several tool calls have all failed");
  });

  it("a successful tool result resets the counter (no hard stop)", async () => {
    const rec = recordedIo(OPENAI_MODEL, [
      ...boomTurns(4),
      () => openAiToolCalls([{ id: "s", name: "ok", args: {} }]), // success resets the run of errors
      ...boomTurns(4),
      () => openAiText("survived"),
    ]);
    expect(await runAgentLeaf("go", { tools: [boom, ok] }, rec.io)).toBe("survived");
  });
});

describe("runAgentLeaf — no-progress guard", () => {
  // A read-only GATHER tool — named like the built-in `grep` so the guard classifies it as gathering;
  // `builtins: "none"` keeps it from colliding with the real one — that returns the SAME content no
  // matter its args, so the model re-searches and learns nothing new.
  const staleGrep = {
    name: "grep",
    description: "a search that keeps returning the same thing",
    inputSchema: { type: "object", properties: { n: { type: "number" } } },
    execute: () => Promise.resolve("the same unchanging content"),
  };
  // A gather that returns DISTINCT content per call — genuine new information.
  const freshGrep = {
    name: "grep",
    description: "a search that finds something new each call",
    inputSchema: { type: "object", properties: { n: { type: "number" } } },
    execute: (input: unknown) => Promise.resolve(`finding #${String((input as { n: unknown }).n)}`),
  };
  // A MUTATION tool — its name is NOT in the read-only set — whose confirmation is low-entropy and
  // repeats. Editing IS progress and must NOT be mistaken for a gathering stall (the false-positive fix).
  const editish = {
    name: "write",
    description: "makes a change; returns a repeating confirmation",
    inputSchema: { type: "object", properties: { n: { type: "number" } } },
    execute: () => Promise.resolve("edited file (1 replacement)"),
  };
  // Distinct ARGS each turn so the repetition guard (keyed on the call) never fires — isolates the
  // no-progress guard.
  const varyingCalls = (tool: string, n: number) =>
    Array.from(
      { length: n },
      (_, i) => () => openAiToolCalls([{ id: `c${String(i)}`, name: tool, args: { n: i } }]),
    );

  it("ends a run whose read-only gathers keep surfacing nothing new", async () => {
    // 9 distinct grep calls all returning the same content: turn 1 is new, turns 2–9 add nothing, so
    // noProgressTurns climbs to the hard stop (8) on the 9th and ends the run.
    const rec = recordedIo(OPENAI_MODEL, varyingCalls("grep", 9));
    await expect(
      runAgentLeaf("go", { tools: [staleGrep], builtins: "none" }, rec.io),
    ).rejects.toThrow(/surfacing anything new/);
  });

  it("does NOT trip on repeated MUTATIONS with a low-entropy confirmation (editing is progress)", async () => {
    // The false-positive fix: an agent making the same kind of edit over and over — "edited file
    // (1 replacement)" every time — is WORKING, not stalling. 20 such turns must complete.
    const rec = recordedIo(OPENAI_MODEL, [
      ...varyingCalls("write", 20),
      () => openAiText("all edits done"),
    ]);
    expect(await runAgentLeaf("go", { tools: [editish], builtins: "none" }, rec.io)).toBe(
      "all edits done",
    );
  });

  it("does NOT trip when a gather surfaces something new each call", async () => {
    const rec = recordedIo(OPENAI_MODEL, [
      ...varyingCalls("grep", 12),
      () => openAiText("learned plenty"),
    ]);
    expect(await runAgentLeaf("go", { tools: [freshGrep], builtins: "none" }, rec.io)).toBe(
      "learned plenty",
    );
  });

  it("nudges once at the soft threshold, then recovers when a mutation makes progress", async () => {
    // 5 redundant gathers push noProgressTurns to the soft threshold (4) on the 5th; the nudge rides
    // the 6th request, where a write (a mutation) makes progress and resets the count.
    const rec = recordedIo(OPENAI_MODEL, [
      ...varyingCalls("grep", 5),
      () => openAiToolCalls([{ id: "act", name: "write", args: { n: 99 } }]),
      () => openAiText("recovered"),
    ]);
    expect(
      await runAgentLeaf("go", { tools: [staleGrep, editish], builtins: "none" }, rec.io),
    ).toBe("recovered");
    expect(rec.requests[5]?.body).toContain("nothing you hadn't already seen");
  });

  it("stops a capless leaf at the default backstop with a tools-withheld final answer", async () => {
    // A mutation tool counts as progress every turn, so neither the repetition nor the no-progress
    // guard fires — ONLY the backstop stops it: turns 1..500 call tools; turn 501 withholds them,
    // forcing the model to conclude (a soft landing).
    const rec = recordedIo(OPENAI_MODEL, [
      ...varyingCalls("write", DEFAULT_MAX_ITERATIONS),
      () => openAiText("final answer at the backstop"),
    ]);
    await expect(runAgentLeaf("go", { tools: [editish], builtins: "none" }, rec.io)).resolves.toBe(
      "final answer at the backstop",
    );
    expect(rec.requests).toHaveLength(DEFAULT_MAX_ITERATIONS + 1);
    expect(rec.requests[DEFAULT_MAX_ITERATIONS]?.body).not.toContain('"tools"');
  });

  it("does NOT trip when the model re-reads content compaction evicted (guard tracks the live context)", async () => {
    // The false positive that killed the docs-cleanup workflow's big reconcile jobs: as a leaf's
    // conversation grows, compaction summarizes early read/grep results OUT of context. Re-fetching
    // that evicted content is legitimate NEW work (the model can no longer see it) — but if the
    // guard's "seen" set were an ever-growing side-record, every post-compaction re-read would score
    // as "nothing new" and the run of them would trip the hard stop. The fix realigns "seen" to the
    // live transcript after each compaction. Here 8 big DISTINCT docs are gathered (progress each),
    // compaction evicts the early ones, then all 8 are re-read — with the fix the run finishes.
    const docFor = (doc: number): string => `DOC-${String(doc)}-` + "X".repeat(300_000); // ~105k tok
    const bigGrep = {
      name: "grep", // a read-only GATHER name; builtins:"none" keeps it off the real builtin
      description: "returns a large document selected by `doc`",
      inputSchema: {
        type: "object",
        properties: { doc: { type: "number" }, seq: { type: "number" } },
      },
      execute: (input: unknown) => Promise.resolve(docFor((input as { doc: number }).doc)),
    };
    // 8 distinct docs gathered, then the SAME 8 re-read. `seq` makes every tool-call signature unique
    // so the repetition guard (keyed on the call) stays out of it — this isolates the no-progress one.
    const gathers: Record<string, unknown>[] = [
      ...Array.from({ length: 8 }, (_, i) => ({ doc: i + 1, seq: i })),
      ...Array.from({ length: 8 }, (_, i) => ({ doc: i + 1, seq: i + 8 })),
    ];

    const rec = recordedIo(OPENAI_MODEL, [() => openAiText("unused")]);
    const usage = { inputTokens: 5, outputTokens: 5 };
    let step = 0;
    // Bespoke seam: drive the scripted gathers, answer the internal summarization call with a tiny
    // digest (so compaction actually shrinks the context), then give the final answer.
    rec.io.streamModel = (req): Promise<ModelTurnResult> => {
      const last = req.messages.at(-1);
      const isSummary =
        last?.role === "user" &&
        typeof last.content === "string" &&
        last.content.startsWith("Compact the conversation");
      if (isSummary) {
        return Promise.resolve({
          turn: { text: "DIGEST: gathered several docs.", toolCalls: [], usage, wantsTools: false },
          modelRef: "m",
        });
      }
      const args = step < gathers.length ? gathers[step] : undefined;
      if (args !== undefined) {
        step += 1;
        return Promise.resolve({
          turn: {
            text: "",
            toolCalls: [{ id: `g${String(step)}`, name: "grep", input: args }],
            usage,
            wantsTools: true,
          },
          modelRef: "m",
        });
      }
      return Promise.resolve({
        turn: { text: "done", toolCalls: [], usage, wantsTools: false },
        modelRef: "m",
      });
    };

    const result = await runAgentLeaf(
      "reconcile the docs",
      { tools: [bigGrep], builtins: "none" },
      rec.io,
    );
    expect(result).toBe("done");
    // The path was genuinely exercised: compaction actually EVICTED content via the summarize splice
    // (not just fired) — that eviction is the whole precondition for the re-reads to be new again.
    // Without it this test would prove nothing (and the guard's realignment couldn't matter).
    const summarized = rec.events.filter(
      (e) =>
        e.body.kind === "compaction_ended" &&
        (e.body as { method: string }).method === "summarized",
    );
    expect(summarized.length).toBeGreaterThan(0);
  });
});

describe("rebuildSeenObservations", () => {
  const asst = (id: string, name: string): ChatMessage => ({
    role: "assistant",
    text: "",
    toolCalls: [{ id, name, input: {} }],
  });
  const results = (...rs: { id: string; content: string; isError?: boolean }[]): ChatMessage => ({
    role: "tool_results",
    results: rs.map((r) => ({ id: r.id, content: r.content, isError: r.isError ?? false })),
  });

  it("includes only successful READ-ONLY gather results", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "go" },
      asst("a", "grep"),
      results({ id: "a", content: "GREP-OUT" }),
      asst("b", "write"), // a MUTATION — excluded (mutations never consult the seen set)
      results({ id: "b", content: "edited file (1 replacement)" }),
      asst("c", "read"),
      results({ id: "c", content: "FILE-BODY" }),
    ];
    const seen = rebuildSeenObservations(messages);
    // grep + read results are in; the write result is not.
    expect(seen.size).toBe(2);
    // A subsequent re-read of the SAME content would hash-match one of these.
    const again = rebuildSeenObservations([
      asst("z", "read"),
      results({ id: "z", content: "FILE-BODY" }),
    ]);
    expect(seen.has([...again][0] ?? "")).toBe(true);
  });

  it("excludes errored results and results whose naming turn was summarized away", () => {
    const messages: ChatMessage[] = [
      asst("a", "grep"),
      results({ id: "a", content: "boom", isError: true }), // errored — not "seen"
      // A tool_results whose assistant turn is gone (compaction split the pair) — unmatchable, skipped.
      results({ id: "orphan", content: "ORPHANED-READ" }),
    ];
    expect(rebuildSeenObservations(messages).size).toBe(0);
  });

  it("drops an observation that is no longer present after compaction", () => {
    const before = rebuildSeenObservations([
      asst("a", "read"),
      results({ id: "a", content: "DOC-1" }),
    ]);
    expect(before.size).toBe(1);
    // Compaction replaced that read with a digest (a plain user message): the content is gone, so
    // the guard must no longer consider it "seen" — a re-read of DOC-1 is new work again.
    const after = rebuildSeenObservations([{ role: "user", content: "DIGEST: read DOC-1" }]);
    expect(after.size).toBe(0);
  });
});

describe("runAgentLeaf — memory", () => {
  it("announces the dir, advertises scoped file tools, and round-trips a write", async () => {
    const workspaceDir = tempDir("bw-mem-ws-");
    const rec = recordedIo(
      OPENAI_MODEL,
      [
        () =>
          openAiToolCalls([
            { id: "c1", name: "memory_write", args: { path: "notes.md", content: "remember me" } },
          ]),
        () => openAiText("stored"),
      ],
      { workspaceDir },
    );
    const result = await runAgentLeaf("note this down", { memory: "mem/agent-a" }, rec.io);

    expect(result).toBe("stored");
    expect(rec.memoryUsed).toEqual(["mem/agent-a"]);
    // The memory index preamble + tools were offered to the model.
    expect(rec.requests[0]?.body).toContain("memory_write");
    expect(rec.requests[0]?.body).toContain("memory is empty");
    // The write landed inside the scoped dir, on disk.
    expect(readFileSync(join(workspaceDir, "mem/agent-a/notes.md"), "utf8")).toBe("remember me");
  });

  it("loads the existing index (file list + index.md) at turn start", async () => {
    const workspaceDir = tempDir("bw-mem-ws-");
    mkdirSync(join(workspaceDir, "mem"), { recursive: true });
    writeFileSync(join(workspaceDir, "mem/index.md"), "Catalog: one note so far.", "utf8");
    writeFileSync(join(workspaceDir, "mem/old-note.md"), "previous run wrote this", "utf8");
    const rec = recordedIo(OPENAI_MODEL, [() => openAiText("ok")], { workspaceDir });
    await runAgentLeaf("continue", { memory: "mem" }, rec.io);

    const sent = rec.requests[0]?.body ?? "";
    expect(sent).toContain("Catalog: one note so far.");
    expect(sent).toContain("old-note.md");
  });

  it("contains model-chosen paths inside the memory dir", async () => {
    const workspaceDir = tempDir("bw-mem-ws-");
    const rec = recordedIo(
      OPENAI_MODEL,
      [
        () =>
          openAiToolCalls([
            { id: "c1", name: "memory_write", args: { path: "../../escape.txt", content: "x" } },
          ]),
        () => openAiText("done"),
      ],
      { workspaceDir },
    );
    await runAgentLeaf("p", { memory: "mem" }, rec.io);
    // The escape became a tool ERROR result; nothing was written outside the dir.
    expect(kinds(rec)).toContain("tool_call_error");
    expect(rec.requests[1]?.body).toContain("escapes the memory directory");
  });

  it("rejects malformed memory paths before any network call", async () => {
    const rec = recordedIo(OPENAI_MODEL, [() => openAiText("never")]);
    for (const bad of ["../up", "/absolute", "a/../b"]) {
      await expect(runAgentLeaf("p", { memory: bad }, rec.io)).rejects.toThrow(
        /workspace-relative directory/,
      );
    }
    expect(rec.requests).toHaveLength(0);
  });
});

// ----------------------------------------------------------------------------
// Parallel tool dispatch + run-fatal tool errors
// ----------------------------------------------------------------------------

describe("runAgentLeaf — parallel tool dispatch", () => {
  const delayed = (name: string, ms: number) => ({
    name,
    description: name,
    inputSchema: { type: "object" },
    execute: async (): Promise<string> => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      order.push(name);
      return `${name}-ok`;
    },
  });
  let order: string[] = [];
  afterEach(() => {
    order = [];
  });

  it("runs a turn's tool calls CONCURRENTLY (a later-listed fast tool finishes first)", async () => {
    const rec = recordedIo(OPENAI_MODEL, [
      () =>
        openAiToolCalls([
          { id: "a", name: "slow", args: {} },
          { id: "b", name: "fast", args: {} },
        ]),
      () => openAiText("both done"),
    ]);
    const result = await runAgentLeaf(
      "go",
      { builtins: "none", tools: [delayed("slow", 25), delayed("fast", 1)] },
      rec.io,
    );
    expect(result).toBe("both done");
    // Concurrent: the fast tool (listed SECOND) finished first. Sequential would be ["slow","fast"].
    expect(order).toEqual(["fast", "slow"]);
    // Both results came back into model context (order preserved by Promise.all).
    expect(rec.requests[1]?.body).toContain("slow-ok");
    expect(rec.requests[1]?.body).toContain("fast-ok");
  });

  it("a run-fatal tool error (BUDGET_EXCEEDED) ends the run instead of becoming a tool result", async () => {
    const bomb = {
      name: "spendy",
      description: "x",
      inputSchema: { type: "object" },
      execute: () => Promise.reject(new EngineError("BUDGET_EXCEEDED", "cap hit")),
    };
    const rec = recordedIo(OPENAI_MODEL, [
      () => openAiToolCalls([{ id: "c1", name: "spendy", args: {} }]),
      () => openAiText("should never run"),
    ]);
    await expect(runAgentLeaf("p", { builtins: "none", tools: [bomb] }, rec.io)).rejects.toThrow(
      /cap hit/,
    );
    // The breach ended the run — there was no second model call.
    expect(rec.requests).toHaveLength(1);
    const ended = rec.events.at(-1)?.body;
    expect(ended !== undefined && ended.kind === "turn_ended" ? ended.reason : "").toBe("error");
  });
});

// ----------------------------------------------------------------------------
// subagent (one-level, attenuated delegation as a tool)
// ----------------------------------------------------------------------------

describe("runAgentLeaf — subagent", () => {
  it("is NOT offered when the io cannot fork a leaf", async () => {
    const rec = recordedIo(OPENAI_MODEL, [() => openAiText("ok")]);
    await runAgentLeaf("p", undefined, rec.io);
    expect(rec.requests[0]?.body ?? "").not.toContain('"subagent"');
  });

  it("is offered (default-on) when the io can fork, runs a child, and the child gets NO subagent tool", async () => {
    const rec = recordedIo(OPENAI_MODEL, [
      () =>
        openAiToolCalls([
          { id: "s1", name: "subagent", args: { prompt: "research X", name: "helper" } },
        ]),
      () => openAiText("child found the answer"), // the child leaf's only model call
      () => openAiText("parent summary: child found the answer"), // parent's final turn
    ]);
    rec.io.forkLeaf = ({ name }) => ({
      ...rec.io,
      identity: { agentId: "agent-2", ...(name !== undefined ? { agentName: name } : {}) },
    });

    const result = await runAgentLeaf("delegate it", undefined, rec.io);

    expect(result).toBe("parent summary: child found the answer");
    // The parent was offered the subagent tool…
    expect(rec.requests[0]?.body ?? "").toContain('"subagent"');
    // …the child ran a real leaf (advertised the sandbox built-ins) but NOT subagent (one level)…
    expect(rec.requests[1]?.body ?? "").toContain('"read"');
    expect(rec.requests[1]?.body ?? "").not.toContain('"subagent"');
    // …the child's result returned to the parent as the tool result…
    expect(rec.requests[2]?.body ?? "").toContain("child found the answer");
    // …and the child leaf emitted under its OWN agentId.
    const childEnded = rec.events.find((e) => {
      const b = e.body;
      return b.kind === "turn_ended" && b.agentId === "agent-2";
    });
    expect(childEnded).toBeDefined();
  });
});

describe("ContextCalibrator", () => {
  const msgs = (chars: number): ChatMessage[] => [{ role: "user", content: "X".repeat(chars) }];

  it("is neutral before any turn is observed (trusts the raw estimate)", () => {
    const c = new ContextCalibrator();
    expect(c.scale()).toBe(1);
    // 400 prose chars ≈ 100 tokens + per-message overhead.
    expect(c.estimate(msgs(400))).toBeCloseTo(104, 0);
  });

  it("learns the provider's real ratio and scales estimates by it", () => {
    const c = new ContextCalibrator();
    // The request really cost 2x what we predicted (system + tool schemas we never counted).
    c.observe(1000, 2000);
    expect(c.scale()).toBeCloseTo(2, 5);
    expect(c.estimate(msgs(400))).toBeCloseTo(104 * 2, 0);
  });

  it("ignores a turn with no reported usage, and nonsense values", () => {
    const c = new ContextCalibrator();
    c.observe(1000, undefined);
    c.observe(1000, 0);
    c.observe(0, 5000);
    expect(c.scale()).toBe(1);
  });

  /** Under-estimating context is the dangerous direction — it is what let a conversation sail past
   *  the model's window before compaction fired. So the ratio jumps UP at once and only drifts down. */
  it("jumps up immediately but decays down only slowly (conservative)", () => {
    const c = new ContextCalibrator();
    c.observe(1000, 3000); // a fat turn: ratio 3
    expect(c.scale()).toBeCloseTo(3, 5);

    c.observe(1000, 1000); // a calm turn would imply ratio 1 — must NOT drop straight there
    expect(c.scale()).toBeGreaterThan(2.9);

    for (let i = 0; i < 50; i++) c.observe(1000, 1000);
    expect(c.scale()).toBeLessThan(2); // …but sustained calm does bring it down
  });

  it("clamps the ratio so a wild provider number can't disable or pin the guardrail", () => {
    const high = new ContextCalibrator();
    high.observe(1, 1_000_000);
    expect(high.scale()).toBe(4); // MAX_RATIO

    const low = new ContextCalibrator();
    low.observe(1000, 10); // provider under-reports wildly
    expect(low.scale()).toBe(1); // floored: never estimate BELOW the raw estimate
  });

  it("estimateOne scales a single message the same way", () => {
    const c = new ContextCalibrator();
    c.observe(1000, 2000);
    const one: ChatMessage = { role: "user", content: "X".repeat(400) };
    expect(c.estimateOne(one)).toBeCloseTo(c.estimate([one]), 5);
  });
});

// `attachments` is untrusted runtime input like every other AgentOptions field (author programs are
// never type-checked — see tools.ts). A wrong shape used to reach the PROVIDER and fail there, so
// the leaf retried the doomed request 5 times before surfacing an internal TypeError. It must now
// fail at the boundary, for free.
describe("runAgentLeaf — type-invalid `attachments` fails before any model call", () => {
  async function reject(opts: unknown): Promise<{ err: EngineError; calls: number }> {
    const rec = recordedIo(OPENAI_MODEL, [() => openAiText("ok", { in: 1, out: 1 })]);
    try {
      await runAgentLeaf("hi", opts as AgentOptions, rec.io);
    } catch (err) {
      if (err instanceof EngineError) return { err, calls: rec.requests.length };
      throw new Error(`expected an EngineError, got ${String(err)}`);
    }
    throw new Error("expected runAgentLeaf to throw");
  }

  it("rejects a non-array `attachments` (it used to TypeError on .map)", async () => {
    const { err } = await reject({ attachments: {} });
    expect(err.code).toBe("VALIDATION");
    expect(err.message).toContain("`attachments`");
    expect(err.message).not.toContain("Cannot read properties");
    expect((await reject({ attachments: "x" })).err.message).toContain("must be an array");
  });

  it("rejects a malformed attachment by naming the offending field", async () => {
    expect((await reject({ attachments: [null] })).err.message).toContain("malformed attachment");
    expect((await reject({ attachments: [{}] })).err.message).toContain("mimeType");
  });

  it("requires exactly one of `data`/`url` — neither and both are both wrong", async () => {
    const neither = await reject({ attachments: [{ mimeType: "image/png" }] });
    expect(neither.err.message).toContain("exactly one");
    const both = await reject({
      attachments: [{ mimeType: "image/png", data: "AAAA", url: "https://x/y.png" }],
    });
    expect(both.err.message).toContain("exactly one");
  });

  it("costs ZERO model calls — the old path burned 5 provider retries on a bad shape", async () => {
    expect((await reject({ attachments: [{}] })).calls).toBe(0);
  });

  it("still accepts well-formed attachments (both carriers)", async () => {
    const rec = recordedIo(OPENAI_MODEL, [() => openAiText("saw it", { in: 1, out: 1 })]);
    const result = await runAgentLeaf(
      "what is this?",
      {
        attachments: [
          { mimeType: "image/png", data: "AAAA", filename: "shot.png" },
          { mimeType: "application/pdf", url: "https://example.com/doc.pdf" },
        ],
      },
      rec.io,
    );
    expect(result).toBe("saw it");
    expect(rec.requests.length).toBe(1);
  });
});

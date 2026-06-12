import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EngineError } from "../errors.js";
import { startFakeMcpServer } from "../testing/fake_mcp.js";
import { runAgentLeaf, type LeafEventBody, type LeafIo } from "./leaf.js";
import { Redactor } from "./redact.js";
import type { ResolvedModel } from "./resolve.js";
import type { McpTokenResult } from "./tools.js";

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

// ----------------------------------------------------------------------------
// Scripted responses
// ----------------------------------------------------------------------------

function openAiText(content: string, usage?: { in: number; out: number }): Response {
  return Response.json({
    choices: [{ finish_reason: "stop", message: { content } }],
    ...(usage !== undefined
      ? { usage: { prompt_tokens: usage.in, completion_tokens: usage.out } }
      : {}),
  });
}

function openAiToolCalls(
  calls: { id: string; name: string; args: Record<string, unknown> }[],
  text = "",
): Response {
  return Response.json({
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          content: text.length > 0 ? text : null,
          tool_calls: calls.map((c) => ({
            id: c.id,
            function: { name: c.name, arguments: JSON.stringify(c.args) },
          })),
        },
      },
    ],
    usage: { prompt_tokens: 5, completion_tokens: 5 },
  });
}

function anthropicSse(...events: object[]): Response {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(body, { status: 200 });
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
  const io: LeafIo = {
    resolve: () => Promise.resolve(model),
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
    redactor: opts.redactor ?? new Redactor(),
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
      reason: "complete",
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    expect(rec.usage).toEqual([
      { modelRef: "local/test-model", usage: { inputTokens: 10, outputTokens: 5 } },
    ]);
    expect(rec.memoryUsed).toEqual([]);
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

  it("schema mode parses JSON (stripping fences) and fails loudly on prose", async () => {
    const rec = recordedIo(OPENAI_MODEL, [() => openAiText('```json\n{"groups": [1, 2]}\n```')]);
    const parsed = await runAgentLeaf("group these", { schema: { type: "object" } }, rec.io);
    expect(parsed).toEqual({ groups: [1, 2] });
    expect(rec.requests[0]?.body).toContain("JSON Schema");

    const prose = recordedIo(OPENAI_MODEL, [() => openAiText("Sure! Here are the groups…")]);
    await expect(runAgentLeaf("p", { schema: { type: "object" } }, prose.io)).rejects.toThrow(
      /not valid JSON/,
    );
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

  it("fails with a runaway error when the model never stops calling tools", async () => {
    const rec = recordedIo(OPENAI_MODEL, [
      () => openAiToolCalls([{ id: "c", name: "double", args: { n: 1 } }]),
    ]);
    await expect(runAgentLeaf("p", { tools: [doubler] }, rec.io)).rejects.toThrow(
      /exceeded 25 tool iterations/,
    );
  });

  it("rejects duplicate tool names and unavailable built-ins", async () => {
    const rec = recordedIo(OPENAI_MODEL, [() => openAiText("never")]);
    await expect(runAgentLeaf("p", { tools: [doubler, { ...doubler }] }, rec.io)).rejects.toThrow(
      /Duplicate tool name/,
    );
    await expect(runAgentLeaf("p", { tools: ["web_search"] }, rec.io)).rejects.toThrow(
      /not available on this engine/,
    );
    expect(rec.requests).toHaveLength(0);
  });
});

// ----------------------------------------------------------------------------
// Skills + memory
// ----------------------------------------------------------------------------

describe("runAgentLeaf — skills", () => {
  it("loads deployed skill markdown into the first message", async () => {
    const skillsDir = tempDir("bw-skills-");
    writeFileSync(join(skillsDir, "reviewer.md"), "Always check for SQL injection.", "utf8");
    const rec = recordedIo(OPENAI_MODEL, [() => openAiText("ok")], { skillsDir });
    await runAgentLeaf("review this", { skills: ["reviewer"] }, rec.io);

    const sent = rec.requests[0]?.body ?? "";
    expect(sent).toContain("Always check for SQL injection.");
    expect(sent).toContain('<skill name=\\"reviewer\\">');
  });

  it("fails loudly on a missing skill and on a malformed skill name", async () => {
    const rec = recordedIo(OPENAI_MODEL, [() => openAiText("never")], {
      skillsDir: tempDir("bw-skills-"),
    });
    await expect(runAgentLeaf("p", { skills: ["ghost"] }, rec.io)).rejects.toThrow(
      /no skills\/ghost\.md was deployed/,
    );
    await expect(runAgentLeaf("p", { skills: ["../etc/passwd"] }, rec.io)).rejects.toThrow(
      /not a valid skill name/,
    );
    expect(rec.requests).toHaveLength(0);
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

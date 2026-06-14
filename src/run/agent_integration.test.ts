// SPDX-License-Identifier: Apache-2.0

// End-to-end agent() integration: real child process, real IPC, and a real (local, fake)
// OpenAI-compatible provider — the full path a workflow's agent() call takes. This is where
// the redaction invariant and the usage-budget kill are proven against actual processes,
// not unit fakes.

import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { workflowManifestSchema, type WorkflowManifest } from "@boardwalk-labs/workflow";
import { Store } from "../store/store.js";
import { RunSupervisor } from "./supervisor.js";

const repoRoot = resolve(fileURLToPath(import.meta.url), "../../..");
const childEntryPath = join(repoRoot, "dist", "run", "child.js");

// ----------------------------------------------------------------------------
// A minimal OpenAI-compatible provider we fully control.
// ----------------------------------------------------------------------------

interface FakeProvider {
  port: number;
  requests: string[];
  /** Script the steady-state reply: text + token usage. */
  respondWith: (text: string, usage: { in: number; out: number }) => void;
  /** Queue full response bodies served (in order) BEFORE the steady-state reply. */
  queueResponses: (...bodies: object[]) => void;
  close: () => Promise<void>;
}

function startFakeProvider(): Promise<FakeProvider> {
  const requests: string[] = [];
  const queue: object[] = [];
  let reply = { text: "fake-reply", usage: { in: 1, out: 1 } };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      requests.push(body);
      res.setHeader("content-type", "application/json");
      const queued = queue.shift();
      res.end(
        JSON.stringify(
          queued ?? {
            choices: [{ finish_reason: "stop", message: { content: reply.text } }],
            usage: { prompt_tokens: reply.usage.in, completion_tokens: reply.usage.out },
          },
        ),
      );
    });
  });
  return new Promise((resolvePort) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolvePort({
        port,
        requests,
        respondWith: (text, usage) => {
          reply = { text, usage };
        },
        queueResponses: (...bodies) => {
          queue.push(...bodies);
        },
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

// ----------------------------------------------------------------------------

let provider: FakeProvider;

beforeAll(async () => {
  provider = await startFakeProvider();
}, 120_000);

afterAll(async () => {
  await provider.close();
});

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

function fixture(env: Record<string, string> = {}): {
  store: Store;
  supervisor: RunSupervisor;
  run: (
    name: string,
    program: string,
    meta?: Partial<WorkflowManifest>,
    input?: unknown,
  ) => Promise<string>;
} {
  const dataDir = mkdtempSync(join(tmpdir(), "bw-agent-test-"));
  const store = new Store(join(dataDir, "engine.db"));
  const supervisor = new RunSupervisor({
    store,
    dataDir,
    childEntryPath,
    // The managed (boardwalk) lane — the DEFAULT path — points at the fake gateway; one
    // explicit provider entry exercises the named-provider path.
    env: new Map(Object.entries({ ...env, BOARDWALK_API_KEY: "test-managed-key" })),
    envLabel: ".env (test fixture)",
    cancelGraceMs: 250,
    inference: {
      default_model: "default-test-model",
      boardwalk_base_url: `http://127.0.0.1:${String(provider.port)}/v1`,
      providers: { local: { base_url: `http://127.0.0.1:${String(provider.port)}/v1` } },
    },
  });
  cleanups.push(() => {
    supervisor.shutdown();
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const run = async (
    name: string,
    program: string,
    meta?: Partial<WorkflowManifest>,
    input?: unknown,
  ): Promise<string> => {
    const manifest = workflowManifestSchema.parse({
      name,
      triggers: [{ kind: "manual" }],
      ...meta,
    });
    const workflow = store.upsertWorkflow({ name: manifest.name, manifest, program });
    const { run: row } = store.createRun({
      workflowId: workflow.id,
      triggerKind: "manual",
      ...(input !== undefined ? { input } : {}),
    });
    supervisor.emitQueued(row.id);
    await supervisor.supervise(row.id);
    return row.id;
  };
  return { store, supervisor, run };
}

describe("agent() through the full run path", () => {
  it("explicit model: completes, streams agent events in their own turn, tallies usage", async () => {
    const f = fixture();
    provider.respondWith("the agent answer", { in: 120, out: 30 });
    const runId = await f.run(
      "with-agent",
      `import { agent, output } from "@boardwalk-labs/workflow";
                output(await agent("summarize this", { model: "test-model" }));`,
    );

    const row = f.store.getRun(runId);
    expect(row?.status).toBe("completed");
    expect(row?.output).toBe("the agent answer");
    expect(row?.tokensIn).toBe(120);
    expect(row?.tokensOut).toBe(30);
    expect(row?.usdMicros).toBeGreaterThan(0);

    const events = f.store.listEvents(runId).map((e) => e.event);
    const agentKinds = events.filter((e) => e.turnId !== runId).map((e) => e.kind);
    expect(agentKinds).toEqual([
      "turn_started",
      "text_start",
      "text_delta",
      "text_end",
      "turn_ended",
    ]);
    // Agent frames share one turnId, distinct from the run's.
    const turnIds = new Set(events.filter((e) => e.turnId !== runId).map((e) => e.turnId));
    expect(turnIds.size).toBe(1);
    // turn_started / turn_ended carry the leaf's identity; an unnamed call has agentId only.
    const turnFrames = events.filter((e) => e.kind === "turn_started" || e.kind === "turn_ended");
    const agentIds = new Set(turnFrames.map((e) => ("agentId" in e ? e.agentId : undefined)));
    expect(agentIds).toEqual(new Set(["agent-1"]));
    expect(turnFrames.every((e) => !("agentName" in e))).toBe(true);
  }, 30_000);

  it("stamps the author's agent name onto the turn frames", async () => {
    const f = fixture();
    provider.respondWith("named answer", { in: 1, out: 1 });
    const runId = await f.run(
      "named-agent",
      `import { agent, output } from "@boardwalk-labs/workflow";
       output(await agent("review", { model: "test-model", name: "reviewer" }));`,
    );

    expect(f.store.getRun(runId)?.status).toBe("completed");
    const turnFrames = f.store
      .listEvents(runId)
      .map((e) => e.event)
      .filter((e) => e.kind === "turn_started" || e.kind === "turn_ended");
    expect(turnFrames.length).toBeGreaterThanOrEqual(2);
    for (const e of turnFrames) {
      expect(e).toMatchObject({ agentId: "agent-1", agentName: "reviewer" });
    }
  }, 30_000);

  it("omitted model falls back to the engine's default_model", async () => {
    const f = fixture();
    provider.respondWith("default-model-reply", { in: 1, out: 1 });
    const runId = await f.run(
      "agent-default-model",
      `import { agent, output } from "@boardwalk-labs/workflow";
       output(await agent("hi"));`,
    );
    expect(f.store.getRun(runId)?.status).toBe("completed");
    expect(provider.requests.at(-1)).toContain("default-test-model");
  }, 30_000);

  it("REDACTION CANARY: a secrets.get value never reaches the provider", async () => {
    const canary = "canary-secret-value-7f3a9";
    const f = fixture({ API_TOKEN: canary });
    provider.respondWith("ok", { in: 1, out: 1 });
    const runId = await f.run(
      "leaky",
      `import { agent, output, secrets } from "@boardwalk-labs/workflow";
                const token = await secrets.get("API_TOKEN");
         output(await agent("please use token " + token + " to fetch the data"));`,
      { permissions: { secrets: [{ name: "API_TOKEN" }] } },
    );

    expect(f.store.getRun(runId)?.status).toBe("completed");
    const sent = provider.requests.at(-1) ?? "";
    expect(sent).not.toContain(canary);
    expect(sent).toContain("[redacted:API_TOKEN]");
    // And the event stream never carries the value either.
    const allEvents = JSON.stringify(f.store.listEvents(runId));
    expect(allEvents).not.toContain(canary);
  }, 30_000);

  it("kills the run when reported usage breaches budget.max_usd", async () => {
    const f = fixture();
    // 10M input tokens at the default ~$3/Mtok ≫ $0.01.
    provider.respondWith("expensive", { in: 10_000_000, out: 0 });
    const runId = await f.run(
      "overspender",
      `import { agent, sleep } from "@boardwalk-labs/workflow";
                await agent("burn tokens", { model: "test-model" });
         await sleep(30_000); // the budget kill lands here, not at process exit`,
      { budget: { max_usd: 0.01 } },
    );

    const row = f.store.getRun(runId);
    expect(row?.status).toBe("failed");
    expect(row?.error?.code).toBe("BUDGET_EXCEEDED");
    expect(row?.error?.message).toContain("max_usd");
  }, 30_000);

  it("kills the run when total tokens breach budget.max_tokens", async () => {
    const f = fixture();
    provider.respondWith("chatty", { in: 600, out: 600 });
    const runId = await f.run(
      "token-hog",
      `import { agent, sleep } from "@boardwalk-labs/workflow";
                await agent("talk a lot", { model: "test-model" });
         await sleep(30_000);`,
      { budget: { max_tokens: 1000 } },
    );

    const row = f.store.getRun(runId);
    expect(row?.status).toBe("failed");
    expect(row?.error?.code).toBe("BUDGET_EXCEEDED");
    expect(row?.error?.message).toContain("max_tokens");
  }, 30_000);

  it("an MCP server that cannot be reached fails the run loudly (capability-presence rule)", async () => {
    const f = fixture();
    const runId = await f.run(
      "wants-mcp",
      `import { agent } from "@boardwalk-labs/workflow";
       await agent("search", {
         model: "test-model",
         mcp: [{ name: "gh", transport: "http", url: "http://127.0.0.1:9/mcp" }],
       });`,
    );
    const row = f.store.getRun(runId);
    expect(row?.status).toBe("failed");
    // The leaf failed before any model call — the named server must resolve, never degrade.
    expect(row?.error?.message).toMatch(/gh|fetch failed/);
  }, 30_000);

  it("a malformed MCP ref fails the run with VALIDATION before anything connects", async () => {
    const f = fixture();
    const runId = await f.run(
      "bad-mcp-ref",
      `import { agent } from "@boardwalk-labs/workflow";
       await agent("search", {
         model: "test-model",
         mcp: [{ name: "gh", transport: "carrier-pigeon", coop: "roof" }],
       });`,
    );
    const row = f.store.getRun(runId);
    expect(row?.status).toBe("failed");
    expect(row?.error?.code).toBe("VALIDATION");
    expect(row?.error?.message).toContain("MCP");
  }, 30_000);

  it("runs a program-defined tool loop through the real child process", async () => {
    const f = fixture();
    provider.queueResponses({
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            content: null,
            tool_calls: [{ id: "c1", function: { name: "lookup", arguments: '{"key":"answer"}' } }],
          },
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 5 },
    });
    provider.respondWith("the looked-up answer is 42", { in: 6, out: 4 });
    const runId = await f.run(
      "tool-user",
      `import { agent, output } from "@boardwalk-labs/workflow";
       const table = { answer: "42" };
       output(
         await agent("look up the answer", {
           model: "test-model",
           tools: [
             {
               name: "lookup",
               description: "Look up a value by key",
               inputSchema: { type: "object", properties: { key: { type: "string" } } },
               execute: async (input) => table[input.key] ?? "missing",
             },
           ],
         }),
       );`,
    );

    const row = f.store.getRun(runId);
    expect(row?.status).toBe("completed");
    expect(row?.output).toBe("the looked-up answer is 42");
    // Usage accumulated across BOTH model calls of the loop.
    expect(row?.tokensIn).toBe(11);
    const kinds = f.store.listEvents(runId).map((e) => e.event.kind);
    expect(kinds).toContain("tool_call_start");
    expect(kinds).toContain("tool_call_result");
  }, 30_000);

  it("memory auto-persists across runs with NO declaration anywhere", async () => {
    const f = fixture();
    const program = `import { agent, output } from "@boardwalk-labs/workflow";
       output(await agent("take notes", { model: "test-model", memory: "mem/notes" }));`;

    // Run 1: the model writes a memory file through the scoped tool.
    provider.queueResponses({
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            content: null,
            tool_calls: [
              {
                id: "m1",
                function: {
                  name: "memory_write",
                  arguments: '{"path":"learned.md","content":"the sky is blue"}',
                },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    provider.respondWith("noted", { in: 1, out: 1 });
    const first = await f.run("memory-keeper", program);
    expect(f.store.getRun(first)?.status).toBe("completed");

    // Run 2: a FRESH run sees the persisted memory in its turn-start index.
    provider.respondWith("I remember", { in: 1, out: 1 });
    const second = await f.run("memory-keeper", program);
    expect(f.store.getRun(second)?.status).toBe("completed");
    const secondRequest = provider.requests.at(-1) ?? "";
    expect(secondRequest).toContain("learned.md");
  }, 30_000);
});

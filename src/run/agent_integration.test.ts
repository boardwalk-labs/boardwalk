// End-to-end agent() integration: real child process, real IPC, and a real (local, fake)
// OpenAI-compatible provider — the full path a workflow's agent() call takes. This is where
// the redaction invariant and the usage-budget kill are proven against actual processes,
// not unit fakes.

import { execSync } from "node:child_process";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { workflowManifestSchema, type WorkflowManifest } from "@boardwalk/workflow";
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
  /** Script the next responses: text + token usage. The last entry repeats. */
  respondWith: (text: string, usage: { in: number; out: number }) => void;
  close: () => Promise<void>;
}

function startFakeProvider(): Promise<FakeProvider> {
  const requests: string[] = [];
  let reply = { text: "fake-reply", usage: { in: 1, out: 1 } };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      requests.push(body);
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          choices: [{ message: { content: reply.text } }],
          usage: { prompt_tokens: reply.usage.in, completion_tokens: reply.usage.out },
        }),
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
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

// ----------------------------------------------------------------------------

let provider: FakeProvider;

beforeAll(async () => {
  execSync("pnpm build", { cwd: repoRoot, stdio: "pipe" });
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
    env: new Map(Object.entries(env)),
    envLabel: ".env (test fixture)",
    cancelGraceMs: 250,
    inference: {
      default_model: "local/default-test-model",
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
      `import { agent, output } from "@boardwalk/workflow";
       export default async function run() {
         output(await agent("summarize this", { model: "local/test-model" }));
       }`,
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
  }, 30_000);

  it("omitted model falls back to the engine's default_model", async () => {
    const f = fixture();
    provider.respondWith("default-model-reply", { in: 1, out: 1 });
    const runId = await f.run(
      "agent-default-model",
      `import { agent, output } from "@boardwalk/workflow";
       export default async function run() { output(await agent("hi")); }`,
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
      `import { agent, output, secrets } from "@boardwalk/workflow";
       export default async function run() {
         const token = await secrets.get("API_TOKEN");
         output(await agent("please use token " + token + " to fetch the data"));
       }`,
      { secrets: [{ name: "API_TOKEN" }] },
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
      `import { agent, sleep } from "@boardwalk/workflow";
       export default async function run() {
         await agent("burn tokens", { model: "local/test-model" });
         await sleep(30_000); // the budget kill lands here, not at process exit
       }`,
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
      `import { agent, sleep } from "@boardwalk/workflow";
       export default async function run() {
         await agent("talk a lot", { model: "local/test-model" });
         await sleep(30_000);
       }`,
      { budget: { max_tokens: 1000 } },
    );

    const row = f.store.getRun(runId);
    expect(row?.status).toBe("failed");
    expect(row?.error?.code).toBe("BUDGET_EXCEEDED");
    expect(row?.error?.message).toContain("max_tokens");
  }, 30_000);

  it("capability selections fail the run loudly (capability-presence rule)", async () => {
    const f = fixture();
    const runId = await f.run(
      "wants-tools",
      `import { agent } from "@boardwalk/workflow";
       export default async function run() {
         await agent("search", { model: "local/test-model", tools: ["web_search"] });
       }`,
    );
    const row = f.store.getRun(runId);
    expect(row?.status).toBe("failed");
    expect(row?.error?.code).toBe("UNSUPPORTED");
    expect(row?.error?.message).toContain("tools");
  }, 30_000);
});

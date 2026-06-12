// Real-HTTP tests for the engine server: a real Engine (spawning real child processes from
// the prebuilt dist), a real socket on an ephemeral loopback port, and fetch as the client.
// SSE frames are decoded by hand off the response body — no EventSource dependency.

import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { runEventSchema } from "@boardwalk-labs/workflow";
import type { RunEvent } from "@boardwalk-labs/workflow";
import { Engine } from "../engine.js";
import { createEngineServer, isLoopbackHost } from "./server.js";

// dist/ is built once by vitest.global_setup.ts — the engine spawns the compiled child entry.
const repoRoot = resolve(fileURLToPath(import.meta.url), "../../..");
const childEntryPath = join(repoRoot, "dist", "run", "child.js");

// ----------------------------------------------------------------------------
// Fixtures + lifecycle
// ----------------------------------------------------------------------------

const ECHO_PROGRAM = `
import { input, output } from "@boardwalk-labs/workflow";
export const meta = {
  name: "echo",
  description: "echoes its input",
  triggers: [{ kind: "manual" }],
};
console.log("echo-log-line");
output({ echoed: input ?? null });
`;

const SLOW_PROGRAM = `
import { output, sleep, Phase } from "@boardwalk-labs/workflow";
export const meta = { name: "slow", triggers: [{ kind: "manual" }] };
Phase("working");
await sleep(400);
output("slow-done");
`;

const NAP_PROGRAM = `
import { output, sleep } from "@boardwalk-labs/workflow";
export const meta = { name: "nap", triggers: [{ kind: "manual" }] };
await sleep(5000);
output("never-finished");
`;

const TOKEN_HOOK_PROGRAM = `
import { input, output } from "@boardwalk-labs/workflow";
export const meta = {
  name: "token-hook",
  triggers: [{ kind: "webhook", auth: "token" }, { kind: "manual" }],
};
output(input ?? null);
`;

const SIGNED_HOOK_PROGRAM = `
import { input, output } from "@boardwalk-labs/workflow";
export const meta = { name: "signed-hook", triggers: [{ kind: "webhook", auth: "signature" }] };
output(input ?? null);
`;

const cleanups: (() => Promise<void> | void)[] = [];
const envVarsSet: string[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
  for (const key of envVarsSet.splice(0)) delete process.env[key];
});

/** Set a process env var for this test only; afterEach restores. */
function setEnv(key: string, value: string): void {
  envVarsSet.push(key);
  process.env[key] = value;
}

interface TestServer {
  engine: Engine;
  base: string;
  logs: string[];
}

async function makeServer(): Promise<TestServer> {
  const dataDir = mkdtempSync(join(tmpdir(), "bw-server-test-"));
  const engine = new Engine({
    dataDir,
    env: {},
    envLabel: ".env (test)",
    childEntryPath,
    cancelGraceMs: 250,
  });
  const logs: string[] = [];
  const server = createEngineServer(engine, { log: (line) => logs.push(line) });
  const { port } = await server.listen(0);
  cleanups.push(async () => {
    await server.close();
    engine.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return { engine, base: `http://127.0.0.1:${port}`, logs };
}

// ----------------------------------------------------------------------------
// Response schemas — every byte off the wire is narrowed by Zod, never cast
// ----------------------------------------------------------------------------

const runSchema = z.looseObject({
  id: z.string(),
  workflowId: z.string(),
  status: z.string(),
  triggerKind: z.string(),
  input: z.json(),
  output: z.json(),
  createdAt: z.number(),
});
const runResponseSchema = z.object({ run: runSchema });
const runsResponseSchema = z.object({ runs: z.array(runSchema) });
const workflowsResponseSchema = z.object({
  workflows: z.array(
    z.looseObject({
      name: z.string(),
      description: z.string().nullable(),
      triggers: z.array(z.looseObject({ kind: z.string() })),
      createdAt: z.number(),
      updatedAt: z.number(),
    }),
  ),
});
const eventsResponseSchema = z.object({
  events: z.array(z.object({ runId: z.string(), cursor: z.number(), event: runEventSchema })),
});
const errorResponseSchema = z.object({
  error: z.object({ code: z.string(), message: z.string(), hint: z.string().optional() }),
});
const webhookAcceptedSchema = z.object({
  run: z.object({ id: z.string(), status: z.string() }),
});
const emptyObjectSchema = z.strictObject({});

async function fetchJson<T>(
  url: string,
  schema: z.ZodType<T>,
  init?: RequestInit,
): Promise<{ status: number; body: T }> {
  const res = init === undefined ? await fetch(url) : await fetch(url, init);
  const raw: unknown = await res.json();
  return { status: res.status, body: schema.parse(raw) };
}

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

async function pollRunUntil(
  base: string,
  runId: string,
  done: (status: string) => boolean,
): Promise<z.infer<typeof runSchema>> {
  for (let attempt = 0; attempt < 600; attempt++) {
    const { status, body } = await fetchJson(`${base}/api/runs/${runId}`, runResponseSchema);
    expect(status).toBe(200);
    if (done(body.run.status)) return body.run;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`run ${runId} never reached the awaited status`);
}

// ----------------------------------------------------------------------------
// SSE client — parse frames off the raw response body
// ----------------------------------------------------------------------------

interface SseFrame {
  id: number;
  event: RunEvent;
}

function parseSseFrame(raw: string): SseFrame | null {
  let id: number | null = null;
  let data = "";
  for (const line of raw.split("\n")) {
    if (line.startsWith("id: ")) id = Number(line.slice(4));
    if (line.startsWith("data: ")) data = line.slice(6);
  }
  if (id === null || data === "") return null; // comment-only frames (pings)
  const parsed: unknown = JSON.parse(data);
  return { id, event: runEventSchema.parse(parsed) };
}

/** Read SSE frames until `doneWhen` is satisfied, then abort the request. */
async function readSse(
  url: string,
  opts: { headers?: Record<string, string>; doneWhen: (frames: readonly SseFrame[]) => boolean },
): Promise<SseFrame[]> {
  const controller = new AbortController();
  const res = await fetch(url, {
    signal: controller.signal,
    ...(opts.headers !== undefined ? { headers: opts.headers } : {}),
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("text/event-stream");
  const body = res.body;
  if (body === null) throw new Error("SSE response had no body");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const frames: SseFrame[] = [];
  let buffer = "";
  try {
    while (!opts.doneWhen(frames)) {
      // Why the explicit shape: Node types Response.body as ReadableStream<any>; declaring
      // the chunk as unknown forces the instanceof narrowing below instead of trusting any.
      const result: { done: boolean; value: unknown } = await reader.read();
      if (result.done) break;
      if (!(result.value instanceof Uint8Array)) throw new Error("expected a binary SSE chunk");
      buffer += decoder.decode(result.value, { stream: true });
      let sep = buffer.indexOf("\n\n");
      while (sep !== -1) {
        const frame = parseSseFrame(buffer.slice(0, sep));
        buffer = buffer.slice(sep + 2);
        if (frame !== null) frames.push(frame);
        sep = buffer.indexOf("\n\n");
      }
    }
  } finally {
    controller.abort();
    await reader.cancel().catch(() => undefined);
  }
  return frames;
}

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

describe("engine HTTP server", () => {
  it("GET /api/workflows lists deployed workflows with manifest-derived fields", async () => {
    const { engine, base } = await makeServer();
    engine.deployWorkflow({ program: ECHO_PROGRAM });
    engine.deployWorkflow({ program: TOKEN_HOOK_PROGRAM });
    const { status, body } = await fetchJson(`${base}/api/workflows`, workflowsResponseSchema);
    expect(status).toBe(200);
    expect(body.workflows.map((w) => w.name)).toEqual(["echo", "token-hook"]);
    const echo = body.workflows[0];
    expect(echo?.description).toBe("echoes its input");
    expect(echo?.triggers).toEqual([{ kind: "manual" }]);
    expect(body.workflows[1]?.description).toBeNull();
  });

  it("POST /api/workflows/:name/runs starts a manual run that completes", async () => {
    const { engine, base } = await makeServer();
    engine.deployWorkflow({ program: ECHO_PROGRAM });
    const { status, body } = await fetchJson(`${base}/api/workflows/echo/runs`, runResponseSchema, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: { n: 7 } }),
    });
    expect(status).toBe(201);
    expect(body.run.triggerKind).toBe("manual");
    expect(body.run.input).toEqual({ n: 7 });
    const done = await pollRunUntil(base, body.run.id, (s) => TERMINAL_STATUSES.has(s));
    expect(done.status).toBe("completed");
    expect(done.output).toEqual({ echoed: { n: 7 } });
  }, 20_000);

  it("POST run on an unknown workflow is 404; unknown run reads are 404", async () => {
    const { base } = await makeServer();
    const start = await fetchJson(`${base}/api/workflows/ghost/runs`, errorResponseSchema, {
      method: "POST",
    });
    expect(start.status).toBe(404);
    expect(start.body.error.code).toBe("NOT_FOUND");
    for (const path of ["/api/runs/nope", "/api/runs/nope/events"]) {
      const { status, body } = await fetchJson(`${base}${path}`, errorResponseSchema);
      expect(status).toBe(404);
      expect(body.error.code).toBe("NOT_FOUND");
    }
  });

  it("GET /api/runs filters by workflow, status, limit, offset", async () => {
    const { engine, base } = await makeServer();
    const row = await engine.runOnce({ program: ECHO_PROGRAM });
    expect(row.status).toBe("completed");

    const all = await fetchJson(`${base}/api/runs`, runsResponseSchema);
    expect(all.status).toBe(200);
    expect(all.body.runs.map((r) => r.id)).toEqual([row.id]);

    const byWorkflow = await fetchJson(`${base}/api/runs?workflow=echo`, runsResponseSchema);
    expect(byWorkflow.body.runs).toHaveLength(1);
    const ghost = await fetchJson(`${base}/api/runs?workflow=ghost`, errorResponseSchema);
    expect(ghost.status).toBe(404);

    const completed = await fetchJson(`${base}/api/runs?status=completed`, runsResponseSchema);
    expect(completed.body.runs).toHaveLength(1);
    const failed = await fetchJson(`${base}/api/runs?status=failed`, runsResponseSchema);
    expect(failed.body.runs).toHaveLength(0);
    const bogus = await fetchJson(`${base}/api/runs?status=bogus`, errorResponseSchema);
    expect(bogus.status).toBe(400);
    expect(bogus.body.error.code).toBe("VALIDATION");

    const limited = await fetchJson(`${base}/api/runs?limit=0`, runsResponseSchema);
    expect(limited.body.runs).toHaveLength(0);
    const offset = await fetchJson(`${base}/api/runs?offset=1`, runsResponseSchema);
    expect(offset.body.runs).toHaveLength(0);
    const badLimit = await fetchJson(`${base}/api/runs?limit=abc`, errorResponseSchema);
    expect(badLimit.status).toBe(400);
  }, 20_000);

  it("events endpoint: default channels, explicit channels, verbose, after-cursor", async () => {
    const { engine, base } = await makeServer();
    const row = await engine.runOnce({ program: ECHO_PROGRAM });

    const defaults = await fetchJson(`${base}/api/runs/${row.id}/events`, eventsResponseSchema);
    expect(defaults.status).toBe(200);
    const defaultKinds = defaults.body.events.map((e) => e.event.kind);
    expect(defaultKinds).toContain("run_status");
    expect(defaultKinds).toContain("output");
    expect(defaultKinds).not.toContain("program_output");

    const verbose = await fetchJson(
      `${base}/api/runs/${row.id}/events?verbose=true`,
      eventsResponseSchema,
    );
    expect(verbose.body.events.map((e) => e.event.kind)).toContain("program_output");
    // Cursors are globally consistent across channel filters (MASTER_SPEC §2.5).
    expect(verbose.body.events.map((e) => e.cursor)).toEqual(
      engine.store.listEvents(row.id).map((e) => e.cursor),
    );

    const logsOnly = await fetchJson(
      `${base}/api/runs/${row.id}/events?channels=log`,
      eventsResponseSchema,
    );
    expect(logsOnly.body.events.length).toBeGreaterThan(0);
    for (const e of logsOnly.body.events) expect(e.event.kind).toBe("program_output");

    const first = verbose.body.events[0];
    expect(first).toBeDefined();
    if (first === undefined) throw new Error("unreachable");
    const after = await fetchJson(
      `${base}/api/runs/${row.id}/events?verbose=true&after=${first.cursor}`,
      eventsResponseSchema,
    );
    expect(after.body.events.map((e) => e.cursor)).toEqual(
      verbose.body.events.slice(1).map((e) => e.cursor),
    );

    const badChannel = await fetchJson(
      `${base}/api/runs/${row.id}/events?channels=bogus`,
      errorResponseSchema,
    );
    expect(badChannel.status).toBe(400);
    expect(badChannel.body.error.hint).toContain("lifecycle");
  }, 20_000);

  it("SSE: replay-then-live tail with no duplicates and no gaps", async () => {
    const { engine, base } = await makeServer();
    engine.deployWorkflow({ program: SLOW_PROGRAM });
    const started = await fetchJson(`${base}/api/workflows/slow/runs`, runResponseSchema, {
      method: "POST",
    });
    expect(started.status).toBe(201);
    const runId = started.body.run.id;

    const frames = await readSse(`${base}/api/runs/${runId}/stream?verbose=true`, {
      doneWhen: (got) =>
        got.some((f) => f.event.kind === "run_status" && f.event.status === "completed"),
    });

    const cursors = frames.map((f) => f.id);
    for (let i = 1; i < cursors.length; i++) {
      const prev = cursors[i - 1];
      const here = cursors[i];
      if (prev === undefined || here === undefined) throw new Error("unreachable");
      expect(here).toBeGreaterThan(prev);
    }
    // The tail saw exactly what the store persisted: no duplicates, no gaps.
    const persisted = engine.store.listEvents(runId);
    expect(frames.map((f) => f.id)).toEqual(persisted.map((e) => e.cursor));
    expect(frames.map((f) => f.event.kind)).toEqual(persisted.map((e) => e.event.kind));
    expect(frames.map((f) => f.event.kind)).toContain("phase");
  }, 20_000);

  it("SSE: Last-Event-ID wins over ?after= and the cursor resume is exact", async () => {
    const { engine, base } = await makeServer();
    const row = await engine.runOnce({ program: ECHO_PROGRAM });
    const all = engine.store.listEvents(row.id);
    expect(all.length).toBeGreaterThan(3);
    const resumeAt = all[2];
    if (resumeAt === undefined) throw new Error("unreachable");
    const expected = all.slice(3);

    const frames = await readSse(`${base}/api/runs/${row.id}/stream?verbose=true&after=0`, {
      headers: { "last-event-id": String(resumeAt.cursor) },
      doneWhen: (got) => got.length >= expected.length,
    });
    expect(frames.map((f) => f.id)).toEqual(expected.map((e) => e.cursor));
  }, 20_000);

  it("SSE: channel filtering matches /events and keeps global cursors", async () => {
    const { engine, base } = await makeServer();
    const row = await engine.runOnce({ program: ECHO_PROGRAM });
    const frames = await readSse(`${base}/api/runs/${row.id}/stream?channels=output`, {
      doneWhen: (got) => got.length >= 1,
    });
    expect(frames).toHaveLength(1);
    const frame = frames[0];
    if (frame === undefined) throw new Error("unreachable");
    expect(frame.event.kind).toBe("output");
    const outputRow = engine.store.listEvents(row.id).find((e) => e.event.kind === "output");
    expect(frame.id).toBe(outputRow?.cursor);
  }, 20_000);

  it("SSE: unknown run is a JSON 404, not a stream", async () => {
    const { base } = await makeServer();
    const { status, body } = await fetchJson(`${base}/api/runs/nope/stream`, errorResponseSchema);
    expect(status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("POST /api/runs/:id/cancel → 202 and the run lands cancelled", async () => {
    const { engine, base } = await makeServer();
    engine.deployWorkflow({ program: NAP_PROGRAM });
    const started = await fetchJson(`${base}/api/workflows/nap/runs`, runResponseSchema, {
      method: "POST",
    });
    await pollRunUntil(base, started.body.run.id, (s) => s === "running");

    const cancel = await fetchJson(
      `${base}/api/runs/${started.body.run.id}/cancel`,
      emptyObjectSchema,
      { method: "POST" },
    );
    expect(cancel.status).toBe(202);
    const done = await pollRunUntil(base, started.body.run.id, (s) => TERMINAL_STATUSES.has(s));
    expect(done.status).toBe("cancelled");

    const missing = await fetchJson(`${base}/api/runs/nope/cancel`, errorResponseSchema, {
      method: "POST",
    });
    expect(missing.status).toBe(404);
  }, 20_000);

  it("webhook token auth: 503 unconfigured, 401 bad token, 201 success, 404 non-webhook", async () => {
    const { engine, base } = await makeServer();
    engine.deployWorkflow({ program: TOKEN_HOOK_PROGRAM });

    // Fail closed before any credential exists.
    const unconfigured = await fetchJson(`${base}/hooks/token-hook/0`, errorResponseSchema, {
      method: "POST",
    });
    expect(unconfigured.status).toBe(503);
    expect(unconfigured.body.error.hint).toContain("BOARDWALK_WEBHOOK_TOKEN__TOKEN_HOOK");

    // 404s do not leak whether the workflow, the index, or the trigger kind was wrong.
    for (const path of [
      "/hooks/token-hook/1", // exists, but kind manual
      "/hooks/token-hook/9", // no such index
      "/hooks/token-hook/x", // not an index
      "/hooks/ghost/0", // no such workflow
    ]) {
      const { status, body } = await fetchJson(`${base}${path}`, errorResponseSchema, {
        method: "POST",
      });
      expect(status).toBe(404);
      expect(body.error.code).toBe("NOT_FOUND");
    }

    setEnv("BOARDWALK_WEBHOOK_TOKEN__TOKEN_HOOK", "s3cret-token");
    const noHeader = await fetchJson(`${base}/hooks/token-hook/0`, errorResponseSchema, {
      method: "POST",
    });
    expect(noHeader.status).toBe(401);
    const wrong = await fetchJson(`${base}/hooks/token-hook/0`, errorResponseSchema, {
      method: "POST",
      headers: { authorization: "Bearer wrong" },
    });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe("UNAUTHORIZED");

    const accepted = await fetchJson(`${base}/hooks/token-hook/0`, webhookAcceptedSchema, {
      method: "POST",
      headers: { authorization: "Bearer s3cret-token", "content-type": "application/json" },
      body: JSON.stringify({ hello: "hook" }),
    });
    expect(accepted.status).toBe(201);
    const done = await pollRunUntil(base, accepted.body.run.id, (s) => TERMINAL_STATUSES.has(s));
    expect(done.status).toBe("completed");
    expect(done.triggerKind).toBe("webhook");
    expect(done.output).toEqual({ hello: "hook" });

    // An empty body is a valid trigger with null input.
    const empty = await fetchJson(`${base}/hooks/token-hook/0`, webhookAcceptedSchema, {
      method: "POST",
      headers: { authorization: "Bearer s3cret-token" },
    });
    expect(empty.status).toBe(201);
    const emptyDone = await pollRunUntil(base, empty.body.run.id, (s) => TERMINAL_STATUSES.has(s));
    expect(emptyDone.input).toBeNull();
  }, 30_000);

  it("webhook signature auth: HMAC over the raw body, hyphenated names map to env vars", async () => {
    const { engine, base } = await makeServer();
    engine.deployWorkflow({ program: SIGNED_HOOK_PROGRAM });
    const payload = JSON.stringify({ n: 1 });

    const unconfigured = await fetchJson(`${base}/hooks/signed-hook/0`, errorResponseSchema, {
      method: "POST",
      body: payload,
    });
    expect(unconfigured.status).toBe(503);
    expect(unconfigured.body.error.hint).toContain("BOARDWALK_WEBHOOK_SECRET__SIGNED_HOOK");

    setEnv("BOARDWALK_WEBHOOK_SECRET__SIGNED_HOOK", "hush");
    const sign = (body: string): string =>
      `sha256=${createHmac("sha256", "hush").update(body).digest("hex")}`;

    const missing = await fetchJson(`${base}/hooks/signed-hook/0`, errorResponseSchema, {
      method: "POST",
      body: payload,
    });
    expect(missing.status).toBe(401);
    const malformed = await fetchJson(`${base}/hooks/signed-hook/0`, errorResponseSchema, {
      method: "POST",
      headers: { "x-boardwalk-signature": "sha256=zz" },
      body: payload,
    });
    expect(malformed.status).toBe(401);
    // A valid signature for DIFFERENT bytes must not authenticate this body.
    const stale = await fetchJson(`${base}/hooks/signed-hook/0`, errorResponseSchema, {
      method: "POST",
      headers: { "x-boardwalk-signature": sign("tampered") },
      body: payload,
    });
    expect(stale.status).toBe(401);

    const accepted = await fetchJson(`${base}/hooks/signed-hook/0`, webhookAcceptedSchema, {
      method: "POST",
      headers: { "x-boardwalk-signature": sign(payload) },
      body: payload,
    });
    expect(accepted.status).toBe(201);
    const done = await pollRunUntil(base, accepted.body.run.id, (s) => TERMINAL_STATUSES.has(s));
    expect(done.status).toBe("completed");
    expect(done.output).toEqual({ n: 1 });
  }, 20_000);

  it("405 on known paths carries an Allow header", async () => {
    const { base } = await makeServer();
    const cases: [string, string, string][] = [
      ["/api/workflows", "DELETE", "GET"],
      ["/api/workflows/echo/runs", "GET", "POST"],
      ["/hooks/a/0", "GET", "POST"],
    ];
    for (const [path, method, allow] of cases) {
      const res = await fetch(`${base}${path}`, { method });
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe(allow);
      const raw: unknown = await res.json();
      expect(errorResponseSchema.parse(raw).error.code).toBe("METHOD_NOT_ALLOWED");
    }
  });

  it("400 on malformed or mis-shaped JSON bodies; 413 on oversized bodies", async () => {
    const { base } = await makeServer();
    const malformed = await fetchJson(`${base}/api/workflows/echo/runs`, errorResponseSchema, {
      method: "POST",
      body: "{nope",
    });
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe("VALIDATION");

    const misShaped = await fetchJson(`${base}/api/workflows/echo/runs`, errorResponseSchema, {
      method: "POST",
      body: JSON.stringify({ inputs: {} }),
    });
    expect(misShaped.status).toBe(400);

    const oversized = await fetchJson(`${base}/api/workflows/echo/runs`, errorResponseSchema, {
      method: "POST",
      body: `{"input":"${"x".repeat(1024 * 1024)}"}`,
    });
    expect(oversized.status).toBe(413);
    expect(oversized.body.error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("unknown routes are JSON 404s; GET / serves the run-log page", async () => {
    const { base } = await makeServer();
    const missing = await fetchJson(`${base}/api/nope`, errorResponseSchema);
    expect(missing.status).toBe(404);

    const page = await fetch(`${base}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    const html = await page.text();
    expect(html).toContain("/api/workflows");
    expect(html).toContain("EventSource");
  });

  it("binds loopback silently and knows which hosts deserve the bind warning", async () => {
    const { logs } = await makeServer();
    expect(logs.filter((line) => line.includes("WARNING"))).toHaveLength(0);
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("192.168.1.10")).toBe(false);
  });
});

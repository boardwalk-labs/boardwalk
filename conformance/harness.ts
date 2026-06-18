// SPDX-License-Identifier: Apache-2.0

// The conformance harness — THE ENGINE-SPECIFIC HALF OF THE SUITE.
//
// The conformance suite (SPEC §3) is the arbiter of the parity promise: the
// *.conformance.test.ts files assert observable run behavior through the engine's PUBLIC
// surface only (deploy, start, wait, cancel, events, store reads). Everything that knows HOW
// to stand an engine up lives here: a different engine implementation swaps this factory (and
// points the inference table at its own endpoint plumbing) and the cases run unchanged — that
// is the parity point.
//
// What this file provides:
//   - createEngine / makeDataDir: an Engine over a throwaway data dir, with cleanup tracking
//     (disposeEngines is each file's afterEach). Engines can share a data dir to model an
//     engine-process restart.
//   - startFakeProvider: a recording, scriptable OpenAI-compatible provider, so agent() cases
//     control every model response and can assert exactly what reached the model.
//   - manualClock: a frozen, advanceable clock for scheduler cases (cron catch-up) — the
//     suite drives engine.tick() instead of waiting wall-clock hours.
//   - small read helpers over the persisted event stream (kinds, statuses, cursors).

import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { Engine } from "../src/index.js";
import type { EngineOptions, EventRow, InferenceConfig, RunStatus } from "../src/index.js";

// A scriptable MCP server (streamable HTTP) for the MCP conformance cases. Re-exported from
// the engine's test doubles: knowing how to fake an MCP server is harness knowledge (another
// engine implementation swaps this file), not conformance-case knowledge.
export {
  startFakeMcpServer,
  type FakeMcpServer,
  type FakeMcpTool,
} from "../src/testing/fake_mcp.js";

// The engine type doesn't export its Clock interface; derive it from the public options so
// the harness never reaches into engine internals.
export type EngineClock = NonNullable<EngineOptions["clock"]>;

// dist/ is built once by vitest.global_setup.ts — the engine spawns the compiled child entry.
const repoRoot = resolve(fileURLToPath(import.meta.url), "../..");
const childEntryPath = join(repoRoot, "dist", "run", "child.js");

// ----------------------------------------------------------------------------
// Engine factory + cleanup tracking
// ----------------------------------------------------------------------------

const cleanups: (() => void)[] = [];

/** Tear down everything a test created, newest first (engines close before dirs vanish). */
export function disposeEngines(): void {
  for (const fn of cleanups.splice(0).reverse()) fn();
}

/** A data dir a test owns explicitly — for cases that reopen a SECOND engine over the same state. */
export function makeDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "bw-conformance-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export interface EngineHandle {
  engine: Engine;
  dataDir: string;
}

export interface CreateEngineOpts {
  /** Reuse existing engine state (engine-restart cases). Default: a fresh throwaway dir. */
  dataDir?: string;
  /** The engine's secret/env source (what secrets.get resolves against). */
  env?: Record<string, string>;
  /** Default model + provider table — point `local` at a fake provider for agent() cases. */
  inference?: InferenceConfig;
  clock?: EngineClock;
  /** Captures engine diagnostics (e.g. cron catch-up notices). */
  log?: (line: string) => void;
  maxRestarts?: number;
}

/**
 * Stand up an Engine the way an embedding consumer would — only public options. The short
 * cancel grace keeps cancellation cases fast without changing their observable shape.
 */
export function createEngine(opts: CreateEngineOpts = {}): EngineHandle {
  const ownsDir = opts.dataDir === undefined;
  const dataDir = opts.dataDir ?? mkdtempSync(join(tmpdir(), "bw-conformance-"));
  const engine = new Engine({
    dataDir,
    env: { ...MANAGED_KEY_ENV, ...(opts.env ?? {}) },
    envLabel: ".env (conformance harness)",
    childEntryPath,
    cancelGraceMs: 250,
    ...(opts.inference !== undefined ? { inference: opts.inference } : {}),
    ...(opts.clock !== undefined ? { clock: opts.clock } : {}),
    ...(opts.log !== undefined ? { log: opts.log } : {}),
    ...(opts.maxRestarts !== undefined ? { maxRestarts: opts.maxRestarts } : {}),
  });
  cleanups.push(() => {
    engine.close();
    if (ownsDir) rmSync(dataDir, { recursive: true, force: true });
  });
  return { engine, dataDir };
}

// ----------------------------------------------------------------------------
// The fake OpenAI-compatible inference provider
// ----------------------------------------------------------------------------

export interface FakeProvider {
  port: number;
  /** Every request body received, in order — the redaction canary asserts over these. */
  requests: string[];
  /** Script the steady-state reply: text + token usage. */
  respondWith: (text: string, usage: { in: number; out: number }) => void;
  /** Queue full response bodies served (in order) BEFORE the steady-state reply. */
  queueResponses: (...bodies: object[]) => void;
  close: () => Promise<void>;
}

/**
 * A minimal OpenAI-compatible endpoint the suite fully controls. Recording requests is what
 * makes the secret-redaction canary and the "context reached the model" assertions possible
 * without any real provider.
 */
/** Convert a non-streaming OpenAI response object (the shape the suite queues) into an SSE body:
 *  a content delta, an indexed tool_calls delta, a finish chunk, then a usage chunk + [DONE]. */
function toSseBody(resp: object): string {
  const r = resp as {
    choices?: {
      finish_reason?: string | null;
      message?: {
        content?: string | null;
        tool_calls?: { id: string; function: { name: string; arguments: string } }[];
      };
    }[];
    usage?: object;
  };
  const choice = r.choices?.[0];
  const chunks: object[] = [];
  const content = choice?.message?.content;
  if (typeof content === "string" && content.length > 0) {
    chunks.push({ choices: [{ delta: { content }, finish_reason: null }] });
  }
  const toolCalls = choice?.message?.tool_calls ?? [];
  if (toolCalls.length > 0) {
    chunks.push({
      choices: [
        {
          delta: {
            tool_calls: toolCalls.map((c, index) => ({ index, id: c.id, function: c.function })),
          },
          finish_reason: null,
        },
      ],
    });
  }
  chunks.push({ choices: [{ delta: {}, finish_reason: choice?.finish_reason ?? "stop" }] });
  if (r.usage !== undefined) chunks.push({ choices: [], usage: r.usage });
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
}

export function startFakeProvider(): Promise<FakeProvider> {
  const requests: string[] = [];
  const queue: object[] = [];
  let reply = { text: "fake-reply", usage: { in: 1, out: 1 } };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      requests.push(body);
      // chatOpenAi requests stream:true, so reply with SSE — the queued/default objects are the
      // non-streaming OpenAI shape, streamified on the fly (so the test call sites stay unchanged).
      res.setHeader("content-type", "text/event-stream");
      const queued = queue.shift();
      res.end(
        toSseBody(
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

/**
 * Engine inference config pointing the DEFAULT (boardwalk managed) lane at the fake provider —
 * the path a model named with no `provider` takes. Pair with {@link MANAGED_KEY_ENV} in the
 * engine env (createEngine adds it automatically).
 */
export function localInference(provider: FakeProvider): InferenceConfig {
  return {
    default_model: "default-test-model",
    boardwalk_base_url: `http://127.0.0.1:${String(provider.port)}/v1`,
  };
}

/** The managed-lane credential the conformance engines run with. */
export const MANAGED_KEY_ENV = { BOARDWALK_API_KEY: "conformance-managed-key" };

/** An OpenAI-shaped tool-call response body for {@link FakeProvider.queueResponses}. */
export function toolCallResponse(
  calls: readonly { id: string; name: string; argsJson: string }[],
  usage: { in: number; out: number } = { in: 1, out: 1 },
): object {
  return {
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          content: null,
          tool_calls: calls.map((c) => ({
            id: c.id,
            function: { name: c.name, arguments: c.argsJson },
          })),
        },
      },
    ],
    usage: { prompt_tokens: usage.in, completion_tokens: usage.out },
  };
}

// ----------------------------------------------------------------------------
// Manual clock (scheduler cases)
// ----------------------------------------------------------------------------

export interface ManualClock {
  clock: EngineClock;
  /** Jump now() forward — the suite never waits wall-clock time for a cron boundary. */
  advance(ms: number): void;
}

/**
 * A frozen, advanceable now() over real timers. Scheduler decisions (cron due-ness, catch-up)
 * read now(); sleep() backs only incidental waits (cancel grace, loop cadence) where real,
 * short wall time is fine — the suite drives scheduling via engine.tick(), never the loop.
 */
export function manualClock(startMs: number): ManualClock {
  let now = startMs;
  const clock: EngineClock = {
    now: (): number => now,
    sleep(ms: number, signal?: AbortSignal): Promise<void> {
      return new Promise((resolveSleep, rejectSleep) => {
        if (signal?.aborted === true) {
          rejectSleep(new Error("aborted"));
          return;
        }
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolveSleep();
        }, ms);
        const onAbort = (): void => {
          clearTimeout(timer);
          rejectSleep(new Error("aborted"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
  };
  return {
    clock,
    advance(ms: number): void {
      now += ms;
    },
  };
}

// ----------------------------------------------------------------------------
// Polling + event-stream read helpers
// ----------------------------------------------------------------------------

export function pause(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Poll until `cond` holds — the public way to observe intermediate run states. */
export async function waitFor(
  cond: () => boolean,
  what: string,
  timeoutMs = 15_000,
): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await pause(25);
  }
}

/** Poll engine.store until the run reaches `status`. */
export async function waitForStatus(
  engine: Engine,
  runId: string,
  status: RunStatus,
  timeoutMs = 15_000,
): Promise<void> {
  await waitFor(
    () => engine.store.getRun(runId)?.status === status,
    `run ${runId} to reach "${status}" (currently "${engine.store.getRun(runId)?.status ?? "?"}")`,
    timeoutMs,
  );
}

/** The persisted event kinds of a run, in cursor order. */
export function kindsOf(engine: Engine, runId: string): string[] {
  return engine.store.listEvents(runId).map((row) => row.event.kind);
}

/** The run's lifecycle transitions as the event stream tells them. */
export function statusesOf(engine: Engine, runId: string): RunStatus[] {
  return engine.store
    .listEvents(runId)
    .flatMap((row) => (row.event.kind === "run_status" ? [row.event.status] : []));
}

/** Assert the wire-format cursor contract: strictly increasing, no duplicates. */
export function expectMonotonicCursors(rows: readonly EventRow[]): void {
  const cursors = rows.map((row) => row.cursor);
  expect([...cursors].sort((a, b) => a - b)).toEqual(cursors);
  expect(new Set(cursors).size).toBe(cursors.length);
}

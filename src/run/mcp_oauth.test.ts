// SPDX-License-Identifier: Apache-2.0

// End-to-end MCP OAuth: a real Engine, a real spawned run process, a fake OAuth-protected MCP
// server, and a fake authorization server. Proves the whole architecture: the one-time
// interactive authorize (Engine.authorizeMcpServer + loopback redirect), runs using the stored
// token headlessly, SILENT refresh when the token expires, and the loud
// fail-with-a-pointer when a fresh data dir holds no grant.

import http from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { Engine } from "../engine.js";
import { startFakeAuthServer, type FakeAuthServer } from "../testing/fake_oauth.js";
import { startFakeMcpServer, type FakeMcpServer } from "../testing/fake_mcp.js";

const repoRoot = resolve(fileURLToPath(import.meta.url), "../../..");
const childEntryPath = join(repoRoot, "dist", "run", "child.js");

// A minimal scriptable OpenAI-compatible model endpoint (text-only + one queued tool call).
interface FakeModel {
  port: number;
  queue: object[];
  close: () => Promise<void>;
}
function startFakeModel(): Promise<FakeModel> {
  const queue: object[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      const queued = queue.shift();
      res.end(
        JSON.stringify(
          queued ?? {
            choices: [{ finish_reason: "stop", message: { content: "model-reply" } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          },
        ),
      );
    });
  });
  return new Promise((resolvePort) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolvePort({ port, queue, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

let model: FakeModel;
let authServer: FakeAuthServer;
let mcp: FakeMcpServer;

beforeAll(async () => {
  model = await startFakeModel();
  authServer = await startFakeAuthServer({ expiresInSeconds: 3600 });
  mcp = await startFakeMcpServer({
    tools: [{ name: "greet", handler: (args) => ({ text: `hello ${String(args["who"])}` }) }],
    auth: {
      validTokens: authServer.validTokens, // live set: tokens the AS issues are valid here
      resourceMetadataUrl: authServer.resourceMetadataUrl,
    },
  });
}, 120_000);

afterAll(async () => {
  await mcp.close();
  await authServer.close();
  await model.close();
});

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

function makeEngine(dataDir?: string): { engine: Engine; dataDir: string } {
  const dir = dataDir ?? mkdtempSync(join(tmpdir(), "bw-mcp-oauth-"));
  const engine = new Engine({
    dataDir: dir,
    env: {},
    envLabel: ".env (mcp oauth test)",
    childEntryPath,
    inference: {
      providers: { local: { base_url: `http://127.0.0.1:${String(model.port)}/v1` } },
    },
  });
  cleanups.push(() => {
    engine.close();
    if (dataDir === undefined) rmSync(dir, { recursive: true, force: true });
  });
  return { engine, dataDir: dir };
}

/** The "browser": follow the AS's 302 back to the engine's loopback listener. */
async function completeAuthorization(url: string): Promise<void> {
  const redirect = await fetch(url, { redirect: "manual" });
  expect(redirect.status).toBe(302);
  const loopback = await fetch(redirect.headers.get("location") ?? "");
  expect(loopback.status).toBe(200);
}

function deployProgram(engine: Engine): void {
  engine.deployWorkflow({
    program: `
      import { agent, output } from "@boardwalk-labs/workflow";
      export const meta = { slug: "mcp-user", triggers: [{ kind: "manual" }] };
      output(await agent("greet the world", {
        model: "test-model",
        provider: "local",
        mcp: [{ name: "locked", transport: "http", url: ${JSON.stringify(mcp.url)} }],
      }));
    `,
  });
}

function queueToolCallTurn(): void {
  model.queue.push({
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          content: null,
          tool_calls: [
            { id: "c1", function: { name: "locked__greet", arguments: '{"who":"boardwalk"}' } },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  });
}

describe("MCP OAuth end to end", () => {
  it("authorize once → run uses the stored token → silent refresh after expiry → fresh dataDir fails with the pointer", async () => {
    const { engine, dataDir } = makeEngine();

    // 1. The one-time interactive step: discovery off the 401, registration, PKCE, loopback.
    await engine.authorizeMcpServer(mcp.url, {
      onAuthorizationUrl: (url) => void completeAuthorization(url),
      timeoutMs: 15_000,
    });
    expect(authServer.registrations).toBeGreaterThanOrEqual(1);
    expect(authServer.codeExchanges).toBe(1);

    // 2. A real run connects with the stored token and round-trips the namespaced tool.
    deployProgram(engine);
    queueToolCallTurn();
    const first = await engine.waitForRun(engine.startRun("mcp-user").id);
    expect(first.status).toBe("completed");
    expect(first.output).toBe("model-reply");
    const call = mcp.requests.find((r) => r.rpcMethod === "tools/call");
    expect(call).toBeDefined();
    const bearer = /^Bearer (.+)$/.exec(call?.headers.authorization ?? "")?.[1] ?? "";
    expect(authServer.validTokens.has(bearer)).toBe(true);

    // 3. Expire the stored token on disk; the next run must refresh SILENTLY (no interaction).
    const tokensPath = join(dataDir, "mcp_tokens.json");
    const storedFileSchema = z.record(z.string(), z.record(z.string(), z.unknown()));
    const stored = storedFileSchema.parse(JSON.parse(readFileSync(tokensPath, "utf8")));
    const rewritten = Object.fromEntries(
      Object.entries(stored).map(([key, entry]) => [
        key,
        { ...entry, expiresAt: Date.now() - 1000 },
      ]),
    );
    writeFileSync(tokensPath, JSON.stringify(rewritten), "utf8");

    expect(authServer.refreshCalls).toBe(0);
    queueToolCallTurn();
    const second = await engine.waitForRun(engine.startRun("mcp-user").id);
    expect(second.status).toBe("completed");
    expect(authServer.refreshCalls).toBe(1);

    // 4. A fresh data dir (no grant): the run FAILS LOUDLY, pointing at authorizeMcpServer —
    // a headless run never prompts.
    const fresh = makeEngine();
    deployProgram(fresh.engine);
    const denied = await fresh.engine.waitForRun(fresh.engine.startRun("mcp-user").id);
    expect(denied.status).toBe("failed");
    // Names the server; the EngineError's hint (asserted at leaf level) points at
    // engine.authorizeMcpServer — run rows persist code+message only.
    expect(denied.error?.message).toContain('"locked"');
    expect(denied.error?.message).toContain("requires OAuth authorization");
  }, 60_000);
});

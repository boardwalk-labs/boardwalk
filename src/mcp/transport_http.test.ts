// SPDX-License-Identifier: Apache-2.0

// Exercises the streamable-HTTP transport against real local servers: single-JSON replies,
// SSE replies, Mcp-Session-Id capture + replay + DELETE teardown, the MCP-Protocol-Version
// header, and the 401 → acquireToken → retry → invalidate dance the OAuth design hangs on.

import { afterEach, describe, expect, it } from "vitest";
import { EngineError } from "../errors.js";
import { startFakeMcpServer, type FakeMcpServer } from "../testing/fake_mcp.js";
import { McpConnection } from "./client.js";
import { HttpTransport } from "./transport_http.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

async function fakeServer(
  opts: Parameters<typeof startFakeMcpServer>[0] = {},
): Promise<FakeMcpServer> {
  const server = await startFakeMcpServer({
    tools: [{ name: "greet", handler: (args) => ({ text: `hello ${String(args["who"])}` }) }],
    ...opts,
  });
  cleanups.push(() => server.close());
  return server;
}

function connect(
  server: FakeMcpServer,
  opts: { acquireToken?: (failedToken: string | null) => Promise<string> } = {},
): { transport: HttpTransport; connection: McpConnection } {
  const transport = new HttpTransport({
    serverName: "srv",
    url: server.url,
    ...(opts.acquireToken !== undefined ? { acquireToken: opts.acquireToken } : {}),
  });
  const connection = new McpConnection(transport, { serverName: "srv", timeoutMs: 10_000 });
  return { transport, connection };
}

describe("HttpTransport — plain JSON mode", () => {
  it("initializes, calls a tool, and sends the negotiated protocol version after init", async () => {
    const server = await fakeServer();
    const { connection } = connect(server);
    await connection.initialize();
    const result = await connection.callTool("greet", { who: "boardwalk" });
    expect(result).toEqual({ content: "hello boardwalk", isError: false });

    // The initialize POST itself carries no protocol-version header; everything after does.
    const initRequest = server.requests.find((r) => r.rpcMethod === "initialize");
    const callRequest = server.requests.find((r) => r.rpcMethod === "tools/call");
    expect(initRequest?.headers["mcp-protocol-version"]).toBeUndefined();
    expect(callRequest?.headers["mcp-protocol-version"]).toBe("2025-06-18");
    expect(callRequest?.headers.accept).toBe("application/json, text/event-stream");
  });
});

describe("HttpTransport — SSE mode", () => {
  it("reads JSON-RPC responses out of an event-stream reply", async () => {
    const server = await fakeServer({ sse: true });
    const { connection } = connect(server);
    await connection.initialize();
    await expect(connection.callTool("greet", { who: "sse" })).resolves.toEqual({
      content: "hello sse",
      isError: false,
    });
  });
});

describe("HttpTransport — sessions", () => {
  it("captures Mcp-Session-Id at initialize, replays it, and DELETEs it on close", async () => {
    const server = await fakeServer({ sessionId: "sess-42" });
    const { connection } = connect(server);
    await connection.initialize();
    await connection.callTool("greet", { who: "x" }); // 404s if the session id were dropped
    await connection.close();

    const callRequest = server.requests.find((r) => r.rpcMethod === "tools/call");
    expect(callRequest?.headers["mcp-session-id"]).toBe("sess-42");
    expect(server.deletes).toBe(1);
    const deleteRequest = server.requests.find((r) => r.httpMethod === "DELETE");
    expect(deleteRequest?.headers["mcp-session-id"]).toBe("sess-42");
  });

  it("close without a session is a no-op (no DELETE)", async () => {
    const server = await fakeServer();
    const { connection } = connect(server);
    await connection.initialize();
    await connection.close();
    expect(server.deletes).toBe(0);
  });
});

// A stateful server may retire a session whenever it likes — reaping one whose stream went idle is
// routine, and an agent leaf that pauses to think between two tool calls trips it every time. The
// spec's answer is a fresh InitializeRequest, so an expiry has to be invisible to the caller
// rather than surfacing as a tool failure the model can only retry into.
describe("HttpTransport — session expiry", () => {
  it("re-handshakes and replays the call when the server retires the session", async () => {
    const server = await fakeServer({ sessionId: "sess" });
    const { connection } = connect(server);
    await connection.initialize();
    await connection.callTool("greet", { who: "before" });

    server.expireSessions();
    await expect(connection.callTool("greet", { who: "after" })).resolves.toEqual({
      content: "hello after",
      isError: false,
    });

    // A second session was opened, and the replayed call carried the NEW id, not the dead one.
    expect(server.issuedSessions).toEqual(["sess", "sess-2"]);
    const calls = server.requests.filter((r) => r.rpcMethod === "tools/call");
    expect(calls.at(-1)?.headers["mcp-session-id"]).toBe("sess-2");
  });

  it("re-handshakes for tools/list too, so a leaf can start after an expiry", async () => {
    const server = await fakeServer({ sessionId: "sess" });
    const { connection } = connect(server);
    await connection.initialize();
    server.expireSessions();

    await expect(connection.listTools()).resolves.toEqual([
      { name: "greet", description: "fake tool greet", inputSchema: { type: "object" } },
    ]);
    expect(server.issuedSessions).toEqual(["sess", "sess-2"]);
  });

  it("DELETEs the session it actually holds after recovering", async () => {
    const server = await fakeServer({ sessionId: "sess" });
    const { connection } = connect(server);
    await connection.initialize();
    server.expireSessions();
    await connection.callTool("greet", { who: "x" });
    await connection.close();

    const deleteRequest = server.requests.find((r) => r.httpMethod === "DELETE");
    expect(deleteRequest?.headers["mcp-session-id"]).toBe("sess-2");
  });

  it("gives up after one retry rather than looping on a server that keeps expiring", async () => {
    // A server that hands out a session and then rejects every request made with it. Driven by a
    // stub rather than a timer so the pathological case is exact, not a race.
    let initializes = 0;
    const transport = new HttpTransport({
      serverName: "srv",
      url: "http://127.0.0.1:1/mcp",
      fetchImpl: (_url, init) => {
        // The transport always sends a JSON string body; narrow rather than stringify a BodyInit.
        const body = typeof init?.body === "string" ? init.body : "{}";
        const message = JSON.parse(body) as { id?: number; method?: string };
        if (message.id === undefined) return Promise.resolve(new Response(null, { status: 202 }));
        if (message.method === "initialize") {
          initializes += 1;
          const result = {
            jsonrpc: "2.0",
            id: message.id,
            result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "s" } },
          };
          return Promise.resolve(
            new Response(JSON.stringify(result), {
              status: 200,
              headers: { "content-type": "application/json", "mcp-session-id": "always-stale" },
            }),
          );
        }
        return Promise.resolve(new Response("unknown session", { status: 404 }));
      },
    });
    const connection = new McpConnection(transport, { serverName: "srv", timeoutMs: 10_000 });
    await connection.initialize();

    await expect(connection.callTool("greet", { who: "x" })).rejects.toThrow(/expired the session/);
    // The original handshake plus exactly one recovery — never a loop.
    expect(initializes).toBe(2);
  });

  it("leaves a 404 with no session in play as an ordinary error", async () => {
    // Nothing has been established yet, so a 404 means the URL is wrong. Re-handshaking would only
    // hide that behind a second identical failure, so this must stay a plain provider error.
    let calls = 0;
    const transport = new HttpTransport({
      serverName: "srv",
      url: "http://127.0.0.1:1/mcp",
      fetchImpl: () => {
        calls += 1;
        return Promise.resolve(new Response("no such endpoint", { status: 404 }));
      },
    });
    const connection = new McpConnection(transport, { serverName: "srv", timeoutMs: 10_000 });
    await expect(connection.initialize()).rejects.toBeInstanceOf(EngineError);
    expect(calls).toBe(1); // not retried
  });
});

describe("HttpTransport — 401 handling", () => {
  it("on 401 asks the hook (no failed token the first time) and retries with the bearer", async () => {
    const validTokens = new Set(["good-token"]);
    const server = await fakeServer({ auth: { validTokens } });
    const asked: (string | null)[] = [];
    const { connection } = connect(server, {
      acquireToken: (failedToken) => {
        asked.push(failedToken);
        return Promise.resolve("good-token");
      },
    });
    await connection.initialize();
    await expect(connection.callTool("greet", { who: "auth" })).resolves.toEqual({
      content: "hello auth",
      isError: false,
    });

    expect(asked).toEqual([null]); // exactly one ask; nothing had failed yet
    // Once acquired, the token rides along without further 401 round-trips.
    const callRequest = server.requests.find((r) => r.rpcMethod === "tools/call");
    expect(callRequest?.headers.authorization).toBe("Bearer good-token");
  });

  it("a rejected token is reported back (invalidate) and the fresh one is retried once", async () => {
    const validTokens = new Set(["fresh-token"]);
    const server = await fakeServer({ auth: { validTokens } });
    const asked: (string | null)[] = [];
    let call = 0;
    const { connection } = connect(server, {
      acquireToken: (failedToken) => {
        asked.push(failedToken);
        call += 1;
        return Promise.resolve(call === 1 ? "stale-token" : "fresh-token");
      },
    });
    await connection.initialize();
    expect(asked).toEqual([null, "stale-token"]);
  });

  it("a 401 with no hook — and a 401 that survives a fresh token — fail loudly", async () => {
    const server = await fakeServer({ auth: { validTokens: new Set(["never-issued"]) } });
    const bare = connect(server);
    await expect(bare.connection.initialize()).rejects.toThrow(/401 Unauthorized/);

    const hooked = connect(server, { acquireToken: () => Promise.resolve("always-wrong") });
    const error: unknown = await hooked.connection.initialize().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(EngineError);
    // The hint distinguishes "token kept failing" from the no-hook case.
    expect(error instanceof EngineError ? (error.hint ?? "") : "").toContain("re-authorize");
  });

  it("the hook throwing (engine holds no token) propagates as the call's failure", async () => {
    const server = await fakeServer({ auth: { validTokens: new Set(["x"]) } });
    const { connection } = connect(server, {
      acquireToken: () => Promise.reject(new Error("authorize me first")),
    });
    await expect(connection.initialize()).rejects.toThrow(/authorize me first/);
  });
});

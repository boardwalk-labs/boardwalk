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

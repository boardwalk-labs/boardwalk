// Exercises the stdio transport against a real spawned process: the plain-JS fixture
// (fixtures/echo_server.mjs) speaks initialize/tools-list/tools-call over newline-delimited
// JSON, so these tests cover spawning, framing, env injection, kill-on-close, and spawn
// failure — the full lifecycle a workflow's stdio McpServerRef goes through.

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { McpConnection } from "./client.js";
import { StdioTransport } from "./transport_stdio.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/echo_server.mjs", import.meta.url));

function fixtureConnection(env?: Record<string, string>): McpConnection {
  return new McpConnection(
    new StdioTransport({
      serverName: "echo",
      command: process.execPath,
      args: [FIXTURE],
      ...(env !== undefined ? { env } : {}),
    }),
    { serverName: "echo", timeoutMs: 10_000 },
  );
}

describe("StdioTransport against the echo fixture", () => {
  it("initializes, lists tools, and round-trips a tool call", async () => {
    const connection = fixtureConnection();
    try {
      await connection.initialize();
      const tools = await connection.listTools();
      expect(tools).toEqual([
        {
          name: "echo",
          description: "Echoes text back",
          inputSchema: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
          },
        },
      ]);
      const result = await connection.callTool("echo", { text: "ahoy" });
      expect(result).toEqual({ content: "echo: ahoy", isError: false });
    } finally {
      await connection.close();
    }
  });

  it("layers the ref's env over process.env for the spawned server", async () => {
    const connection = fixtureConnection({ ECHO_PREFIX: "custom-prefix" });
    try {
      await connection.initialize();
      const result = await connection.callTool("echo", { text: "x" });
      expect(result.content).toBe("custom-prefix: x");
    } finally {
      await connection.close();
    }
  });

  it("surfaces the server's isError result", async () => {
    const connection = fixtureConnection();
    try {
      await connection.initialize();
      await expect(connection.callTool("imaginary", {})).resolves.toMatchObject({ isError: true });
    } finally {
      await connection.close();
    }
  });

  it("a spawn failure rejects the in-flight request with a clear pointer at the command", async () => {
    const transport = new StdioTransport({
      serverName: "ghost",
      command: "definitely-not-a-real-command-1f9e",
    });
    // Let the async spawn failure land first so the assertion sees the spawn error itself
    // rather than a racing pipe error from a write to the half-dead child.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const connection = new McpConnection(transport, { serverName: "ghost", timeoutMs: 10_000 });
    await expect(connection.initialize()).rejects.toThrow(
      /failed to spawn "definitely-not-a-real-command-1f9e"/,
    );
    await connection.close();
  });

  it("close() kills the server process (no zombie outlives the connection)", async () => {
    const transport = new StdioTransport({
      serverName: "echo",
      command: process.execPath,
      args: [FIXTURE],
    });
    const connection = new McpConnection(transport, { serverName: "echo", timeoutMs: 10_000 });
    await connection.initialize();
    await connection.close();
    // Sends after a deliberate close fail fast instead of hanging on a dead process.
    await expect(connection.callTool("echo", { text: "x" })).rejects.toThrow(/closed/);
  });
});

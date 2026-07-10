// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { McpConnection } from "./client.js";
import type { JsonRpcOutbound, McpTransport } from "./jsonrpc.js";

/** A fake MCP server behind the transport seam: scripts results per method, records calls. */
function fakeServer(opts: {
  protocolVersion?: string;
  pages?: { tools: object[]; nextCursor?: string }[];
  callResult?: object;
}): {
  transport: McpTransport & { setProtocolVersion(version: string): void };
  calls: { method: string; params: unknown }[];
  versionsSet: string[];
} {
  const calls: { method: string; params: unknown }[] = [];
  const versionsSet: string[] = [];
  let messageCb: ((message: unknown) => void) | null = null;
  let page = 0;
  const transport = {
    send: (message: JsonRpcOutbound): Promise<void> => {
      if (!("id" in message)) return Promise.resolve(); // notification — no reply
      if (!("method" in message)) return Promise.resolve();
      calls.push({ method: message.method, params: message.params });
      let result: object;
      switch (message.method) {
        case "initialize":
          result = {
            protocolVersion: opts.protocolVersion ?? "2025-06-18",
            capabilities: {},
            serverInfo: { name: "fake", version: "0" },
          };
          break;
        case "tools/list": {
          const current = opts.pages?.[page] ?? { tools: [] };
          page += 1;
          result = {
            tools: current.tools,
            ...(current.nextCursor !== undefined ? { nextCursor: current.nextCursor } : {}),
          };
          break;
        }
        case "tools/call":
          result = opts.callResult ?? { content: [] };
          break;
        default:
          result = {};
      }
      const id = message.id;
      queueMicrotask(() => messageCb?.({ jsonrpc: "2.0", id, result }));
      return Promise.resolve();
    },
    onMessage: (cb: (message: unknown) => void): void => {
      messageCb = cb;
    },
    onClose: (): void => undefined,
    close: (): Promise<void> => Promise.resolve(),
    setProtocolVersion: (version: string): void => {
      versionsSet.push(version);
    },
  };
  return { transport, calls, versionsSet };
}

describe("McpConnection.initialize", () => {
  it("offers 2025-06-18, accepts the negotiated version, pushes it to the transport, then notifies", async () => {
    const server = fakeServer({ protocolVersion: "2025-03-26" });
    const connection = new McpConnection(server.transport, { serverName: "srv" });
    await connection.initialize();

    expect(server.calls[0]?.method).toBe("initialize");
    expect(server.calls[0]?.params).toMatchObject({ protocolVersion: "2025-06-18" });
    // The negotiated (older) version is what later HTTP requests must carry.
    expect(server.versionsSet).toEqual(["2025-03-26"]);
  });

  it("rejects an unknown protocol version loudly", async () => {
    const server = fakeServer({ protocolVersion: "2099-01-01" });
    const connection = new McpConnection(server.transport, { serverName: "srv" });
    await expect(connection.initialize()).rejects.toThrow(/"2099-01-01".*does not speak/s);
  });
});

describe("McpConnection.listTools", () => {
  it("follows nextCursor pagination to the end and normalizes missing fields", async () => {
    const server = fakeServer({
      pages: [
        { tools: [{ name: "alpha", description: "first" }], nextCursor: "p2" },
        { tools: [{ name: "beta", inputSchema: { type: "object", properties: {} } }] },
      ],
    });
    const connection = new McpConnection(server.transport, { serverName: "srv" });
    await connection.initialize();
    const tools = await connection.listTools();

    expect(tools).toEqual([
      { name: "alpha", description: "first", inputSchema: { type: "object" } },
      { name: "beta", description: "", inputSchema: { type: "object", properties: {} } },
    ]);
    // The second page carried the first page's cursor.
    expect(server.calls[2]?.params).toEqual({ cursor: "p2" });
  });

  it("fails loudly on a malformed tools/list response", async () => {
    const server = fakeServer({ pages: [{ tools: [{ notAName: true }] }] });
    const connection = new McpConnection(server.transport, { serverName: "srv" });
    await connection.initialize();
    await expect(connection.listTools()).rejects.toThrow(/malformed tools\/list/);
  });
});

describe("McpConnection.callTool", () => {
  it("concatenates text-only content into a plain string", async () => {
    const server = fakeServer({
      callResult: {
        content: [
          { type: "text", text: "line one" },
          { type: "text", text: "line two" },
        ],
      },
    });
    const connection = new McpConnection(server.transport, { serverName: "srv" });
    await connection.initialize();
    const result = await connection.callTool("shot", {});
    expect(result).toEqual({ content: "line one\nline two", isError: false });
  });

  it("carries an image block as a file content part so the model can see it", async () => {
    const server = fakeServer({
      callResult: {
        content: [
          { type: "text", text: "here" },
          { type: "image", data: "aGk=", mimeType: "image/png" },
        ],
      },
    });
    const connection = new McpConnection(server.transport, { serverName: "srv" });
    await connection.initialize();
    const result = await connection.callTool("shot", {});
    expect(result).toEqual({
      content: [
        { type: "text", text: "here" },
        { type: "file", file: { mimeType: "image/png", data: "aGk=" } },
      ],
      isError: false,
    });
  });

  it("defaults an image block with no mimeType to image/png", async () => {
    const server = fakeServer({ callResult: { content: [{ type: "image", data: "aGk=" }] } });
    const connection = new McpConnection(server.transport, { serverName: "srv" });
    await connection.initialize();
    const result = await connection.callTool("shot", {});
    expect(result).toEqual({
      content: [{ type: "file", file: { mimeType: "image/png", data: "aGk=" } }],
      isError: false,
    });
  });

  it("still degrades a non-text, non-image block to a [type] placeholder string", async () => {
    const server = fakeServer({
      callResult: { content: [{ type: "text", text: "note" }, { type: "resource" }] },
    });
    const connection = new McpConnection(server.transport, { serverName: "srv" });
    await connection.initialize();
    const result = await connection.callTool("shot", {});
    expect(result).toEqual({ content: "note\n[resource]", isError: false });
  });

  it("surfaces the server's isError flag", async () => {
    const server = fakeServer({
      callResult: { content: [{ type: "text", text: "boom" }], isError: true },
    });
    const connection = new McpConnection(server.transport, { serverName: "srv" });
    await connection.initialize();
    await expect(connection.callTool("explode", {})).resolves.toEqual({
      content: "boom",
      isError: true,
    });
  });
});

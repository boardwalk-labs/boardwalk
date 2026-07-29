// SPDX-License-Identifier: Apache-2.0

// Test double: a scriptable MCP server speaking streamable HTTP (single-JSON or SSE replies,
// session ids, pagination, optional Bearer auth with an RFC 9728 metadata hint). Lives in
// src/testing/ — excluded from the build and coverage — because the unit suites, the leaf
// tests, the OAuth end-to-end, and the conformance harness all need the same server and test
// helpers may be shared where production code may not (this latitude covers test BODIES,
// not infrastructure this size).

import http from "node:http";
import { z } from "zod";

export interface FakeMcpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  /** Produces the tools/call text content; set isError for an MCP-level tool failure. */
  handler: (args: Record<string, unknown>) => { text: string; isError?: boolean };
}

export interface FakeMcpOptions {
  tools?: FakeMcpTool[];
  /** Reply in SSE framing instead of a single JSON body. */
  sse?: boolean;
  /**
   * Issue this session id at initialize and require it on every later request (404 if not). A
   * re-initialize mints a fresh id (`<sessionId>-2`, `-3`, …), so a test can drive the
   * expire-then-recover path a real stateful server puts a client through.
   */
  sessionId?: string;
  /** tools/list page size — set below the tool count to force nextCursor pagination. */
  pageSize?: number;
  /** The protocol version the server answers initialize with. Default "2025-06-18". */
  protocolVersion?: string;
  /** Require `Authorization: Bearer <one of validTokens>`; 401 (+ optional RFC 9728 hint) otherwise. */
  auth?: { validTokens: Set<string>; resourceMetadataUrl?: string };
}

export interface RecordedMcpRequest {
  httpMethod: string;
  rpcMethod: string | null;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export interface FakeMcpServer {
  url: string;
  requests: RecordedMcpRequest[];
  /** Session-teardown DELETEs received. */
  deletes: number;
  /** Session ids handed out at initialize, in order. */
  issuedSessions: readonly string[];
  /**
   * Drop every live session, so the next request carrying one gets 404 — what a stateful
   * streamable-HTTP server does when it reaps a session whose stream went idle.
   */
  expireSessions(): void;
  close(): Promise<void>;
}

const rpcRequestSchema = z.looseObject({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]).nullish(),
  method: z.string(),
  params: z.unknown().optional(),
});

const callParamsSchema = z.looseObject({
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()).optional(),
});

const listParamsSchema = z.looseObject({ cursor: z.string().optional() });

export function startFakeMcpServer(opts: FakeMcpOptions = {}): Promise<FakeMcpServer> {
  const tools = opts.tools ?? [];
  const protocolVersion = opts.protocolVersion ?? "2025-06-18";
  const requests: RecordedMcpRequest[] = [];
  let deletes = 0;
  // Sessions the server currently honours, and every id it has ever issued. Two collections
  // because expiry must reject a live id without forgetting that it was handed out.
  const liveSessions = new Set<string>();
  const issuedSessions: string[] = [];

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      const record: RecordedMcpRequest = {
        httpMethod: req.method ?? "",
        rpcMethod: null,
        headers: req.headers,
        body,
      };
      requests.push(record);

      if (opts.auth !== undefined) {
        const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
        if (token === undefined || !opts.auth.validTokens.has(token)) {
          const challenge =
            opts.auth.resourceMetadataUrl !== undefined
              ? `Bearer resource_metadata="${opts.auth.resourceMetadataUrl}"`
              : "Bearer";
          res.writeHead(401, { "www-authenticate": challenge }).end();
          return;
        }
      }

      if (req.method === "DELETE") {
        deletes += 1;
        res.writeHead(200).end();
        return;
      }

      let json: unknown;
      try {
        json = JSON.parse(body);
      } catch {
        res.writeHead(400).end("not json");
        return;
      }
      const parsed = rpcRequestSchema.safeParse(json);
      if (!parsed.success) {
        res.writeHead(400).end("not jsonrpc");
        return;
      }
      const msg = parsed.data;
      record.rpcMethod = msg.method;

      if (
        opts.sessionId !== undefined &&
        msg.method !== "initialize" &&
        !liveSessions.has(String(req.headers["mcp-session-id"] ?? ""))
      ) {
        // The spec's expiry signal: 404 to a request carrying a session the server no longer holds.
        res.writeHead(404).end("unknown session");
        return;
      }

      if (msg.id === undefined || msg.id === null) {
        res.writeHead(202).end(); // notification
        return;
      }

      const reply = handle(msg.method, msg.params, msg.id);
      const headers: Record<string, string> = {};
      if (opts.sessionId !== undefined && msg.method === "initialize") {
        // The first session is exactly the configured id; each re-initialize mints the next.
        const id =
          issuedSessions.length === 0
            ? opts.sessionId
            : `${opts.sessionId}-${String(issuedSessions.length + 1)}`;
        issuedSessions.push(id);
        liveSessions.add(id);
        headers["mcp-session-id"] = id;
      }
      if (opts.sse === true) {
        res.writeHead(200, { ...headers, "content-type": "text/event-stream" });
        res.end(`event: message\ndata: ${JSON.stringify(reply)}\n\n`);
      } else {
        res.writeHead(200, { ...headers, "content-type": "application/json" });
        res.end(JSON.stringify(reply));
      }
    });
  });

  function handle(method: string, params: unknown, id: string | number): object {
    if (method === "initialize") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "fake-mcp", version: "1.0.0" },
        },
      };
    }
    if (method === "tools/list") {
      const pageSize = opts.pageSize ?? (tools.length > 0 ? tools.length : 1);
      const cursorRaw = listParamsSchema.safeParse(params ?? {});
      const start =
        cursorRaw.success && cursorRaw.data.cursor !== undefined
          ? Number(cursorRaw.data.cursor)
          : 0;
      const page = tools.slice(start, start + pageSize).map((tool) => ({
        name: tool.name,
        description: tool.description ?? `fake tool ${tool.name}`,
        inputSchema: tool.inputSchema ?? { type: "object" },
      }));
      const next = start + pageSize;
      return {
        jsonrpc: "2.0",
        id,
        result: { tools: page, ...(next < tools.length ? { nextCursor: String(next) } : {}) },
      };
    }
    if (method === "tools/call") {
      const call = callParamsSchema.safeParse(params);
      const tool = call.success ? tools.find((t) => t.name === call.data.name) : undefined;
      if (!call.success || tool === undefined) {
        return { jsonrpc: "2.0", id, error: { code: -32602, message: "unknown tool" } };
      }
      const outcome = tool.handler(call.data.arguments ?? {});
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: outcome.text }],
          isError: outcome.isError ?? false,
        },
      };
    }
    return { jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } };
  }

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${String(port)}/mcp`,
        requests,
        get deletes(): number {
          return deletes;
        },
        issuedSessions,
        expireSessions: () => liveSessions.clear(),
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

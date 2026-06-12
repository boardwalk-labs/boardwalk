// Test double: a scriptable MCP server speaking streamable HTTP (single-JSON or SSE replies,
// session ids, pagination, optional Bearer auth with an RFC 9728 metadata hint). Lives in
// src/testing/ — excluded from the build and coverage — because the unit suites, the leaf
// tests, the OAuth end-to-end, and the conformance harness all need the same server and test
// helpers may be shared where production code may not (CODE_QUALITY §3.2 covers test BODIES,
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
  /** Issue this session id at initialize and require it on every later request (404 if not). */
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
        req.headers["mcp-session-id"] !== opts.sessionId
      ) {
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
        headers["mcp-session-id"] = opts.sessionId;
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
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

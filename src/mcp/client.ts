// SPDX-License-Identifier: Apache-2.0

// The MCP connection: the protocol conversation (initialize handshake, tools/list pagination,
// tools/call) over any transport. Lives in the RUN PROCESS — tool execution must happen where
// the program runs — while OAuth token state stays parent-side (the transport's hook brokers
// it over IPC). Every server response is Zod-validated: an MCP server's output is untrusted
// input like any provider's.

import { z } from "zod";
import type { ContentPart } from "../agent/conversation.js";
import { EngineError } from "../errors.js";
import { JsonRpcClient, type McpTransport } from "./jsonrpc.js";

/**
 * Protocol revisions this client speaks, newest first. We OFFER the newest; a server may
 * answer with any revision it prefers, and these three are wire-compatible for the subset we
 * use (initialize / tools/list / tools/call). Anything else is rejected loudly — guessing at
 * an unknown revision's semantics would be a silent-degradation bug.
 */
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;

/** A tool the server advertises, normalized for the agent loop's ToolSpec shape. */
export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** A tools/call outcome + the server's error flag. `content` is flattened text in the common case;
 *  when the server returns image blocks it becomes content parts (text + file) so the pixels reach
 *  the model instead of being dropped to a `[image]` placeholder. */
export interface McpCallResult {
  content: string | readonly ContentPart[];
  isError: boolean;
}

const initializeResultSchema = z.looseObject({ protocolVersion: z.string().min(1) });

const listToolsResultSchema = z.looseObject({
  tools: z.array(
    z.looseObject({
      name: z.string().min(1),
      description: z.string().optional(),
      inputSchema: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
  nextCursor: z.string().nullish(),
});

const callToolResultSchema = z.looseObject({
  // An MCP content block: `text` for text blocks, `data` (base64) + `mimeType` for image/audio blocks
  // (the MCP `ImageContent` shape). Everything else degrades to a `[type]` placeholder.
  content: z
    .array(
      z.looseObject({
        type: z.string(),
        text: z.string().optional(),
        data: z.string().optional(),
        mimeType: z.string().optional(),
      }),
    )
    .optional(),
  isError: z.boolean().nullish(),
});

/** Pagination runaway guard — a server endlessly re-issuing cursors must not hang the run. */
const MAX_TOOL_PAGES = 100;

export interface McpConnectionOptions {
  /** The server's name from the agent() call — prefixes its tools, names it in errors. */
  serverName: string;
  /** Per-request timeout override (tests use short ones). */
  timeoutMs?: number;
}

export class McpConnection {
  private readonly rpc: JsonRpcClient;
  private readonly transport: McpTransport;
  readonly serverName: string;

  constructor(transport: McpTransport, opts: McpConnectionOptions) {
    this.transport = transport;
    this.serverName = opts.serverName;
    this.rpc = new JsonRpcClient(transport, {
      label: opts.serverName,
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    });
  }

  /** The MCP handshake: version negotiation, then the initialized notification. */
  async initialize(): Promise<void> {
    const raw = await this.rpc.request("initialize", {
      protocolVersion: SUPPORTED_PROTOCOL_VERSIONS[0],
      capabilities: {},
      clientInfo: { name: "boardwalk-engine", version: "0.1.0" },
    });
    const parsed = initializeResultSchema.safeParse(raw);
    if (!parsed.success) {
      throw new EngineError(
        "PROVIDER_ERROR",
        `MCP server "${this.serverName}" returned a malformed initialize response.`,
      );
    }
    const version = parsed.data.protocolVersion;
    if (!SUPPORTED_PROTOCOL_VERSIONS.some((v) => v === version)) {
      throw new EngineError(
        "PROVIDER_ERROR",
        `MCP server "${this.serverName}" negotiated protocol version "${version}", which this ` +
          `engine does not speak.`,
        `Supported versions: ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")}.`,
      );
    }
    // The HTTP transport replays the negotiated version as a header on every later request
    // (spec requirement); stdio has no headers — hence the optional structural probe.
    if (hasVersionHook(this.transport)) this.transport.setProtocolVersion(version);
    await this.rpc.notify("notifications/initialized");
  }

  /** Every tool the server advertises, following nextCursor pagination to the end. */
  async listTools(): Promise<McpToolInfo[]> {
    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOL_PAGES; page++) {
      const raw = await this.rpc.request("tools/list", cursor !== undefined ? { cursor } : {});
      const parsed = listToolsResultSchema.safeParse(raw);
      if (!parsed.success) {
        throw new EngineError(
          "PROVIDER_ERROR",
          `MCP server "${this.serverName}" returned a malformed tools/list response.`,
        );
      }
      for (const tool of parsed.data.tools) {
        tools.push({
          name: tool.name,
          description: tool.description ?? "",
          // A missing schema means "takes anything" — advertise the loosest valid object schema.
          inputSchema: tool.inputSchema ?? { type: "object" },
        });
      }
      if (parsed.data.nextCursor === undefined || parsed.data.nextCursor === null) return tools;
      cursor = parsed.data.nextCursor;
    }
    throw new EngineError(
      "PROVIDER_ERROR",
      `MCP server "${this.serverName}" paginated tools/list past ${String(MAX_TOOL_PAGES)} pages.`,
    );
  }

  /** Invoke a server tool. Text blocks flatten to a model-bound string (the common case); when the
   *  server returns an image block, the result becomes content parts so the image reaches the model
   *  (a vision tool like a browser `screenshot` is otherwise dropped to `[image]`). Any other
   *  non-text block still degrades to a `[type]` placeholder. */
  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const raw = await this.rpc.request("tools/call", { name, arguments: args });
    const parsed = callToolResultSchema.safeParse(raw);
    if (!parsed.success) {
      throw new EngineError(
        "PROVIDER_ERROR",
        `MCP server "${this.serverName}" returned a malformed tools/call response for "${name}".`,
      );
    }
    const items = parsed.data.content ?? [];
    const isError = parsed.data.isError ?? false;
    // Only reach for content parts when an image is actually present — text-only results stay a plain
    // string so the overwhelmingly common path and its consumers are unchanged.
    const hasImage = items.some((item) => item.type === "image" && item.data !== undefined);
    if (!hasImage) {
      const content = items
        .map((item) =>
          item.type === "text" && item.text !== undefined ? item.text : `[${item.type}]`,
        )
        .join("\n");
      return { content, isError };
    }
    const parts: ContentPart[] = items.map((item) => {
      if (item.type === "text" && item.text !== undefined) return { type: "text", text: item.text };
      if (item.type === "image" && item.data !== undefined) {
        return { type: "file", file: { mimeType: item.mimeType ?? "image/png", data: item.data } };
      }
      return { type: "text", text: `[${item.type}]` };
    });
    return { content: parts, isError };
  }

  /** Tear the connection down (rejects anything in flight; kills/deletes transport state). */
  async close(): Promise<void> {
    await this.rpc.close();
  }
}

/**
 * Structurally probe for the HTTP transport's version hook without importing it — keeps this
 * file transport-agnostic so test fakes (and the stdio transport) need no stub method.
 */
function hasVersionHook(
  transport: McpTransport,
): transport is McpTransport & { setProtocolVersion(version: string): void } {
  return typeof Reflect.get(transport, "setProtocolVersion") === "function";
}

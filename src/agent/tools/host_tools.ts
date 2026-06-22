// SPDX-License-Identifier: Apache-2.0

// The host-backed built-ins: webfetch, web_search, artifacts. Unlike the Tier-1 sandbox
// tools (which only need the workspace), these reach OUT — to the network, to a search provider,
// to durable artifact storage — so they go through a small `ToolHost`
// seam, in the same spirit as the leaf's `LeafIo`/`streamModel` seam. The OSS single-node engine
// supplies a default local backend (see child_host.ts); the hosted platform swaps in a
// broker-backed one (egress-policed fetch, a metered search provider, S3 artifacts) so the SAME
// tools behave identically everywhere with no per-environment branching in the loop.
//
// LSP diagnostics are NOT here: they are ENGINE-NATIVE (the engine spawns a language server in the
// run's workspace, like `bash` spawns a process), so they need no host backend and route through
// the per-run LspService, not this seam. See src/agent/lsp/.
//
// A backend that does not implement a given hook means that tool is not present on the engine —
// selecting it (or asking for it via `builtins: "all"` without the backend) fails loudly. We
// register a host tool only when its backend exists, so default-on `"all"` never advertises a
// tool the engine can't actually run.

import { EngineError } from "../../errors.js";
import type { ExecutableTool } from "../tools.js";

/** A web search result the host returns; the tool renders these into model-bound text. */
export interface WebSearchResult {
  title: string;
  url: string;
  snippet?: string;
}

/** What a host-backed fetch returns — already size-bounded by the backend. */
export interface FetchResult {
  status: number;
  contentType: string | undefined;
  body: string;
  truncated: boolean;
}

/** A general HTTP request the `http` tool makes (any method, headers, body). The `body` is sent
 *  verbatim; the backend bounds the RESPONSE size. URL/method/headers are untrusted model input —
 *  the backend validates the scheme and method. */
export interface HttpRequestInput {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

/** A stored artifact reference (mirrors the SDK ArtifactRef the host bridge returns). */
export interface ArtifactWriteResult {
  id: string;
  name: string;
  url: string;
}

/**
 * The infrastructure seam the host-backed built-ins call. Each hook is OPTIONAL: a backend that
 * omits one means that tool is unavailable on the engine (so it is never registered, and naming
 * it fails loudly). The single-node engine implements all four locally; the platform's broker
 * implements them over its services. Hooks run in the program process (the trusted layer) but
 * delegate the actual capability to whoever holds the credentials/network/storage.
 */
export interface ToolHost {
  // Function-PROPERTY syntax (not method shorthand) on purpose: these hooks are values a host
  // assembles and the tools read off the object — property syntax avoids the unbound-`this` trap.
  webSearch?: (query: string, opts?: { limit?: number }) => Promise<WebSearchResult[]>;
  fetchUrl?: (url: string, opts?: { maxBytes?: number }) => Promise<FetchResult>;
  httpRequest?: (req: HttpRequestInput, opts?: { maxBytes?: number }) => Promise<FetchResult>;
  writeArtifact?: (
    name: string,
    contentType: string,
    body: string,
    metadata?: Record<string, unknown>,
  ) => Promise<ArtifactWriteResult>;
  readArtifact?: (name: string) => Promise<string>;
}

/** Build the host-backed tools whose backend the host actually provides (others stay unregistered). */
export function hostBackedTools(host: ToolHost | undefined): Map<string, ExecutableTool> {
  const tools = new Map<string, ExecutableTool>();
  if (host?.fetchUrl !== undefined) tools.set("webfetch", webfetchTool(host));
  if (host?.httpRequest !== undefined) tools.set("http", httpTool(host));
  if (host?.webSearch !== undefined) tools.set("web_search", webSearchTool(host));
  if (host?.writeArtifact !== undefined) tools.set("artifacts", artifactsTool(host));
  return tools;
}

/** Names of every host-backed built-in (whether or not a backend is present), for selection checks. */
export const HOST_BACKED_TOOL_NAMES: readonly string[] = [
  "webfetch",
  "http",
  "web_search",
  "artifacts",
];

/** Methods the `http` tool accepts. POST/PUT/PATCH/DELETE make it a MUTATING tool — which is why
 *  `http` is NOT in the read-only set (webfetch, a GET-only reader, is). */
const HTTP_METHODS: readonly string[] = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
];

function webfetchTool(host: ToolHost): ExecutableTool {
  const fetchUrl = host.fetchUrl;
  if (fetchUrl === undefined) throw unreachable("webfetch");
  return {
    name: "webfetch",
    description:
      "Fetch the contents of an http(s) URL and return the response body as text (size-bounded).",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The http(s) URL to fetch." },
        maxBytes: { type: "number", description: "Optional cap on bytes returned." },
      },
      required: ["url"],
      additionalProperties: false,
    },
    execute: async (input) => {
      const url = requireString(input, "url");
      const maxBytes = optionalPositiveInt(input["maxBytes"], "maxBytes");
      const result = await fetchUrl(url, maxBytes !== undefined ? { maxBytes } : undefined);
      const header = `[HTTP ${String(result.status)}${result.contentType !== undefined ? ` ${result.contentType}` : ""}]`;
      return `${header}\n${result.body}${result.truncated ? "\n…[response truncated]" : ""}`;
    },
  };
}

function httpTool(host: ToolHost): ExecutableTool {
  const httpRequest = host.httpRequest;
  if (httpRequest === undefined) throw unreachable("http");
  return {
    name: "http",
    description:
      "Make an HTTP request to an http(s) URL and return the raw response (status + body, " +
      "size-bounded). Use this to call JSON/REST APIs with any method, headers, or body. For " +
      "reading a web PAGE as text, prefer `webfetch` (it extracts readable text from HTML).",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The http(s) URL to request." },
        method: {
          type: "string",
          enum: [...HTTP_METHODS],
          description: "HTTP method (default GET).",
        },
        headers: {
          type: "object",
          description: "Request headers as a string→string map.",
          additionalProperties: { type: "string" },
        },
        body: { type: "string", description: "Request body (for POST/PUT/PATCH)." },
        maxBytes: { type: "number", description: "Optional cap on response bytes returned." },
      },
      required: ["url"],
      additionalProperties: false,
    },
    execute: async (input) => {
      const url = requireString(input, "url");
      const method = normalizeMethod(input["method"]);
      const headers = optionalStringMap(input["headers"], "headers");
      const body = input["body"];
      if (body !== undefined && typeof body !== "string") {
        throw new EngineError("VALIDATION", `Tool input "body" must be a string.`);
      }
      const maxBytes = optionalPositiveInt(input["maxBytes"], "maxBytes");
      const result = await httpRequest(
        {
          url,
          ...(method !== undefined ? { method } : {}),
          ...(headers !== undefined ? { headers } : {}),
          ...(typeof body === "string" ? { body } : {}),
        },
        maxBytes !== undefined ? { maxBytes } : undefined,
      );
      const header = `[HTTP ${String(result.status)}${result.contentType !== undefined ? ` ${result.contentType}` : ""}]`;
      return `${header}\n${result.body}${result.truncated ? "\n…[response truncated]" : ""}`;
    },
  };
}

function webSearchTool(host: ToolHost): ExecutableTool {
  const webSearch = host.webSearch;
  if (webSearch === undefined) throw unreachable("web_search");
  return {
    name: "web_search",
    description: "Search the web and return ranked results (title, URL, snippet).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query." },
        limit: { type: "number", description: "Maximum number of results (optional)." },
      },
      required: ["query"],
      additionalProperties: false,
    },
    execute: async (input) => {
      const query = requireString(input, "query");
      const limit = optionalPositiveInt(input["limit"], "limit");
      const results = await webSearch(query, limit !== undefined ? { limit } : undefined);
      if (results.length === 0) return "(no results)";
      return results
        .map(
          (r, idx) =>
            `${String(idx + 1)}. ${r.title}\n${r.url}${r.snippet !== undefined ? `\n${r.snippet}` : ""}`,
        )
        .join("\n\n");
    },
  };
}

function artifactsTool(host: ToolHost): ExecutableTool {
  const writeArtifact = host.writeArtifact;
  if (writeArtifact === undefined) throw unreachable("artifacts");
  const readArtifact = host.readArtifact;
  return {
    name: "artifacts",
    description:
      'Read or write a run artifact by name. `action: "write"` stores `content` and returns a ' +
      'download URL; `action: "read"` returns a previously written artifact\'s text.',
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["write", "read"],
          description: "Whether to write or read.",
        },
        name: { type: "string", description: "The artifact's file name." },
        content: { type: "string", description: "The text to store (write only)." },
        contentType: {
          type: "string",
          description: "MIME type (write only; defaults to text/plain).",
        },
      },
      required: ["action", "name"],
      additionalProperties: false,
    },
    execute: async (input) => {
      const action = requireString(input, "action");
      const name = requireString(input, "name");
      if (action === "write") {
        const content = requireString(input, "content");
        const contentType =
          typeof input["contentType"] === "string" ? input["contentType"] : "text/plain";
        const ref = await writeArtifact(name, contentType, content);
        return `wrote artifact ${ref.name} (${ref.url})`;
      }
      if (action === "read") {
        if (readArtifact === undefined) {
          throw new EngineError(
            "UNSUPPORTED",
            "This engine's artifact backend does not support reading artifacts.",
          );
        }
        return await readArtifact(name);
      }
      throw new EngineError(
        "VALIDATION",
        `artifacts: unknown action "${action}" (use "write" or "read").`,
      );
    },
  };
}

function unreachable(tool: string): EngineError {
  // hostBackedTools only builds a tool when its hook exists, so these guards are belt-and-suspenders.
  return new EngineError("INTERNAL", `Built-in "${tool}" was built without its host backend.`);
}

function requireString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string") {
    throw new EngineError("VALIDATION", `Tool input "${key}" must be a string.`);
  }
  return value;
}

function optionalPositiveInt(value: unknown, key: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new EngineError(
      "VALIDATION",
      `Tool input "${key}" must be a positive integer when provided.`,
    );
  }
  return value;
}

/** Normalize + validate the `http` method (case-insensitive); undefined ⇒ the backend defaults GET. */
function normalizeMethod(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new EngineError("VALIDATION", `Tool input "method" must be a string.`);
  }
  const upper = value.toUpperCase();
  if (!HTTP_METHODS.includes(upper)) {
    throw new EngineError(
      "VALIDATION",
      `http: unsupported method "${value}" (use ${HTTP_METHODS.join(", ")}).`,
    );
  }
  return upper;
}

/** Validate an optional string→string map (the `http` headers); a non-string value fails loudly. */
function optionalStringMap(value: unknown, key: string): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new EngineError("VALIDATION", `Tool input "${key}" must be an object of strings.`);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== "string") {
      throw new EngineError("VALIDATION", `Tool input "${key}.${k}" must be a string.`);
    }
    out[k] = v;
  }
  return out;
}

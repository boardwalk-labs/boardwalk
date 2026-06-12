// Capability assembly for an agent() call (SDK SPEC §2.1.1). Capabilities are PER-AGENT
// (decided 2026-06-11): each call brings its own tools/skills/memory — there is nothing to
// check against the manifest, but everything the call names must RESOLVE (fail loudly —
// never silently degrade).
//
// Trust model: tool `execute` runs in the program process (the trusted layer); only RETURN
// VALUES enter model context, and the loop redacts them. Memory tools are filesystem-contained
// to their directory — model-chosen paths are untrusted input.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { z } from "zod";
import type { AgentOptions, McpServerRef, ToolDef } from "@boardwalk-labs/workflow";
import { EngineError } from "../errors.js";
import { McpConnection } from "../mcp/client.js";
import { HttpTransport } from "../mcp/transport_http.js";
import { StdioTransport } from "../mcp/transport_stdio.js";
import type { ToolSpec } from "./conversation.js";
import type { Redactor } from "./redact.js";

/** A tool the loop can actually run. `execute` resolves to model-bound text (pre-redaction). */
export interface ExecutableTool extends ToolSpec {
  execute(input: Record<string, unknown>): Promise<string>;
}

export interface ToolSetContext {
  /** The run's working directory (memory dirs are workspace-relative). */
  workspaceDir: string;
  /** Where this workflow's deployed skills live, or null when none were deployed. */
  skillsDir: string | null;
}

export interface ToolSet {
  tools: ExecutableTool[];
  /** Context blocks (skills, memory index) prepended to the first user message. */
  preamble: string[];
  /** The memory dir the call uses (workspace-relative) — the engine auto-persists it. */
  memoryDir: string | null;
  /** Shape-validated MCP server refs; connecting them is the async step (connectMcpServers). */
  mcp: readonly McpServerRef[];
}

/**
 * Built-in tools this engine implements, selected by name. Deliberately empty in v0: the
 * hosted platform's curated built-ins don't exist locally yet, and the capability-presence
 * rule demands a loud failure over a silent stub. Program-defined ToolDefs and memory tools
 * cover the local story.
 */
const BUILTIN_TOOLS: ReadonlyMap<string, ExecutableTool> = new Map();

/**
 * Resolve the call's per-agent capability selection into an executable tool set. Sync by
 * design — every selection is shape-validated here so misconfiguration fails BEFORE anything
 * spawns a process or opens a connection; the async MCP step is `connectMcpServers`.
 */
export function buildToolSet(opts: AgentOptions | undefined, ctx: ToolSetContext): ToolSet {
  const mcp = validateMcpRefs(opts?.mcp);
  const tools: ExecutableTool[] = [];
  const preamble: string[] = [];

  for (const entry of opts?.tools ?? []) {
    if (typeof entry === "string") {
      tools.push(resolveBuiltinTool(entry));
    } else {
      tools.push(wrapProgramTool(entry));
    }
  }

  for (const name of opts?.skills ?? []) {
    preamble.push(loadSkill(name, ctx));
  }

  let memoryDir: string | null = null;
  if (opts?.memory !== undefined) {
    const memory = resolveMemoryDir(opts.memory, ctx);
    tools.push(...memoryTools(memory.absoluteDir, opts.memory));
    preamble.push(memoryIndex(memory.absoluteDir, opts.memory));
    memoryDir = opts.memory;
  }

  assertUniqueToolNames(tools);
  return { tools, preamble, memoryDir, mcp };
}

/** Tool names must be unique across the WHOLE advertised set — providers reject duplicates. */
export function assertUniqueToolNames(tools: readonly ExecutableTool[]): void {
  const seen = new Set<string>();
  for (const tool of tools) {
    if (seen.has(tool.name)) {
      throw new EngineError("VALIDATION", `Duplicate tool name in agent() call: "${tool.name}".`);
    }
    seen.add(tool.name);
  }
}

// ----------------------------------------------------------------------------
// Built-in names + program-defined tools
// ----------------------------------------------------------------------------

function resolveBuiltinTool(name: string): ExecutableTool {
  const builtin = BUILTIN_TOOLS.get(name);
  if (builtin === undefined) {
    throw new EngineError(
      "UNSUPPORTED",
      `Built-in tool "${name}" is not available on this engine.`,
      "This engine ships no built-in tools yet — define the tool in your program (an inline " +
        "ToolDef with an execute function) for identical behavior on every engine.",
    );
  }
  return builtin;
}

function wrapProgramTool(def: ToolDef): ExecutableTool {
  if (def.name.length === 0) {
    throw new EngineError("VALIDATION", "A program-defined tool has an empty name.");
  }
  return {
    name: def.name,
    description: def.description,
    inputSchema: def.inputSchema,
    async execute(input: Record<string, unknown>): Promise<string> {
      const result = await def.execute(input);
      if (result === undefined || result === null) return "";
      return typeof result === "string" ? result : JSON.stringify(result);
    },
  };
}

// ----------------------------------------------------------------------------
// MCP servers (inline McpServerRefs — stdio + streamable HTTP)
// ----------------------------------------------------------------------------

// Server names prefix tool names (`<server>__<tool>`) — keep them tool-name-shaped.
const MCP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

// AgentOptions comes straight from user program code — the TS types are aspirational at
// runtime, so each ref is Zod-checked before anything spawns or connects (CODE_QUALITY §2.1).
const mcpServerRefSchema = z.discriminatedUnion("transport", [
  z.strictObject({
    name: z.string().regex(MCP_NAME_RE),
    transport: z.literal("stdio"),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
  }),
  z.strictObject({
    name: z.string().regex(MCP_NAME_RE),
    transport: z.literal("http"),
    url: z
      .string()
      .min(1)
      .refine((value) => /^https?:\/\//.test(value), { error: "must be an http(s) URL" }),
    headers: z.record(z.string(), z.string()).optional(),
  }),
]);

function validateMcpRefs(refs: readonly McpServerRef[] | undefined): readonly McpServerRef[] {
  const out = refs ?? [];
  const seen = new Set<string>();
  for (const ref of out) {
    const parsed = mcpServerRefSchema.safeParse(ref);
    if (!parsed.success) {
      throw new EngineError(
        "VALIDATION",
        `agent() got a malformed MCP server ref${typeof ref.name === "string" ? ` "${ref.name}"` : ""}: ` +
          `${parsed.error.issues.map((issue) => issue.message).join("; ")}.`,
        'An MCP server is { name, transport: "stdio", command, args?, env? } or ' +
          '{ name, transport: "http", url, headers? }.',
      );
    }
    if (seen.has(ref.name)) {
      throw new EngineError(
        "VALIDATION",
        `Duplicate MCP server name in agent() call: "${ref.name}".`,
      );
    }
    seen.add(ref.name);
  }
  return out;
}

/** What the engine answered when the child asked for an MCP bearer token (see ipc.ts). */
export interface McpTokenResult {
  accessToken: string | null;
  hint?: string | undefined;
}

/** The child-side effects MCP connection needs (the OAuth broker hook + the redactor). */
export interface McpConnectIo {
  /** Broker a bearer token from the engine; `invalidateToken` names a just-rejected token. */
  mcpToken(serverUrl: string, invalidateToken?: string): Promise<McpTokenResult>;
  /** Brokered tokens are credentials — register them so they can never reach model context. */
  redactor: Redactor;
}

export interface ConnectedMcpServers {
  tools: ExecutableTool[];
  /** Tear down every connection (kill stdio children, DELETE HTTP sessions). Never throws. */
  disconnect(): Promise<void>;
}

/**
 * The async half of MCP capability assembly: connect each validated ref, list its tools, and
 * wrap them as ExecutableTools named `<server>__<tool>`. Runs in the program process (tool
 * calls execute here); OAuth token STATE stays parent-side behind `io.mcpToken`. Connection
 * or listing failure fails the call loudly — per the capability-presence rule, a server the
 * agent named must resolve. Callers must invoke `disconnect()` in a finally.
 */
export async function connectMcpServers(
  refs: readonly McpServerRef[],
  io: McpConnectIo,
): Promise<ConnectedMcpServers> {
  const connections: McpConnection[] = [];
  const tools: ExecutableTool[] = [];
  const disconnect = async (): Promise<void> => {
    for (const connection of connections) {
      try {
        await connection.close();
      } catch {
        // Teardown is best-effort: a dead server must not mask the run's real outcome.
      }
    }
  };
  try {
    for (const ref of refs) {
      const connection = new McpConnection(transportFor(ref, io), { serverName: ref.name });
      connections.push(connection);
      await connection.initialize();
      for (const tool of await connection.listTools()) {
        tools.push({
          name: `${ref.name}__${tool.name}`,
          description: tool.description,
          inputSchema: tool.inputSchema,
          execute: async (input: Record<string, unknown>): Promise<string> => {
            const result = await connection.callTool(tool.name, input);
            // isError throws so the loop's standard tool-failure path (tool_call_error event,
            // error result back to the model) handles MCP and program tools identically.
            if (result.isError) {
              throw new EngineError(
                "PROVIDER_ERROR",
                result.content.length > 0
                  ? result.content
                  : `MCP tool "${tool.name}" reported an error with no content.`,
              );
            }
            return result.content;
          },
        });
      }
    }
  } catch (err) {
    await disconnect(); // never leak spawned server processes when a later server fails
    throw err;
  }
  return { tools, disconnect };
}

function transportFor(ref: McpServerRef, io: McpConnectIo): HttpTransport | StdioTransport {
  if (ref.transport === "stdio") {
    return new StdioTransport({
      serverName: ref.name,
      command: ref.command,
      args: ref.args,
      env: ref.env,
    });
  }
  return new HttpTransport({
    serverName: ref.name,
    url: ref.url,
    headers: ref.headers,
    // Program-supplied headers are the first line of credentials; this hook only ever fires
    // after the server answered 401 (the transport owns that escalation order).
    acquireToken: async (failedToken: string | null): Promise<string> => {
      const result = await io.mcpToken(ref.url, failedToken ?? undefined);
      if (result.accessToken === null) {
        throw new EngineError(
          "PROVIDER_ERROR",
          `MCP server "${ref.name}" (${ref.url}) requires OAuth authorization and this engine ` +
            "holds no usable token.",
          result.hint ?? `Authorize once with engine.authorizeMcpServer("${ref.url}").`,
        );
      }
      io.redactor.add(`mcp:${ref.name}`, result.accessToken);
      return result.accessToken;
    },
  });
}

// ----------------------------------------------------------------------------
// Skills
// ----------------------------------------------------------------------------

function loadSkill(name: string, ctx: ToolSetContext): string {
  // Skill names become file names — keep them shape-safe before touching the filesystem.
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) {
    throw new EngineError("VALIDATION", `Skill name "${name}" is not a valid skill name.`);
  }
  const path = ctx.skillsDir === null ? null : join(ctx.skillsDir, `${name}.md`);
  if (path === null || !existsSync(path)) {
    throw new EngineError(
      "VALIDATION",
      `agent() selected skill "${name}" but no skills/${name}.md was deployed with this workflow.`,
      `Deploy the workflow with a skills/${name}.md file alongside the program.`,
    );
  }
  return `<skill name="${name}">\n${readFileSync(path, "utf8")}\n</skill>`;
}

// ----------------------------------------------------------------------------
// Memory (a persistent workspace directory + scoped file tools — not a separate system)
// ----------------------------------------------------------------------------

/** Workspace-relative, no `..`/`.`/empty segments, no leading slash. */
export const MEMORY_PATH_RE = /^(?!.*(?:^|\/)\.\.?(?:\/|$))[^/\\].*$/;

function resolveMemoryDir(memory: string, ctx: ToolSetContext): { absoluteDir: string } {
  // Per-agent memory needs NO declaration — but the path is runtime input and must be a
  // clean workspace-relative directory (the engine auto-persists exactly this path).
  if (!MEMORY_PATH_RE.test(memory) || memory.includes("\\")) {
    throw new EngineError(
      "VALIDATION",
      `agent() memory path "${memory}" must be a workspace-relative directory without "..".`,
    );
  }
  return { absoluteDir: join(ctx.workspaceDir, memory) };
}

/** Contain a model-chosen relative path inside the memory dir (untrusted input). */
function containedPath(baseDir: string, relativePath: string): string {
  const candidate = resolve(baseDir, relativePath);
  if (candidate !== baseDir && !candidate.startsWith(baseDir + sep)) {
    throw new EngineError("VALIDATION", `Memory path escapes the memory directory.`);
  }
  return candidate;
}

const memoryReadInput = z.object({ path: z.string().min(1) });
const memoryWriteInput = z.object({ path: z.string().min(1), content: z.string() });

function memoryTools(absoluteDir: string, label: string): ExecutableTool[] {
  return [
    {
      name: "memory_list",
      description: `List every file in the persistent memory directory (${label}).`,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: () => Promise.resolve(listingOf(absoluteDir) || "(memory is empty)"),
    },
    {
      name: "memory_read",
      description: `Read a file from the persistent memory directory (${label}).`,
      inputSchema: {
        type: "object",
        properties: { path: { type: "string", description: "Memory-relative file path" } },
        required: ["path"],
        additionalProperties: false,
      },
      execute: (input) => {
        const { path } = memoryReadInput.parse(input);
        const file = containedPath(absoluteDir, path);
        if (!existsSync(file)) return Promise.resolve(`(no such memory file: ${path})`);
        return Promise.resolve(readFileSync(file, "utf8"));
      },
    },
    {
      name: "memory_write",
      description:
        `Write (create or replace) a file in the persistent memory directory (${label}). ` +
        "It survives across runs.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Memory-relative file path" },
          content: { type: "string" },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
      execute: (input) => {
        const { path, content } = memoryWriteInput.parse(input);
        const file = containedPath(absoluteDir, path);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, content, "utf8");
        return Promise.resolve(`wrote ${path} (${String(content.length)} chars)`);
      },
    },
  ];
}

/** The memory context loaded at turn start: the file index plus index.md when present. */
function memoryIndex(absoluteDir: string, label: string): string {
  const listing = listingOf(absoluteDir);
  const indexPath = join(absoluteDir, "index.md");
  const index = existsSync(indexPath) ? readFileSync(indexPath, "utf8") : null;
  return [
    `<memory dir="${label}">`,
    `Files:\n${listing || "(memory is empty)"}`,
    ...(index !== null ? [`index.md:\n${index}`] : []),
    "Use memory_list / memory_read / memory_write to work with this directory; it persists across runs.",
    "</memory>",
  ].join("\n");
}

function listingOf(dir: string, prefix = ""): string {
  if (!existsSync(dir)) return "";
  const lines: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    const relative = prefix === "" ? entry : `${prefix}/${entry}`;
    if (statSync(full).isDirectory()) {
      const nested = listingOf(full, relative);
      if (nested !== "") lines.push(nested);
    } else {
      lines.push(`${relative} (${String(statSync(full).size)} bytes)`);
    }
  }
  return lines.join("\n");
}

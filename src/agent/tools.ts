// SPDX-License-Identifier: Apache-2.0

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
import type { AgentOptions, McpServerRef, ToolDef, ToolReturn } from "@boardwalk-labs/workflow";
import { loadAgentsMd } from "./agents_md.js";
import { buildEnvContext } from "./env_context.js";
import {
  listSkillFiles,
  loadSkillBody,
  loadSkillCatalogEntry,
  loadSkillResource,
} from "./skills.js";
import { EngineError } from "../errors.js";
import { McpConnection } from "../mcp/client.js";
import { HttpTransport } from "../mcp/transport_http.js";
import { StdioTransport } from "../mcp/transport_stdio.js";
import type { ToolSpec } from "./conversation.js";
import type { LspService } from "./lsp/index.js";
import type { Redactor } from "./redact.js";
import { selectBuiltins } from "./tools/registry.js";
import type { ToolHost } from "./tools/host_tools.js";

/**
 * A structured tool result: the text the MODEL sees (`llmText`, identical to the legacy plain-string
 * return), plus the rich `event` published to run OBSERVERS (the web UI). The two consumers are
 * separated so a built-in can show full output / a diff without changing what the model reads.
 */
export interface RichToolResult {
  llmText: string;
  event: ToolReturn;
}

/** What a tool's `execute` resolves to: a plain string (the model text — the loop derives a summary
 *  event), or a RichToolResult (built-ins that also publish structured data for observers). */
export type ToolExecuteResult = string | RichToolResult;

/** A sink a tool may call to stream its output as it is produced (e.g. a long `bash` command). The
 *  leaf redacts each chunk and emits a `tool_output_delta` for the live view; the final result still
 *  carries the complete bounded output. Optional — tools that don't stream simply ignore it. */
export type ToolOutputSink = (stream: "stdout" | "stderr", text: string) => void;

/** A tool the loop can actually run. `execute` resolves to model-bound text (pre-redaction), or a
 *  RichToolResult carrying that text plus a structured observer event. `onOutput`, when provided,
 *  lets the tool stream incremental output. */
export interface ExecutableTool extends ToolSpec {
  execute(input: Record<string, unknown>, onOutput?: ToolOutputSink): Promise<ToolExecuteResult>;
}

// Re-export the host-backed-tool seam so a host (the engine, or the platform's broker) can
// implement it without reaching into the tools/ subdirectory.
export type {
  ToolHost,
  WebSearchResult,
  FetchResult,
  HttpRequestInput,
  ArtifactWriteResult,
} from "./tools/host_tools.js";

export interface ToolSetContext {
  /** The run's working directory (built-in coding tools + memory dirs are workspace-relative). */
  workspaceDir: string;
  /** The deployed workflow PACKAGE root — the dir holding the program + `skills/` + a bundled
   *  AGENTS.md (the author's standing instructions). Omitted when the engine deploys no separate
   *  package dir; on engines that do, it is the parent of `skillsDir`. AGENTS.md discovery reads
   *  this tier (bundled, general) before the workspace tier (specific). */
  programDir?: string;
  /** Where this workflow's deployed skills live, or null when none were deployed. */
  skillsDir: string | null;
  /** The infrastructure backend for host-backed built-ins (webfetch/web_search/artifacts).
   *  Omitted ⇒ those tools are simply not present on this engine. */
  host?: ToolHost;
  /** The per-run, engine-native LSP service (diagnostics-after-edit + the `diagnostics` tool).
   *  Engine-native, so it is NOT a host hook; omitted ⇒ diagnostics are best-effort-skipped. */
  lspService?: LspService;
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
 * Resolve the call's per-agent capability selection into an executable tool set. Sync by
 * design — every selection is shape-validated here so misconfiguration fails BEFORE anything
 * spawns a process or opens a connection; the async MCP step is `connectMcpServers`.
 *
 * The engine's built-in coding tools are ON BY DEFAULT (read/write/edit/ls/grep/glob/bash/
 * apply_patch + the engine-native `diagnostics`/`clock`/`todo` + the host-backed webfetch/http/web_search/artifacts),
 * scoped by `opts.builtins` (default "all"). The call's inline ToolDefs are added ON TOP — an inline
 * tool may not shadow a built-in (assertUniqueToolNames catches the collision with a clear error).
 */
export function buildToolSet(opts: AgentOptions | undefined, ctx: ToolSetContext): ToolSet {
  const mcp = validateMcpRefs(opts?.mcp);
  const preamble: string[] = [];

  // Built-ins first (default-on, scoped by `builtins`), then the call's own inline tools on top.
  const tools: ExecutableTool[] = selectBuiltins(opts?.builtins, {
    workspaceDir: ctx.workspaceDir,
    host: ctx.host,
    lspService: ctx.lspService,
  });
  for (const def of opts?.tools ?? []) {
    tools.push(wrapProgramTool(def));
  }

  // Project context (AGENTS.md) is auto-discovered and prepended BEFORE skills: project rules frame
  // the task; skills are the procedure. Default-on per the convention — no AgentOptions field,
  // nothing to declare. TWO tiers: the BUNDLED package (programDir — the author's standing
  // instructions) then the run WORKSPACE (specific), concatenated general→specific, deduped when
  // the two roots are the same dir. "" when neither has an AGENTS.md (adds nothing).
  const agentsMd = loadAgentsMd(ctx.workspaceDir, ctx.programDir);
  if (agentsMd !== "") preamble.push(agentsMd);

  // Skills: author-pinned, progressively disclosed. Inject a compact CATALOG (name + description) —
  // validating every pinned skill resolves NOW (fail loud before any model call) — and add the
  // built-in `skill` tool the model calls to load a skill's full body on demand. Bundled resources
  // beside each SKILL.md are reachable with the ordinary file tools.
  const skills = opts?.skills ?? [];
  if (skills.length > 0) {
    preamble.push(buildSkillCatalog(skills, ctx.skillsDir));
    tools.push(skillTool(skills, ctx.skillsDir));
  }

  let memoryDir: string | null = null;
  if (opts?.memory !== undefined) {
    const memory = resolveMemoryDir(opts.memory, ctx);
    tools.push(...memoryTools(memory.absoluteDir, opts.memory));
    preamble.push(memoryIndex(memory.absoluteDir, opts.memory));
    memoryDir = opts.memory;
  }

  // Ambient date goes LAST (adjacent to the prompt) so the stable content above stays a cacheable
  // prefix — see env_context.ts. Captured at run start; the `clock` tool is the live source.
  preamble.push(buildEnvContext(new Date(), { hasClock: tools.some((t) => t.name === "clock") }));

  assertUniqueToolNames(tools);
  return { tools, preamble, memoryDir, mcp };
}

/**
 * Tool names must be unique across the WHOLE advertised set — providers reject duplicates. The
 * common cause is an inline ToolDef colliding with a default-on built-in (e.g. naming one "read"):
 * rename it, or set `builtins` to a set that excludes the built-in you're replacing.
 */
export function assertUniqueToolNames(tools: readonly ExecutableTool[]): void {
  const seen = new Set<string>();
  for (const tool of tools) {
    if (seen.has(tool.name)) {
      throw new EngineError(
        "VALIDATION",
        `Duplicate tool name in agent() call: "${tool.name}".`,
        `An inline tool may not shadow a built-in of the same name — rename it, or scope ` +
          `\`builtins\` so the built-in "${tool.name}" isn't included.`,
      );
    }
    seen.add(tool.name);
  }
}

// ----------------------------------------------------------------------------
// Program-defined tools
// ----------------------------------------------------------------------------

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
// runtime, so each ref is Zod-checked before anything spawns or connects.
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
// Skills (folder-per-skill, progressive disclosure — see ./skills.ts)
// ----------------------------------------------------------------------------

const skillToolInput = z.object({
  name: z.string().min(1),
  // Treat an empty `file` as omitted. Models routinely send "" for an optional string field (and the
  // tool's advertised JSON Schema puts no minimum on it), so without this `skill({ name, file: "" })`
  // throws a "too_small" validation error instead of loading the skill's body — the model's intent.
  file: z.preprocess((v) => (v === "" ? undefined : v), z.string().min(1).optional()),
});

/** The catalog block prepended to the leaf's preamble: every pinned skill's name + description, plus
 *  how to load one. Validates each pinned skill resolves NOW so a missing/misnamed skill fails before
 *  any model call (the capability-presence rule — never silently degrade). */
function buildSkillCatalog(names: readonly string[], skillsDir: string | null): string {
  const rows = names.map((name) => {
    const entry = loadSkillCatalogEntry(skillsDir, name);
    return `- ${entry.name}: ${entry.description}`;
  });
  return [
    "<skills>",
    "Skills are procedures you can load on demand. Before performing a skill's task, call the",
    "`skill` tool with its name to read its full instructions. Available skills:",
    ...rows,
    "</skills>",
  ].join("\n");
}

/** The built-in `skill` tool: loads a PINNED skill's full SKILL.md body on demand (progressive
 *  disclosure), or a bundled resource file from the skill's folder when `file` is given. The model
 *  may only reach skills the agent() call pinned — the input enum is the allowed set (belt) and
 *  execute re-checks membership (suspenders, since model input is untrusted); resource reads are
 *  path-contained to the skill folder by `loadSkillResource`. */
function skillTool(pinned: readonly string[], skillsDir: string | null): ExecutableTool {
  const allowed = new Set(pinned);
  return {
    name: "skill",
    description:
      "Load a skill's full instructions by name before performing its procedure. Pass `file` to " +
      `read one of a skill's bundled resource files instead. Available skills: ${pinned.join(", ")}.`,
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", enum: [...pinned], description: "The skill to load." },
        file: {
          type: "string",
          description: "Optional: a bundled resource file in the skill's folder to read instead.",
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
    execute: (input) => {
      const { name, file } = skillToolInput.parse(input);
      if (!allowed.has(name)) {
        throw new EngineError(
          "VALIDATION",
          `Skill "${name}" is not available to this agent. Pinned skills: ${pinned.join(", ") || "(none)"}.`,
        );
      }
      if (file !== undefined) {
        return Promise.resolve(
          `<skill-file name="${name}" file="${file}">\n${loadSkillResource(skillsDir, name, file)}\n</skill-file>`,
        );
      }
      const files = listSkillFiles(skillsDir, name);
      const footer =
        files.length > 0
          ? `\nBundled files (read with skill({ name: "${name}", file }) ): ${files.join(", ")}`
          : "";
      return Promise.resolve(
        `<skill name="${name}">\n${loadSkillBody(skillsDir, name)}\n</skill>${footer}`,
      );
    },
  };
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

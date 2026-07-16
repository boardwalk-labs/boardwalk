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
import type {
  AgentAttachment,
  AgentOptions,
  JsonSchema,
  McpServerRef,
  ToolDef,
  ToolReturn,
} from "@boardwalk-labs/workflow";
import { loadAgentsMd } from "./agents_md.js";
import { buildEnvContext, workspaceOrientation } from "./env_context.js";
import { buildToolUseGuidance } from "./tool_guidance.js";
import {
  listSkillFiles,
  loadSkillBody,
  loadSkillCatalogEntry,
  loadSkillResource,
} from "./skills.js";
import { describeValue, EngineError } from "../errors.js";
import { McpConnection, type McpCallResult } from "../mcp/client.js";
import { HttpTransport } from "../mcp/transport_http.js";
import { StdioTransport } from "../mcp/transport_stdio.js";
import type { ContentPart, ToolSpec } from "./conversation.js";
import type { LspService } from "./lsp/index.js";
import type { Redactor } from "./redact.js";
import { ALL_BUILTIN_NAMES, selectBuiltins, SUBAGENT_TOOL_NAME } from "./tools/registry.js";
import { containedPath as containedWorkspacePath } from "./tools/sandbox.js";
import type { ToolHost } from "./tools/host_tools.js";

/**
 * A structured tool result: the text the MODEL sees (`llmText`, identical to the legacy plain-string
 * return), plus the rich `event` published to run OBSERVERS (the web UI). The two consumers are
 * separated so a built-in can show full output / a diff without changing what the model reads.
 */
export interface RichToolResult {
  llmText: string;
  /** Optional structured content (text + file parts) that becomes the ToolResultMessage.content the
   *  model sees when set — lets a tool (e.g. `read` on an image, or a browser `screenshot`) feed the
   *  model a file, not just `llmText`. Omitted for text-only tools, where `llmText` IS the content. */
  content?: readonly ContentPart[];
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

/** The built-ins that touch the workspace filesystem — their presence is what makes the `<env>`
 *  workspace-orientation line worth its tokens. */
const FS_TOOL_NAMES = new Set([
  "read",
  "write",
  "edit",
  "ls",
  "grep",
  "glob",
  "apply_patch",
  "bash",
]);

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

  // `cwd` re-roots the leaf's WORKING view of the workspace: the built-in file tools (and bash's
  // starting directory) resolve + confine under it, the `<env>` orientation describes it, and the
  // workspace AGENTS.md tier is discovered from it. `memory` deliberately stays ROOT-relative — a
  // memory dir is a stable cross-run identity, not a working location (see resolveMemoryDir).
  const workspaceDir = resolveLeafWorkspaceDir(leafCwd(opts), ctx.workspaceDir);

  // Built-ins first (default-on, scoped by `builtins`), then the call's own inline tools on top.
  const tools: ExecutableTool[] = selectBuiltins(opts?.builtins, {
    workspaceDir,
    host: ctx.host,
    lspService: ctx.lspService,
  });
  for (const def of validateProgramTools(opts?.tools)) {
    tools.push(wrapProgramTool(def));
  }

  // Base tool-use conventions go FIRST — the most-general, most-stable block (a cacheable prefix),
  // ahead of AGENTS.md so the author's project rules follow and can override it. Generic tool-use
  // hygiene only (batch parallel calls, targeted edits, verify, stop when done); gated on the leaf
  // actually having tools, with per-tool lines. "" (adds nothing) for a pure-inference leaf.
  const guidance = buildToolUseGuidance(tools);
  if (guidance !== "") preamble.push(guidance);

  // Project context (AGENTS.md) is auto-discovered and prepended BEFORE skills: project rules frame
  // the task; skills are the procedure. Default-on per the convention — no AgentOptions field,
  // nothing to declare. TWO tiers: the BUNDLED package (programDir — the author's standing
  // instructions) then the run WORKSPACE (specific), concatenated general→specific, deduped when
  // the two roots are the same dir. "" when neither has an AGENTS.md (adds nothing).
  const agentsMd = loadAgentsMd(workspaceDir, ctx.programDir);
  if (agentsMd !== "") preamble.push(agentsMd);

  // Skills: author-pinned, progressively disclosed. Inject a compact CATALOG (name + description) —
  // validating every pinned skill resolves NOW (fail loud before any model call) — and add the
  // built-in `skill` tool the model calls to load a skill's full body on demand. Bundled resources
  // beside each SKILL.md are reachable with the ordinary file tools.
  const skills = validateSkills(opts?.skills);
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

  // Ambient env (date + workspace orientation) goes LAST (adjacent to the prompt) so the stable
  // content above stays a cacheable prefix — see env_context.ts. Captured at run start; the `clock`
  // tool and `ls` are the live sources. The workspace line appears only when the leaf actually has
  // a filesystem-touching tool — a pure-inference or inline-tools-only leaf never needs it.
  const hasFsTools = tools.some((t) => FS_TOOL_NAMES.has(t.name));
  preamble.push(
    buildEnvContext(new Date(), {
      hasClock: tools.some((t) => t.name === "clock"),
      workspace: hasFsTools ? workspaceOrientation(workspaceDir) : null,
    }),
  );

  assertUniqueToolNames(tools);
  return { tools, preamble, memoryDir, mcp };
}

/**
 * Extract the call's `cwd` (SDK ≥ 0.1.29): the workspace-relative directory the leaf works from.
 * Runtime-validated despite the typed field because AgentOptions comes straight from user program
 * code (the TS types are aspirational at runtime — same rule as the MCP refs above). Empty string
 * ⇒ omitted (the LLM/author-empty-string case), matching the skill tool's treatment of optional
 * strings.
 */
export function leafCwd(opts: AgentOptions | undefined): string | undefined {
  const raw: unknown = opts?.cwd;
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string") {
    throw new EngineError(
      "VALIDATION",
      "agent() `cwd` must be a string naming a workspace-relative directory.",
    );
  }
  return raw;
}

/**
 * Resolve a leaf's `cwd` against the run workspace root: contained (an escaping path fails loudly,
 * never a silent clamp) and EXISTING as a directory — per the capability-presence rule, a location
 * the call named must resolve before any model call, never silently degrade to the root.
 */
function resolveLeafWorkspaceDir(cwd: string | undefined, rootDir: string): string {
  if (cwd === undefined) return rootDir;
  const abs = containedWorkspacePath(rootDir, cwd);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) {
    throw new EngineError(
      "VALIDATION",
      `agent() cwd "${cwd}" is not an existing directory in the workspace.`,
      "cwd must name an existing workspace-relative directory — create it first (e.g. clone or " +
        "mkdir in program code), or omit it to work from the workspace root.",
    );
  }
  return abs;
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
// Shape validation (AgentOptions is untrusted runtime input)
// ----------------------------------------------------------------------------

// Every AgentOptions field is UNTRUSTED RUNTIME INPUT, despite being typed. Author programs reach
// an engine WITHOUT ever being type-checked: the control plane's deploy gate is syntax-only by
// design, and the CLI bundles with esbuild, which strips types without checking them. So a
// type-invalid program (`tools: ["bash"]` — a TS error) deploys clean and arrives here intact.
// The TS types are author-side ergonomics, not a runtime guarantee: shape-check a field BEFORE
// dereferencing it, and make the message name the actual mistake — the author has no type error
// to read, only what this throws.

/** Whether a string names a built-in — i.e. the author reached for the wrong field, not a typo. */
function isBuiltinName(value: unknown): value is string {
  return (
    typeof value === "string" && (ALL_BUILTIN_NAMES.includes(value) || value === SUBAGENT_TOOL_NAME)
  );
}

const TOOL_DEF_HINT =
  "An inline tool is an object: { name, description, inputSchema, execute }. Built-in tools are " +
  "on by default and are scoped with `builtins`, not `tools`.";

/**
 * The fix pointer for a bad `tools` entry. A string naming a built-in gets special-cased on
 * purpose: `tools: ["bash"]` is the mistake authors actually make (built-ins USED to be named
 * there), so say exactly what to type instead of describing the ToolDef shape at them.
 */
function toolsHint(value: unknown): string {
  if (!isBuiltinName(value)) return TOOL_DEF_HINT;
  return (
    `Built-in tools are ON by default — "${value}" needs no declaration at all. To restrict this ` +
    `leaf to a subset of built-ins, write \`builtins: ["${value}"]\`; \`tools\` is only for tools ` +
    `you define inline.`
  );
}

// A JSON Schema / a function, validated by predicate and passed through BY REFERENCE — z.custom
// never reshapes its input, so a tool's `execute` stays the same closure and its `inputSchema`
// reaches the provider byte-identical to what the program wrote.
const jsonSchemaValue = z.custom<JsonSchema>(
  (v) => typeof v === "object" && v !== null && !Array.isArray(v),
  { error: "must be a JSON Schema object" },
);

const toolDefSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  inputSchema: jsonSchemaValue,
  execute: z.custom<ToolDef["execute"]>((v) => typeof v === "function", {
    error: "must be a function",
  }),
});

// An attachment carries bytes ONE of two ways — inline base64 (`data`) or a `url` the provider
// fetches — so exactly one must be present. Getting this wrong is not merely a bad message: a
// malformed attachment used to reach the provider and fail there, and the leaf RETRIED the failing
// request 5 times before surfacing an internal TypeError. Wrong shape must cost zero model calls.
const attachmentSchema = z
  .object({
    mimeType: z.string().min(1),
    data: z.string().optional(),
    url: z.string().min(1).optional(),
    filename: z.string().optional(),
  })
  .refine((a) => (a.data === undefined) !== (a.url === undefined), {
    error: "must set exactly one of `data` (inline base64) or `url`",
  });

/**
 * The call's attachments (images/documents prepended to the first user message). Validated for the
 * same reason as everything else here — the TS type is not a runtime guarantee — and validated
 * EARLY, before any MCP server spawns or any model call is billed.
 */
export function validateAttachments(
  attachments: AgentOptions["attachments"],
): readonly AgentAttachment[] {
  if (attachments === undefined || attachments === null) return [];
  if (!Array.isArray(attachments)) {
    throw new EngineError(
      "VALIDATION",
      `agent() \`attachments\` must be an array — got ${describeValue(attachments)}.`,
      ATTACHMENT_HINT,
    );
  }
  const out: readonly AgentAttachment[] = attachments;
  for (const attachment of out) {
    const parsed = attachmentSchema.safeParse(attachment);
    if (!parsed.success) {
      throw new EngineError(
        "VALIDATION",
        `agent() got a malformed attachment — ${issueText(parsed.error)}.`,
        ATTACHMENT_HINT,
      );
    }
  }
  return out;
}

const ATTACHMENT_HINT =
  "An attachment is { mimeType, data } (inline base64) or { mimeType, url } (a data: URI or an " +
  "https: URL the provider fetches), plus an optional `filename`. Pass text/source as prompt text, " +
  "not as an attachment.";

/** Flatten Zod issues into one line: `name: expected string, received number`. */
function issueText(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join(".");
      return path === "" ? issue.message : `${path}: ${issue.message}`;
    })
    .join("; ");
}

// ----------------------------------------------------------------------------
// Program-defined tools
// ----------------------------------------------------------------------------

/** The call's inline ToolDefs. `tools` is ONLY for tools the program defines itself. */
function validateProgramTools(tools: AgentOptions["tools"]): readonly unknown[] {
  if (tools === undefined || tools === null) return [];
  if (!Array.isArray(tools)) {
    throw new EngineError(
      "VALIDATION",
      `agent() \`tools\` must be an array of inline tool definitions — got ${describeValue(tools)}.`,
      toolsHint(tools),
    );
  }
  return tools;
}

function wrapProgramTool(def: unknown): ExecutableTool {
  // Shape-check BEFORE dereferencing. This guard may not assume `def` is even an object: it used to
  // open with `def.name.length === 0`, so `tools: ["bash"]` crashed the guard itself with a bare
  // "Cannot read properties of undefined (reading 'length')" rather than being caught by it.
  if (typeof def !== "object" || def === null) {
    throw new EngineError(
      "VALIDATION",
      `agent() got ${describeValue(def)} in \`tools\`, which takes inline tool definitions, not names.`,
      toolsHint(def),
    );
  }
  const parsed = toolDefSchema.safeParse(def);
  if (!parsed.success) {
    throw new EngineError(
      "VALIDATION",
      `agent() got a malformed inline tool in \`tools\` — ${issueText(parsed.error)}.`,
      TOOL_DEF_HINT,
    );
  }
  const tool = parsed.data;
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    async execute(input: Record<string, unknown>): Promise<string> {
      const result = await tool.execute(input);
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

const MCP_REF_HINT =
  'An MCP server is { name, transport: "stdio", command, args?, env? } or ' +
  '{ name, transport: "http", url, headers? }.';

// AgentOptions comes straight from user program code — the TS types are aspirational at
// runtime, so each ref is Zod-checked before anything spawns or connects.
const mcpServerRefSchema = z.discriminatedUnion("transport", [
  z.strictObject({
    name: z.string().regex(MCP_NAME_RE),
    transport: z.literal("stdio"),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    excludeTools: z.array(z.string()).optional(),
  }),
  z.strictObject({
    name: z.string().regex(MCP_NAME_RE),
    transport: z.literal("http"),
    url: z
      .string()
      .min(1)
      .refine((value) => /^https?:\/\//.test(value), { error: "must be an http(s) URL" }),
    headers: z.record(z.string(), z.string()).optional(),
    excludeTools: z.array(z.string()).optional(),
  }),
]);

function validateMcpRefs(refs: readonly McpServerRef[] | undefined): readonly McpServerRef[] {
  if (refs === undefined || refs === null) return [];
  if (!Array.isArray(refs)) {
    throw new EngineError(
      "VALIDATION",
      `agent() \`mcp\` must be an array of MCP server refs — got ${describeValue(refs)}.`,
      MCP_REF_HINT,
    );
  }
  const out: readonly McpServerRef[] = refs;
  const seen = new Set<string>();
  for (const ref of out) {
    const parsed = mcpServerRefSchema.safeParse(ref);
    if (!parsed.success) {
      // `ref` is untrusted: read its name only once it is known to be an object, or naming the bad
      // ref in the message would itself throw (`mcp: [null]` → "cannot read properties of null").
      const named =
        typeof ref === "object" && ref !== null && typeof ref.name === "string"
          ? ` "${ref.name}"`
          : "";
      throw new EngineError(
        "VALIDATION",
        `agent() got a malformed MCP server ref${named}: ${issueText(parsed.error)}.`,
        MCP_REF_HINT,
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
      // Tools the ref hides from the agent (e.g. a browser session's arbitrary-JS tools). They are
      // still callable by the trusted program via its own client — this only prunes the model's set.
      const excluded = new Set(ref.excludeTools ?? []);
      for (const tool of await connection.listTools()) {
        if (excluded.has(tool.name)) continue;
        tools.push({
          name: `${ref.name}__${tool.name}`,
          description: tool.description,
          inputSchema: tool.inputSchema,
          execute: async (input: Record<string, unknown>): Promise<ToolExecuteResult> =>
            mcpResultToToolResult(
              `${ref.name}__${tool.name}`,
              await connection.callTool(tool.name, input),
            ),
        });
      }
    }
  } catch (err) {
    await disconnect(); // never leak spawned server processes when a later server fails
    throw err;
  }
  return { tools, disconnect };
}

/** The model-bound text of an MCP result: the string as-is, or the joined text parts when the result
 *  carries file content (image blocks travel as file parts, not text). */
function mcpResultText(content: string | readonly ContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

/**
 * An MCP tools/call outcome → a leaf tool result. A text-only result stays a plain string (the loop
 * derives its own summary event); a result carrying file parts (e.g. a vision tool's image) becomes a
 * RichToolResult so the parts flow to the model via the tool_result content seam (leaf.ts). The
 * server's `isError` flag throws, so the loop's standard tool-failure path (tool_call_error event,
 * error result back to the model) handles MCP and program tools identically.
 */
export function mcpResultToToolResult(
  qualifiedName: string,
  result: McpCallResult,
): ToolExecuteResult {
  if (result.isError) {
    const errText = mcpResultText(result.content);
    throw new EngineError(
      "PROVIDER_ERROR",
      errText.length > 0
        ? errText
        : `MCP tool "${qualifiedName}" reported an error with no content.`,
    );
  }
  if (typeof result.content === "string") return result.content;
  const text = mcpResultText(result.content);
  return {
    llmText: text.length > 0 ? text : `[${qualifiedName} returned a file]`,
    content: result.content,
    event: { kind: "mcp_tool_result", humanSummary: qualifiedName },
  };
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

const skillsSchema = z.array(z.string().min(1));

/**
 * The call's pinned skill names. Shape-checked because a wrong shape here used to DEGRADE SILENTLY
 * rather than fail: `skills: {}` has no `.length`, so `length > 0` was false and every pinned skill
 * was dropped — the leaf ran on with no skills and no complaint, which is exactly what the
 * capability-presence rule forbids.
 */
function validateSkills(skills: AgentOptions["skills"]): readonly string[] {
  if (skills === undefined || skills === null) return [];
  const parsed = skillsSchema.safeParse(skills);
  if (!parsed.success) {
    throw new EngineError(
      "VALIDATION",
      `agent() \`skills\` must be an array of skill names — got ${describeValue(skills)}.`,
      'Pin skills by name: `skills: ["code-review"]`, each resolved from `skills/<name>/SKILL.md` ' +
        "in the package deployed with the program.",
    );
  }
  return parsed.data;
}

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
  // Deliberately resolved against the workspace ROOT even when the leaf sets `cwd`: a memory dir
  // is a stable cross-run identity — re-rooting it would silently "lose" memories whenever a
  // checkout directory is renamed, and agents sharing one memory across different cwds would break.
  // Type first: MEMORY_PATH_RE.test() would COERCE a non-string (`memory: 123` tests as "123" and
  // passes), so without this the crash landed on `.includes` a line later.
  if (typeof memory !== "string") {
    throw new EngineError(
      "VALIDATION",
      `agent() \`memory\` must be a string naming a workspace-relative directory — got ${describeValue(memory)}.`,
      'Name a directory the engine persists across runs, e.g. `memory: "notes"`.',
    );
  }
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

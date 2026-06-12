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
import type { AgentOptions, ToolDef } from "@boardwalk/workflow";
import { EngineError } from "../errors.js";
import type { ToolSpec } from "./conversation.js";

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
}

/**
 * Built-in tools this engine implements, selected by name. Deliberately empty in v0: the
 * hosted platform's curated built-ins don't exist locally yet, and the capability-presence
 * rule demands a loud failure over a silent stub. Program-defined ToolDefs and memory tools
 * cover the local story.
 */
const BUILTIN_TOOLS: ReadonlyMap<string, ExecutableTool> = new Map();

/** Resolve the call's per-agent capability selection into an executable tool set. */
export function buildToolSet(opts: AgentOptions | undefined, ctx: ToolSetContext): ToolSet {
  if (opts?.mcp !== undefined && opts.mcp.length > 0) {
    throw new EngineError(
      "UNSUPPORTED",
      "agent() MCP server connections are not implemented in this engine build yet.",
      "Tools, skills, and memory work today; MCP is next on the engine roadmap.",
    );
  }

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

  const seen = new Set<string>();
  for (const tool of tools) {
    if (seen.has(tool.name)) {
      throw new EngineError("VALIDATION", `Duplicate tool name in agent() call: "${tool.name}".`);
    }
    seen.add(tool.name);
  }
  return { tools, preamble, memoryDir };
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

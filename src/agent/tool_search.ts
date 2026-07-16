// SPDX-License-Identifier: Apache-2.0

// Progressive tool disclosure ("tool search") — keep a leaf's STANDING tool schemas small when it
// carries many tools. Instead of advertising every tool's full JSON Schema on every turn, the model
// sees a compact CATALOG (name + one-line description) of the deferrable tools plus a `find_tools`
// tool; it searches by keyword to load the full definitions of the few it needs, which then join the
// advertised set for the rest of the run. Mirrors the `skill` progressive-disclosure pattern
// (skills.ts): small standing context, the detail one tool call away.
//
// What is deferred: MCP server tools ONLY. They are the real source of schema bloat (a single GitHub
// or Slack server can bring dozens of tools and tens of thousands of tokens of definitions), they are
// lower-frequency than the core coding built-ins, and they arrive as one clearly-identifiable group
// (connectMcpServers). The core built-ins (read/edit/bash/grep/...) and the call's own inline tools
// are always advertised — small, high-frequency, and few.
//
// Deferral is AUTOMATIC and SIZE-GATED (no AgentOptions field, no SDK change): it engages only when
// the MCP tool set is genuinely large (see the thresholds), so a normal leaf — built-ins plus maybe a
// couple of MCP tools — is completely unchanged, standing context and cache prefix identical.
//
// Safety net: deferral withholds only the SCHEMA from context. A deferred tool still EXECUTES if the
// model calls it before searching, because the loop looks up tool execution against the FULL set (see
// leaf.ts runToolLoop: it advertises `advertisedTools(...)` but executes against `tools`). find_tools
// reveals the schema so the model can form correct arguments; a direct call without it still runs,
// just without the model having seen the parameter shape.

import type { ExecutableTool } from "./tools.js";

/** The reserved name of the search tool injected when deferral engages. */
export const FIND_TOOLS_NAME = "find_tools";

// Heuristic thresholds. Both must hold for deferral to engage, so it only fires on a genuinely large
// MCP tool set (many tools AND substantial combined schema) — never on a couple of small ones, where
// the find_tools round-trip would cost more than the schemas it hides. Deliberately conservative;
// tune against the measured leaf tool-count distribution (see docs/AGENT_EFFICIENCY.md P7/P5).
export const TOOL_DEFER_MIN_COUNT = 5;
export const TOOL_DEFER_MIN_CHARS = 16_000;

/** Cap on how many tool definitions one find_tools call returns — a broad/empty query on a huge set
 *  must not dump the whole catalog back into context (which would defeat the point). */
const MAX_MATCH_RESULTS = 12;

/**
 * The state a deferral engagement threads through the loop: which tool names are deferred (withheld
 * from advertising until activated), the SHARED mutable set of names activated so far (find_tools
 * mutates it; the loop reads it each turn), the catalog block for the preamble, and the find_tools
 * tool to add to the executable set.
 */
export interface ToolDisclosure {
  deferredNames: ReadonlySet<string>;
  /** Mutated by find_tools, read by the loop's advertisedTools — one shared Set. */
  activated: Set<string>;
  catalog: string;
  findTool: ExecutableTool;
}

/** The serialized size (chars) a tool's definition contributes to the advertised set. */
function toolSchemaChars(tool: ExecutableTool): number {
  return tool.name.length + tool.description.length + JSON.stringify(tool.inputSchema).length;
}

/**
 * Decide whether to defer the given MCP tools behind progressive disclosure. Returns `null` (advertise
 * everything, the unchanged path) unless the set clears BOTH thresholds. Also returns `null` — never
 * deferring — when the reserved `find_tools` name already exists anywhere in the leaf's tool set: an
 * inline/MCP tool named `find_tools` would collide, and silently disabling deferral is safer than
 * failing an author's leaf over an automatic optimization they never asked for.
 */
export function planToolDisclosure(args: {
  deferrable: readonly ExecutableTool[];
  allToolNames: ReadonlySet<string>;
}): ToolDisclosure | null {
  const { deferrable, allToolNames } = args;
  if (allToolNames.has(FIND_TOOLS_NAME)) return null;
  if (deferrable.length < TOOL_DEFER_MIN_COUNT) return null;
  const chars = deferrable.reduce((sum, t) => sum + toolSchemaChars(t), 0);
  if (chars < TOOL_DEFER_MIN_CHARS) return null;

  const deferredNames = new Set(deferrable.map((t) => t.name));
  const activated = new Set<string>();
  return {
    deferredNames,
    activated,
    catalog: buildToolCatalog(deferrable),
    findTool: findToolsTool(deferrable, activated),
  };
}

/** The advertised subset for a turn: everything except deferred-and-not-yet-activated tools. With no
 *  disclosure it is the full set (identity) — the unchanged path. Kept here beside the deferral logic
 *  so the loop's per-turn line reads as one call. */
export function advertisedTools(
  tools: readonly ExecutableTool[],
  disclosure: ToolDisclosure | undefined,
): readonly ExecutableTool[] {
  if (disclosure === undefined) return tools;
  return tools.filter(
    (t) => !disclosure.deferredNames.has(t.name) || disclosure.activated.has(t.name),
  );
}

/** The catalog block prepended to the leaf's preamble: every deferred tool's name + one-line
 *  description, and how to load one. Small and stable for the whole run (a cacheable prefix). */
function buildToolCatalog(deferrable: readonly ExecutableTool[]): string {
  const rows = deferrable.map((t) => `- ${t.name}: ${firstLine(t.description)}`);
  return [
    "<tools>",
    "These tools are available but their full definitions are not loaded, to keep context small.",
    `Call \`${FIND_TOOLS_NAME}\` with a keyword to load the ones you need before using them; once`,
    "loaded, call them like any other tool. Available tools:",
    ...rows,
    "</tools>",
  ].join("\n");
}

/**
 * The built-in `find_tools` tool: searches the deferred tools by keyword and loads (activates) the
 * matches so they are advertised on the following turns. Matching is a case-insensitive substring on
 * name + description; an empty/omitted query returns everything (capped). Every returned tool is
 * activated — the model asked to see it, so make it callable. Returns each match's name, description,
 * and input schema so the model can form correct arguments.
 */
function findToolsTool(
  deferrable: readonly ExecutableTool[],
  activated: Set<string>,
): ExecutableTool {
  return {
    name: FIND_TOOLS_NAME,
    description:
      "Search the tools listed in <tools> and load the ones you need. Pass a keyword `query` " +
      "(matched against tool names and descriptions); omit it to list them all. Loaded tools become " +
      "callable on your next turn.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Keyword to match against tool names and descriptions. Omit to list all.",
        },
      },
      additionalProperties: false,
    },
    execute: (input) => {
      const query = typeof input.query === "string" ? input.query.trim().toLowerCase() : "";
      const matches = deferrable.filter(
        (t) =>
          query === "" ||
          t.name.toLowerCase().includes(query) ||
          t.description.toLowerCase().includes(query),
      );
      if (matches.length === 0) {
        return Promise.resolve(
          `No tools matched "${query}". Available: ${deferrable.map((t) => t.name).join(", ")}.`,
        );
      }
      const shown = matches.slice(0, MAX_MATCH_RESULTS);
      for (const t of shown) activated.add(t.name);
      const blocks = shown.map((t) =>
        [`## ${t.name}`, t.description, `input schema: ${JSON.stringify(t.inputSchema)}`].join(
          "\n",
        ),
      );
      const footer =
        matches.length > shown.length
          ? `\n\n(${String(matches.length - shown.length)} more match "${query}" — search with a ` +
            "narrower keyword to load them.)"
          : "";
      return Promise.resolve(
        `Loaded ${String(shown.length)} tool(s); they are now callable:\n\n${blocks.join("\n\n")}${footer}`,
      );
    },
  };
}

/** First non-empty line of a (possibly multi-line) tool description, for the compact catalog row. */
function firstLine(description: string): string {
  for (const line of description.split("\n")) {
    const trimmed = line.trim();
    if (trimmed !== "") return trimmed;
  }
  return "";
}

// SPDX-License-Identifier: Apache-2.0

// The built-in coding toolset registry + the `builtins` selection logic.
//
// Built-ins are ON BY DEFAULT (SDK AgentOptions.builtins defaults to "all"): a plain agent(prompt)
// can already read, edit, search, and run commands in the run's workspace. `builtins` SCOPES that
// set:
//   - "all"        → every built-in this engine provides (sandbox tools, the engine-native
//                    `diagnostics`, and whichever host-backed tools have a backend).
//   - "read-only"  → the non-mutating set: read, ls, grep, glob, diagnostics, webfetch, web_search.
//   - "none"       → no built-ins; the leaf has only its inline ToolDefs.
//   - string[]     → exactly those built-in names; an UNKNOWN name fails loudly (UNSUPPORTED),
//                    because an explicit selection naming a tool the engine doesn't have is a bug
//                    in the workflow, not something to silently drop.
//
// The default-on "all"/"read-only"/"none" paths intentionally do NOT error on a backend-gated tool
// whose backend is absent — they just don't include it (the engine advertises what it can run). The
// engine-native `diagnostics` is present whenever the run has an LspService (always, in practice);
// it then degrades per-file when no language server is installed. Only an EXPLICIT name list fails
// on an unknown name.

import type { AgentOptions } from "@boardwalk-labs/workflow";
import { EngineError } from "../../errors.js";
import type { LspService } from "../lsp/index.js";
import type { ExecutableTool } from "../tools.js";
import { applyPatchTool } from "./apply_patch.js";
import { bashTool } from "./bash.js";
import { diagnosticsTool } from "./diagnostics.js";
import { editTool, globTool, grepTool, lsTool, readTool, writeTool } from "./fs_tools.js";
import { hostBackedTools, HOST_BACKED_TOOL_NAMES, type ToolHost } from "./host_tools.js";

/** The non-mutating built-ins (the `"read-only"` set): no write/edit/apply_patch/bash/artifacts. */
export const READ_ONLY_BUILTIN_NAMES: readonly string[] = [
  "read",
  "ls",
  "grep",
  "glob",
  "diagnostics",
  "webfetch",
  "web_search",
];

/**
 * The `subagent` tool's name. It is NOT a registry built-in: it needs `io.forkLeaf` and the
 * parent's resolved tool set, so the LEAF layer assembles it (see agent/tools/subagent.ts), and
 * the registry only recognizes the name. Kept out of ALL_BUILTIN_NAMES on purpose — that list is
 * "names selectBuiltins/registry produces", and a test pins selectBuiltins("all") to it exactly.
 */
export const SUBAGENT_TOOL_NAME = "subagent";

/** Every built-in name this engine knows (sandbox + engine-native + host-backed), independent of backend presence. */
export const ALL_BUILTIN_NAMES: readonly string[] = [
  "read",
  "write",
  "edit",
  "ls",
  "grep",
  "glob",
  "bash",
  "apply_patch",
  "diagnostics",
  ...HOST_BACKED_TOOL_NAMES,
];

export interface BuiltinContext {
  workspaceDir: string;
  host: ToolHost | undefined;
  /** The per-run engine-native LSP service backing the `diagnostics` built-in. */
  lspService: LspService | undefined;
}

/**
 * Build the full registry of built-ins available on THIS engine for this run: the sandbox tools
 * (always) plus the host-backed tools whose backend the host supplies. Keyed by name.
 */
function registry(ctx: BuiltinContext): Map<string, ExecutableTool> {
  const tools = new Map<string, ExecutableTool>();
  // The write/edit tools append diagnostics after a successful write when a language server is
  // available — best-effort, so a missing LspService just leaves them as plain file writes.
  const lsp = ctx.lspService;
  for (const tool of [
    readTool(ctx.workspaceDir),
    writeTool(ctx.workspaceDir, lsp),
    editTool(ctx.workspaceDir, lsp),
    lsTool(ctx.workspaceDir),
    grepTool(ctx.workspaceDir),
    globTool(ctx.workspaceDir),
    bashTool({ workspaceDir: ctx.workspaceDir }),
    applyPatchTool(ctx.workspaceDir),
  ]) {
    tools.set(tool.name, tool);
  }
  // The engine-native `diagnostics` tool is present whenever the run wired an LspService (it then
  // degrades per-file when no language server is installed — best-effort, never an error).
  if (lsp !== undefined) {
    tools.set("diagnostics", diagnosticsTool(ctx.workspaceDir, lsp));
  }
  for (const [name, tool] of hostBackedTools(ctx.host)) {
    tools.set(name, tool);
  }
  return tools;
}

/**
 * Select the built-in tools for a call from `opts.builtins` (default "all"). Returns the chosen
 * ExecutableTools; the caller adds inline ToolDefs on top and asserts name uniqueness.
 */
export function selectBuiltins(
  builtins: AgentOptions["builtins"],
  ctx: BuiltinContext,
): ExecutableTool[] {
  const available = registry(ctx);
  const selection = builtins ?? "all";

  if (selection === "none") return [];

  if (selection === "all") {
    return [...available.values()];
  }

  if (selection === "read-only") {
    // The read-only NAMES are fixed; include only the ones actually present (a host-backed
    // read-only tool with no backend is simply omitted, like in "all").
    return READ_ONLY_BUILTIN_NAMES.flatMap((name) => {
      const tool = available.get(name);
      return tool !== undefined ? [tool] : [];
    });
  }

  // An explicit name list: every name must resolve to a built-in the engine can run, else fail loud.
  const selected: ExecutableTool[] = [];
  for (const name of selection) {
    // `subagent` is a leaf-layer tool (it needs io.forkLeaf + the resolved parent tool set), not a
    // registry built-in — recognize the name here, but let the leaf layer assemble it (see
    // subagentSelected + agent/tools/subagent.ts). Skipping keeps it valid in an explicit list.
    if (name === SUBAGENT_TOOL_NAME) continue;
    const tool = available.get(name);
    if (tool === undefined) {
      throw new EngineError(
        "UNSUPPORTED",
        `Built-in tool "${name}" is not available on this engine.`,
        knownHint(name),
      );
    }
    selected.push(tool);
  }
  return selected;
}

/**
 * Whether the `subagent` tool is enabled for this call. Default-ON with `"all"` (a plain
 * `agent(prompt)` can delegate); never with `"none"`/`"read-only"` (a read-only agent gets no
 * spawn power); with an explicit list, only when `"subagent"` is named. The tool itself is built
 * by the leaf layer (it needs `io.forkLeaf` + the resolved parent tool set), so this only decides
 * inclusion — and the leaf layer additionally requires `io.forkLeaf` to be present.
 */
export function subagentSelected(builtins: AgentOptions["builtins"]): boolean {
  const selection = builtins ?? "all";
  if (selection === "all") return true;
  if (selection === "none" || selection === "read-only") return false;
  return selection.includes(SUBAGENT_TOOL_NAME);
}

/** A pointer at the fix: name a real built-in, or define it inline as a ToolDef. */
function knownHint(name: string): string {
  if (HOST_BACKED_TOOL_NAMES.includes(name)) {
    return `"${name}" is a host-backed built-in; this engine has no backend configured for it.`;
  }
  return `Known built-ins: ${ALL_BUILTIN_NAMES.join(", ")}. Or define "${name}" inline as a ToolDef.`;
}

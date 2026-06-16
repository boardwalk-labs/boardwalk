// SPDX-License-Identifier: Apache-2.0

// The `subagent` tool: from inside one agent() leaf, run another agent() leaf as a tool call.
//
// It is just another tool — the loop dispatches a turn's tool calls concurrently (Promise.all in
// leaf.ts), so a model that wants N sub-agents simply calls `subagent` N times in one turn and they
// run in parallel, each via its own forked LeafIo (fresh run-unique identity, the SAME model/usage/
// event/redaction sinks). Capability attenuation is the safety model: a sub-agent may be granted AT
// MOST the tools the parent has (default: all of them), and never the `subagent` tool itself — so
// delegation is exactly one level deep and can't escalate. The run budget is the cost backstop.
//
// This module is import-cycle-free: the leaf runner (runAgentLeaf) and the io-fork are injected as
// deps; the only edges back to the leaf are type-only (erased at runtime).

import { z } from "zod";
import type { AgentOptions, ToolDef } from "@boardwalk-labs/workflow";
import { EngineError } from "../../errors.js";
import type { LeafIo } from "../leaf.js";
import type { ExecutableTool } from "../tools.js";
import { ALL_BUILTIN_NAMES, SUBAGENT_TOOL_NAME } from "./registry.js";

export interface SubagentToolDeps {
  /** The parent leaf's RESOLVED tools — the subset ceiling (matched by name). */
  parentTools: readonly ExecutableTool[];
  /** The parent's inline ToolDefs, forwarded to a child by reference when it requests them. */
  parentInlineTools: readonly ToolDef[];
  /** Defaults inherited when the call names no model/provider. */
  parentModel: string | undefined;
  parentProvider: string | undefined;
  /** Derive the child's leaf io: fresh identity, shared sinks (io.forkLeaf, known present). */
  forkLeaf: (opts: { name?: string }) => LeafIo;
  /** The leaf runner (runAgentLeaf) — injected to avoid an import cycle with leaf.ts. */
  run: (prompt: string, opts: AgentOptions | undefined, io: LeafIo) => Promise<unknown>;
}

const subagentInput = z.object({
  prompt: z.string().min(1),
  name: z.string().min(1).max(120).optional(),
  model: z.string().min(1).optional(),
  provider: z.string().min(1).optional(),
  tools: z.array(z.string()).optional(),
  memory: z.string().min(1).optional(),
});

const BUILTIN_NAME_SET: ReadonlySet<string> = new Set(ALL_BUILTIN_NAMES);

/**
 * Build the `subagent` tool for one parent leaf. Constructed by the leaf layer (runAgentLeaf) once
 * the parent's tool set is resolved, so the subset ceiling is exactly what the parent can do.
 */
export function makeSubagentTool(deps: SubagentToolDeps): ExecutableTool {
  // The grantable set: the parent's built-in tools + the parent's inline tools, by name. Memory and
  // MCP tools are deliberately NOT inheritable by name in v1 (memory is per-dir, MCP per-server) —
  // a child gets its own memory via the `memory` field. `subagent` itself is never in this set.
  const inlineByName = new Map<string, ToolDef>(deps.parentInlineTools.map((d) => [d.name, d]));
  const grantable = new Set<string>([
    ...deps.parentTools.map((t) => t.name).filter((n) => BUILTIN_NAME_SET.has(n)),
    ...inlineByName.keys(),
  ]);
  grantable.delete(SUBAGENT_TOOL_NAME);

  return {
    name: SUBAGENT_TOOL_NAME,
    description:
      "Run a sub-agent: a fresh agent loop with its own prompt and tools that runs to completion " +
      "and returns its final text. It executes like any other tool call — call `subagent` several " +
      "times in one turn to run sub-agents in parallel. A sub-agent can be granted at most the " +
      "tools you have (default: all of them); it cannot spawn its own sub-agents.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The sub-agent's task / instructions." },
        name: {
          type: "string",
          description: "Optional display name for the sub-agent (shown in the run's live view).",
        },
        model: {
          type: "string",
          description: "Optional model override; defaults to this agent's model.",
        },
        provider: {
          type: "string",
          description: "Optional provider override; defaults to this agent's provider.",
        },
        tools: {
          type: "array",
          items: { type: "string" },
          description:
            "Tool names to grant the sub-agent — must be a subset of YOUR tools. Omit to grant " +
            "all of them. A sub-agent can never spawn its own sub-agents.",
        },
        memory: {
          type: "string",
          description:
            "Optional workspace-relative directory for the sub-agent's persistent memory.",
        },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
    async execute(rawInput: Record<string, unknown>): Promise<string> {
      const input = subagentInput.parse(rawInput);

      const requested = input.tools ?? [...grantable];
      const denied = requested.filter((n) => !grantable.has(n));
      if (denied.length > 0) {
        // The model asked for capabilities this agent can't grant — its mistake to recover from,
        // not a run failure. executeToolCall turns this into an error result back to the model.
        throw new EngineError(
          "VALIDATION",
          `subagent requested tools this agent can't grant: ${denied.join(", ")}.`,
          grantable.size > 0
            ? `Grantable tools: ${[...grantable].join(", ")}.`
            : "This agent has no tools it can grant a sub-agent.",
        );
      }

      // Split the granted subset into built-in names (→ child's `builtins`, an explicit array that
      // never contains `subagent`, so the child is one level deep) and inline ToolDefs (forwarded
      // by reference). Names are disjoint — an inline tool may not shadow a built-in.
      const childBuiltins = requested.filter((n) => BUILTIN_NAME_SET.has(n));
      const childInline = deps.parentInlineTools.filter((d) => requested.includes(d.name));

      const model = input.model ?? deps.parentModel;
      const provider = input.provider ?? deps.parentProvider;
      const childOpts: AgentOptions = {
        builtins: childBuiltins,
        ...(childInline.length > 0 ? { tools: childInline } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(provider !== undefined ? { provider } : {}),
        ...(input.memory !== undefined ? { memory: input.memory } : {}),
        ...(input.name !== undefined ? { name: input.name } : {}),
      };

      const childIo = deps.forkLeaf(input.name !== undefined ? { name: input.name } : {});
      const result = await deps.run(input.prompt, childOpts, childIo);
      return typeof result === "string" ? result : JSON.stringify(result);
    },
  };
}

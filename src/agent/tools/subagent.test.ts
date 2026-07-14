// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { AgentOptions, ToolDef } from "@boardwalk-labs/workflow";
import { EngineError } from "../../errors.js";
import type { AgentIdentity, LeafIo } from "../leaf.js";
import { Redactor } from "../redact.js";
import type { ExecutableTool } from "../tools.js";
import { makeSubagentTool, type SubagentToolDeps } from "./subagent.js";

const builtin = (name: string): ExecutableTool => ({
  name,
  description: name,
  inputSchema: { type: "object" },
  execute: () => Promise.resolve(""),
});

const doubleDef: ToolDef = {
  name: "double",
  description: "Doubles a number",
  inputSchema: { type: "object" },
  execute: () => Promise.resolve("2"),
};

/** A throwaway LeafIo — the `run` stub never touches it; forkLeaf only needs to return one. */
function stubIo(identity: AgentIdentity): LeafIo {
  return {
    identity,
    streamModel: () => Promise.reject(new Error("unused")),
    startTurn: () => {},
    emit: () => {},
    reportUsage: () => {},
    memoryUsed: () => {},
    mcpToken: () => Promise.resolve({ accessToken: null }),
    redactor: new Redactor(),
    capabilities: { workspaceDir: "/tmp", skillsDir: null },
  };
}

interface Harness {
  tool: ExecutableTool;
  runs: { prompt: string; opts: AgentOptions | undefined; io: LeafIo }[];
  forked: { name?: string }[];
}

function harness(
  overrides: Partial<SubagentToolDeps> = {},
  runResult: unknown = "CHILD RESULT",
): Harness {
  const runs: Harness["runs"] = [];
  const forked: Harness["forked"] = [];
  const deps: SubagentToolDeps = {
    // Resolved parent set: three built-ins + the inline `double`. Built-in NAMES define the
    // grantable ceiling; `double` is grantable as an inline tool.
    parentTools: [builtin("read"), builtin("write"), builtin("bash"), builtin("double")],
    parentInlineTools: [doubleDef],
    parentModel: "anthropic/claude-sonnet-4.5",
    parentProvider: undefined,
    parentReasoning: undefined,
    parentCwd: undefined,
    forkLeaf: (opts) => {
      forked.push(opts);
      return stubIo({
        agentId: "agent-2",
        ...(opts.name !== undefined ? { agentName: opts.name } : {}),
      });
    },
    run: (prompt, opts, io) => {
      runs.push({ prompt, opts, io });
      return Promise.resolve(runResult);
    },
    ...overrides,
  };
  return { tool: makeSubagentTool(deps), runs, forked };
}

describe("makeSubagentTool", () => {
  it("grants ALL of the parent's tools by default (built-ins as `builtins`, inline forwarded)", async () => {
    const h = harness();
    const out = await h.tool.execute({ prompt: "do the thing" });

    expect(out).toBe("CHILD RESULT");
    expect(h.runs).toHaveLength(1);
    expect(h.runs[0]?.prompt).toBe("do the thing");
    expect(h.runs[0]?.opts?.builtins).toEqual(["read", "write", "bash"]);
    expect(h.runs[0]?.opts?.tools).toEqual([doubleDef]);
    // The model/provider default to the parent's when the call names none.
    expect(h.runs[0]?.opts?.model).toBe("anthropic/claude-sonnet-4.5");
  });

  it("inherits the parent's reasoning effort (like model/provider)", async () => {
    const h = harness({ parentReasoning: { effort: "high" } });
    await h.tool.execute({ prompt: "p" });
    expect(h.runs[0]?.opts?.reasoning).toEqual({ effort: "high" });
  });

  it("inherits the parent's cwd (the child sees the same working root)", async () => {
    const h = harness({ parentCwd: "checkout-cli" });
    await h.tool.execute({ prompt: "p" });
    const childOpts = h.runs[0]?.opts as (AgentOptions & { cwd?: string }) | undefined;
    expect(childOpts?.cwd).toBe("checkout-cli");
  });

  it("attenuates to a requested subset of the parent's tools", async () => {
    const h = harness();
    await h.tool.execute({ prompt: "p", tools: ["read", "double"] });
    expect(h.runs[0]?.opts?.builtins).toEqual(["read"]);
    expect(h.runs[0]?.opts?.tools).toEqual([doubleDef]);
  });

  it("omits `tools` when no inline tool is granted", async () => {
    const h = harness();
    await h.tool.execute({ prompt: "p", tools: ["bash"] });
    expect(h.runs[0]?.opts?.builtins).toEqual(["bash"]);
    expect(h.runs[0]?.opts?.tools).toBeUndefined();
  });

  it("NEVER grants the `subagent` tool to a child — delegation is one level", async () => {
    const h = harness();
    await h.tool.execute({ prompt: "p" });
    expect(h.runs[0]?.opts?.builtins).not.toContain("subagent");
    // And the model can't ask for it: `subagent` isn't in the grantable set.
    await expect(h.tool.execute({ prompt: "p", tools: ["subagent"] })).rejects.toThrowError(
      EngineError,
    );
  });

  it("rejects a request for tools the parent doesn't have (VALIDATION, names the offenders)", async () => {
    const h = harness();
    const err: unknown = await h.tool
      .execute({ prompt: "p", tools: ["read", "glob"] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EngineError);
    expect(err instanceof EngineError ? err.code : "").toBe("VALIDATION");
    expect(err instanceof EngineError ? err.message : "").toContain("glob");
    expect(h.runs).toHaveLength(0); // never ran a child
  });

  it("passes a per-call model/provider/name override through", async () => {
    const h = harness();
    await h.tool.execute({
      prompt: "p",
      model: "openai/gpt-5",
      provider: "openai",
      name: "researcher",
    });
    expect(h.runs[0]?.opts?.model).toBe("openai/gpt-5");
    expect(h.runs[0]?.opts?.provider).toBe("openai");
    expect(h.runs[0]?.opts?.name).toBe("researcher");
    // forkLeaf was told the child's display name so its events are attributable.
    expect(h.forked).toEqual([{ name: "researcher" }]);
  });

  it("forwards `memory` to the child and forks with no name when unnamed", async () => {
    const h = harness();
    await h.tool.execute({ prompt: "p", memory: "mem/helper" });
    expect(h.runs[0]?.opts?.memory).toBe("mem/helper");
    expect(h.forked).toEqual([{}]);
  });

  it("JSON-stringifies a non-string child result", async () => {
    const h = harness({}, { answer: 42 });
    expect(await h.tool.execute({ prompt: "p" })).toBe('{"answer":42}');
  });

  it("when the parent has no grantable tools, the grantable set is empty and any request is denied", async () => {
    const h = harness({ parentTools: [], parentInlineTools: [] });
    expect(await h.tool.execute({ prompt: "p" })).toBe("CHILD RESULT");
    expect(h.runs[0]?.opts?.builtins).toEqual([]);
    await expect(h.tool.execute({ prompt: "p", tools: ["read"] })).rejects.toThrowError(
      EngineError,
    );
  });
});

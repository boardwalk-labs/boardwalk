// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildToolSet, mcpResultToToolResult, type ExecutableTool } from "./tools.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "bw-tools-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("buildToolSet — ambient <env> date", () => {
  it("appends an <env> date block as the LAST preamble entry (cache-safe placement)", () => {
    const set = buildToolSet(undefined, { workspaceDir: workspace(), skillsDir: null });
    const last = set.preamble[set.preamble.length - 1];
    expect(last).toBeDefined();
    expect(last).toContain("<env>");
    expect(last).toContain("Today's date is");
    // The default tool set includes `clock`, so the block points at it.
    expect(last).toContain("`clock` tool");
  });

  it("keeps the <env> block AFTER project context (AGENTS.md frames the task; date is ambient)", () => {
    const ws = workspace();
    writeFileSync(join(ws, "AGENTS.md"), "# House rules\nAlways be terse.", "utf8");
    const set = buildToolSet(undefined, { workspaceDir: ws, skillsDir: null });
    const agentsIdx = set.preamble.findIndex((b) => b.includes("House rules"));
    const envIdx = set.preamble.findIndex((b) => b.includes("<env>"));
    expect(agentsIdx).toBeGreaterThanOrEqual(0);
    expect(envIdx).toBeGreaterThan(agentsIdx);
    expect(envIdx).toBe(set.preamble.length - 1);
  });

  it("omits the clock pointer when builtins exclude clock", () => {
    const set = buildToolSet({ builtins: "none" }, { workspaceDir: workspace(), skillsDir: null });
    const env = set.preamble.find((b) => b.includes("<env>"));
    expect(env).toBeDefined();
    expect(env).toContain("Today's date is");
    expect(env).not.toContain("clock");
  });

  it("orients the model with the workspace root's top-level entries when fs tools are present", () => {
    const ws = workspace();
    mkdirSync(join(ws, "checkout-cli"));
    writeFileSync(join(ws, "notes.txt"), "hi", "utf8");
    const set = buildToolSet(undefined, { workspaceDir: ws, skillsDir: null });
    const env = set.preamble.find((b) => b.includes("<env>"));
    expect(env).toContain("The workspace root contains: checkout-cli/, notes.txt");
    expect(env).toContain("workspace-relative");
  });

  it("omits the workspace line when the leaf has no filesystem tools", () => {
    const set = buildToolSet({ builtins: "none" }, { workspaceDir: workspace(), skillsDir: null });
    const env = set.preamble.find((b) => b.includes("<env>"));
    expect(env).not.toContain("workspace root");
  });
});

describe("mcpResultToToolResult", () => {
  it("returns a text-only result as a plain string", () => {
    expect(mcpResultToToolResult("srv__tool", { content: "hello", isError: false })).toBe("hello");
  });

  it("wraps file-part content in a RichToolResult so images reach the model", () => {
    const parts = [
      { type: "text" as const, text: "screenshot" },
      { type: "file" as const, file: { mimeType: "image/png", data: "AAAA" } },
    ];
    const result = mcpResultToToolResult("browser__screenshot", { content: parts, isError: false });
    expect(result).toEqual({
      llmText: "screenshot",
      content: parts,
      event: { kind: "mcp_tool_result", humanSummary: "browser__screenshot" },
    });
  });

  it("falls back to a placeholder llmText when file content carries no text", () => {
    const parts = [{ type: "file" as const, file: { mimeType: "image/png", data: "AAAA" } }];
    const result = mcpResultToToolResult("browser__screenshot", { content: parts, isError: false });
    expect(result).toMatchObject({
      llmText: "[browser__screenshot returned a file]",
      content: parts,
    });
  });

  it("throws on the server error flag, surfacing the result text", () => {
    expect(() => mcpResultToToolResult("srv__tool", { content: "boom", isError: true })).toThrow(
      /boom/,
    );
  });

  it("throws a named error when an error result has no content", () => {
    expect(() => mcpResultToToolResult("srv__tool", { content: "", isError: true })).toThrow(
      /MCP tool "srv__tool" reported an error with no content/,
    );
  });
});

describe("buildToolSet — skill tool", () => {
  function skillsDirWith(name: string, body: string): string {
    const root = mkdtempSync(join(tmpdir(), "bw-skills-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), body, "utf8");
    return root;
  }

  function skillTool(skillsDir: string): ExecutableTool {
    const set = buildToolSet({ skills: ["reviewer"] }, { workspaceDir: workspace(), skillsDir });
    const tool = set.tools.find((t) => t.name === "skill");
    if (tool === undefined) throw new Error("expected a `skill` tool");
    return tool;
  }

  const SKILL = "---\ndescription: how to review\n---\nTHE RUBRIC";

  async function loadBody(input: Record<string, unknown>): Promise<string> {
    const out = await skillTool(skillsDirWith("reviewer", SKILL)).execute(input);
    if (typeof out !== "string") throw new Error("expected a string tool result");
    return out;
  }

  it("loads the body when `file` is omitted", async () => {
    expect(await loadBody({ name: "reviewer" })).toContain("THE RUBRIC");
  });

  it("treats an empty `file` as omitted, not a validation error (the LLM-empty-string case)", async () => {
    expect(await loadBody({ name: "reviewer", file: "" })).toContain("THE RUBRIC");
  });
});

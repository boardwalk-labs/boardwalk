// SPDX-License-Identifier: Apache-2.0

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentOptions } from "@boardwalk-labs/workflow";
import { EngineError } from "../errors.js";
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

describe("buildToolSet — agent({ cwd })", () => {
  /** A run workspace with a checkout under `repo/` — the multi-checkout shape cwd exists for. */
  function repoWorkspace(): string {
    const root = workspace();
    mkdirSync(join(root, "repo", "src"), { recursive: true });
    writeFileSync(join(root, "repo", "src", "app.ts"), "hello\n", "utf8");
    writeFileSync(join(root, "root.txt"), "root\n", "utf8");
    return root;
  }

  function withCwd(cwd: string, rest: AgentOptions = {}): AgentOptions {
    return { ...rest, cwd };
  }

  async function execute(
    set: ReturnType<typeof buildToolSet>,
    name: string,
    input: Record<string, unknown>,
  ): Promise<string> {
    const tool = set.tools.find((t) => t.name === name);
    if (tool === undefined) throw new Error(`expected a \`${name}\` tool`);
    const out = await tool.execute(input);
    return typeof out === "string" ? out : out.llmText;
  }

  it("re-roots the file tools: checkout-relative paths resolve under the cwd", async () => {
    const root = repoWorkspace();
    const set = buildToolSet(withCwd("repo"), { workspaceDir: root, skillsDir: null });
    expect(await execute(set, "read", { path: "src/app.ts" })).toBe("hello\n");
  });

  it("confines the leaf to the cwd — a path climbing back to the root fails loudly", async () => {
    const root = repoWorkspace();
    const set = buildToolSet(withCwd("repo"), { workspaceDir: root, skillsDir: null });
    await expect(execute(set, "read", { path: "../root.txt" })).rejects.toThrow(
      /escapes the workspace/,
    );
  });

  it("orients the model with the CWD's entries, not the run root's", () => {
    const root = repoWorkspace();
    const set = buildToolSet(withCwd("repo"), { workspaceDir: root, skillsDir: null });
    const env = set.preamble.find((b) => b.includes("<env>"));
    expect(env).toContain("The workspace root contains: src/");
    expect(env).not.toContain("root.txt");
  });

  it("discovers workspace AGENTS.md from the cwd (the checkout's project rules)", () => {
    const root = repoWorkspace();
    writeFileSync(join(root, "repo", "AGENTS.md"), "REPO RULES", "utf8");
    writeFileSync(join(root, "AGENTS.md"), "RUN-ROOT RULES", "utf8");
    const set = buildToolSet(withCwd("repo"), { workspaceDir: root, skillsDir: null });
    const joined = set.preamble.join("\n\n");
    expect(joined).toContain("REPO RULES");
    expect(joined).not.toContain("RUN-ROOT RULES");
  });

  it("keeps `memory` workspace-ROOT-relative (a stable cross-run identity, not a working location)", async () => {
    const root = repoWorkspace();
    const set = buildToolSet(withCwd("repo", { memory: "mem" }), {
      workspaceDir: root,
      skillsDir: null,
    });
    expect(set.memoryDir).toBe("mem");
    await execute(set, "memory_write", { path: "note.md", content: "x" });
    expect(existsSync(join(root, "mem", "note.md"))).toBe(true);
    expect(existsSync(join(root, "repo", "mem", "note.md"))).toBe(false);
  });

  it("fails loudly when the cwd does not exist or is a file (never silently degrades to the root)", () => {
    const root = repoWorkspace();
    expect(() => buildToolSet(withCwd("nope"), { workspaceDir: root, skillsDir: null })).toThrow(
      /cwd "nope" is not an existing directory/,
    );
    expect(() =>
      buildToolSet(withCwd("root.txt"), { workspaceDir: root, skillsDir: null }),
    ).toThrow(/not an existing directory/);
  });

  it("rejects a cwd escaping the workspace and a non-string cwd", () => {
    const root = repoWorkspace();
    expect(() => buildToolSet(withCwd("../out"), { workspaceDir: root, skillsDir: null })).toThrow(
      /escapes the workspace/,
    );
    const bad = { cwd: 5 } as unknown as AgentOptions;
    expect(() => buildToolSet(bad, { workspaceDir: root, skillsDir: null })).toThrow(
      /`cwd` must be a string/,
    );
  });

  it("treats an empty cwd as the workspace root (the empty-optional-string case)", () => {
    const root = repoWorkspace();
    const set = buildToolSet(withCwd(""), { workspaceDir: root, skillsDir: null });
    const env = set.preamble.find((b) => b.includes("<env>"));
    expect(env).toContain("repo/");
    expect(env).toContain("root.txt");
  });
});

// AgentOptions is UNTRUSTED runtime input: author programs are never type-checked before they run
// (the deploy gate is syntax-only; esbuild strips types without checking them), so a type-invalid
// program reaches buildToolSet intact. Every case below is a TS type error that deploys clean —
// each must produce an EngineError that NAMES the mistake, never a bare TypeError from a guard
// that dereferenced before it checked.
describe("buildToolSet — type-invalid AgentOptions fails loudly, not with a TypeError", () => {
  /** Run buildToolSet with a value the TS types forbid (as an untyped program would). */
  function reject(opts: unknown): EngineError {
    try {
      buildToolSet(opts as AgentOptions, { workspaceDir: workspace(), skillsDir: null });
    } catch (err) {
      // A TypeError here means a guard dereferenced untrusted input before checking its shape.
      if (err instanceof EngineError) return err;
      throw new Error(`expected an EngineError, got ${String(err)}`);
    }
    throw new Error("expected buildToolSet to throw");
  }

  describe("`tools` given built-in names — the mistake authors actually make", () => {
    // The fix must live in the MESSAGE, not the hint: a hosted run reports a failure as
    // `{ code, message }` (the runner's contract has no `hint` field), so a hint is invisible on
    // the one path where this mistake actually bites. Proven on dev run 01KXMPRRW6Z2JJA8MTXD3Z5PPB,
    // whose surfaced error was the message alone.
    it('tools: ["bash"] names the confusion AND says what to type, in the message', () => {
      const err = reject({ tools: ["bash"] });
      expect(err.code).toBe("VALIDATION");
      // The old guard (`def.name.length === 0`) crashed on exactly this input.
      expect(err.message).not.toContain("Cannot read properties");
      expect(err.message).toContain("`tools`");
      expect(err.message).toContain('a string ("bash")');
      expect(err.message).toContain('builtins: ["bash"]');
      expect(err.message).toContain("ON by default");
      expect(err.hint).toContain('builtins: ["bash"]');
    });

    it("special-cases only real built-in names; other strings get the ToolDef shape", () => {
      expect(reject({ tools: ["subagent"] }).message).toContain('builtins: ["subagent"]');
      const err = reject({ tools: ["frobnicate"] });
      expect(err.message).toContain('a string ("frobnicate")');
      expect(err.message).toContain("{ name, description, inputSchema, execute }");
      expect(err.message).not.toContain('builtins: ["frobnicate"]');
      expect(err.hint).not.toContain('builtins: ["frobnicate"]');
    });

    it("catches a bare (unwrapped) `tools` value too", () => {
      expect(reject({ tools: "bash" }).message).toContain("must be an array");
      expect(reject({ tools: "bash" }).message).toContain('builtins: ["bash"]');
      expect(reject({ tools: {} }).message).toContain("must be an array");
    });
  });

  it("rejects a malformed inline tool by naming the offending field", () => {
    expect(reject({ tools: [null] }).message).toContain("null");
    expect(reject({ tools: [{}] }).message).toContain("name");
    // A non-string name used to pass: `(123).length === 0` is false, so it sailed through the guard
    // and was advertised to the provider as a tool named 123.
    expect(reject({ tools: [{ name: 123 }] }).message).toContain("name");
    expect(reject({ tools: [{ name: "" }] }).message).toContain("name");
    const noExecute = reject({ tools: [{ name: "t", description: "d", inputSchema: {} }] });
    expect(noExecute.message).toContain("execute");
  });

  it("still accepts a well-formed inline tool, passing schema + closure through untouched", async () => {
    const inputSchema = { type: "object", properties: { q: { type: "string" } } };
    const set = buildToolSet(
      {
        builtins: "none",
        tools: [
          {
            name: "search",
            description: "Search things",
            inputSchema,
            execute: (input: unknown) => Promise.resolve({ echoed: input }),
          },
        ],
      },
      { workspaceDir: workspace(), skillsDir: null },
    );
    const tool = set.tools.find((t) => t.name === "search");
    expect(tool?.description).toBe("Search things");
    // Validation must not RESHAPE what it validates: the JSON Schema reaches the provider as the
    // same object the program wrote, and `execute` is still the program's own closure.
    expect(tool?.inputSchema).toBe(inputSchema);
    expect(await tool?.execute({ q: "x" })).toBe('{"echoed":{"q":"x"}}');
  });

  it("rejects a wrong-shaped `skills` instead of silently dropping every skill", () => {
    // `skills: {}` used to no-op: `({}).length > 0` is false, so the leaf ran with no skills and no
    // complaint — the exact silent degrade the capability-presence rule forbids.
    expect(reject({ skills: {} }).message).toContain("`skills`");
    expect(reject({ skills: "reviewer" }).message).toContain("must be an array");
    expect(reject({ skills: [123] }).message).toContain("`skills`");
  });

  it("rejects a non-string `memory` (the path regex would coerce it and let it through)", () => {
    const err = reject({ memory: 123 });
    expect(err.message).toContain("`memory`");
    expect(err.message).toContain("a number (123)");
    expect(reject({ memory: {} }).message).toContain("`memory`");
    expect(reject({ memory: true }).message).toContain("`memory`");
  });

  it("rejects a wrong-shaped `mcp`, including a ref that breaks the error message itself", () => {
    expect(reject({ mcp: {} }).message).toContain("must be an array");
    // `mcp: [null]` used to crash while FORMATTING its own validation error (reading `ref.name`).
    expect(reject({ mcp: [null] }).message).toContain("malformed MCP server ref");
    expect(reject({ mcp: [{ name: "x", transport: "carrier-pigeon" }] }).message).toContain(
      "malformed MCP server ref",
    );
  });

  it("caps the echoed value so a huge one cannot flood the error", () => {
    // The invariant is that the message does not grow with the input, not any exact length: a
    // validation error must never become a channel for dumping a huge value into run events.
    const message = reject({ tools: ["z".repeat(5000)] }).message;
    expect(message).not.toContain("z".repeat(50));
    expect(message.length).toBeLessThan(300);
  });
});

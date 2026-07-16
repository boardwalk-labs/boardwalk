// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type { ExecutableTool, RichToolResult, ToolExecuteResult } from "../tools.js";
import { RUN_CODE_EXCLUDED_TOOLS, runCodeTool } from "./run_code.js";

function tool(
  name: string,
  execute: (input: Record<string, unknown>) => Promise<ToolExecuteResult>,
): ExecutableTool {
  return { name, description: `the ${name} tool`, inputSchema: { type: "object" }, execute };
}

/** Run a snippet and return the model-facing text. */
async function run(
  callable: readonly ExecutableTool[],
  code: string,
  extra: Record<string, unknown> = {},
): Promise<RichToolResult> {
  const result = await runCodeTool(callable).execute({ code, ...extra });
  // run_code always returns a RichToolResult.
  expect(typeof result).toBe("object");
  return result as RichToolResult;
}

describe("run_code — orchestration", () => {
  it("calls a tool via `await tools.<name>(input)` and returns the summary", async () => {
    const read = vi.fn((input: Record<string, unknown>) =>
      Promise.resolve(`contents of ${String(input.path)}`),
    );
    const r = await run(
      [tool("read", read)],
      `const c = await tools.read({ path: "a.txt" }); return c.toUpperCase();`,
    );
    expect(read).toHaveBeenCalledWith({ path: "a.txt" });
    expect(r.llmText).toContain("CONTENTS OF A.TXT");
  });

  it("captures console.log output", async () => {
    const r = await run([], `console.log("hello", 42); console.log({ a: 1 });`);
    expect(r.llmText).toContain("hello 42");
    expect(r.llmText).toContain('{"a":1}');
  });

  it("keeps intermediate tool results OUT of the output unless the code surfaces them", async () => {
    // The whole point of PTC: a result the code consumes but never logs/returns must not appear.
    const fetchBig = vi.fn(() => Promise.resolve("SECRET_ROW_1\nSECRET_ROW_2\nSECRET_ROW_3"));
    const r = await run(
      [tool("fetch", fetchBig)],
      `const data = await tools.fetch({}); const lines = data.split("\\n"); return lines.length;`,
    );
    expect(fetchBig).toHaveBeenCalled();
    expect(r.llmText).toContain("3"); // the summary
    expect(r.llmText).not.toContain("SECRET_ROW_1"); // the raw data never entered context
  });

  it("aggregates across many tool calls into one small result", async () => {
    const check = vi.fn((input: Record<string, unknown>) =>
      Promise.resolve(Number(input.n) % 2 === 0 ? "even" : "odd"),
    );
    const r = await run(
      [tool("check", check)],
      `const evens = [];
       for (let n = 0; n < 10; n++) {
         const kind = await tools.check({ n });
         if (kind === "even") evens.push(n);
       }
       return evens;`,
    );
    expect(check).toHaveBeenCalledTimes(10);
    expect(r.llmText).toContain("[0,2,4,6,8]");
    expect(r.event.humanSummary).toContain("10 tool call");
  });

  it("streams a per-inner-call trace to the live view but NOT into the model's result", async () => {
    const chunks: string[] = [];
    const t = vi.fn(() => Promise.resolve("row1\nrow2"));
    const result = await runCodeTool([tool("query", t)]).execute(
      { code: `const r = await tools.query({ table: "users" }); return r.split("\\n").length;` },
      (_stream, text) => chunks.push(text),
    );
    const streamed = chunks.join("");
    // The trace shows the inner call in the activity stream…
    expect(streamed).toContain("» query(");
    expect(streamed).toContain("users");
    // …but the model's result carries only the code's summary, never the trace line or raw rows.
    const llmText = (result as RichToolResult).llmText;
    expect(llmText).toContain("return: 2");
    expect(llmText).not.toContain("» query(");
    expect(llmText).not.toContain("row1");
  });

  it("exposes a generic call(name, input) escape hatch", async () => {
    const t = vi.fn(() => Promise.resolve("ok"));
    const r = await run([tool("weird_name", t)], `return await tools.call("weird_name", {});`);
    expect(t).toHaveBeenCalled();
    expect(r.llmText).toContain("ok");
  });
});

describe("run_code — errors are the model's to fix, not run failures", () => {
  it("returns a thrown error as text, preserving output produced before the throw", async () => {
    const r = await run([], `console.log("before"); throw new Error("boom");`);
    expect(r.llmText).toContain("before");
    expect(r.llmText).toContain("boom");
    expect(r.event.humanSummary).toContain("error");
  });

  it("returns a syntax error as text", async () => {
    const r = await run([], `this is not valid javascript ) (`);
    expect(r.llmText).toContain("SyntaxError");
  });

  it("errors clearly when the snippet calls an unknown tool", async () => {
    const r = await run(
      [tool("read", () => Promise.resolve("x"))],
      `return await tools.call("nope", {});`,
    );
    expect(r.llmText).toContain('no tool named "nope"');
  });

  it("rejects an empty code string", async () => {
    await expect(runCodeTool([]).execute({ code: "   " })).rejects.toThrow(/non-empty/);
  });
});

describe("run_code — bounds", () => {
  it("caps runaway output", async () => {
    const r = await run([], `for (let i = 0; i < 100000; i++) console.log("x".repeat(100));`);
    expect(r.llmText).toContain("truncated");
    expect(r.llmText.length).toBeLessThan(70_000);
  });

  it("times out an async hang", async () => {
    const hang = tool("hang", () => new Promise<string>(() => {})); // never resolves
    const r = await run([hang], `await tools.hang({}); return "done";`, { timeoutMs: 150 });
    expect(r.llmText).toContain("exceeded");
  });

  it("hard-bounds a SYNCHRONOUS infinite loop by terminating the worker", async () => {
    // The whole point of the worker-thread execution model: a `while (true) {}` blocks the WORKER's
    // thread, not the leaf's event loop, so the parent's timeout still fires and terminates it. On the
    // old in-process model this test would hang the process forever.
    const r = await run([], `while (true) {}`, { timeoutMs: 250 });
    expect(r.llmText).toContain("exceeded");
  }, 5_000);
});

describe("run_code — the excluded meta-tools", () => {
  it("names the tools it must never expose to a snippet", () => {
    expect(RUN_CODE_EXCLUDED_TOOLS.has("subagent")).toBe(true);
    expect(RUN_CODE_EXCLUDED_TOOLS.has("human_input")).toBe(true);
    expect(RUN_CODE_EXCLUDED_TOOLS.has("find_tools")).toBe(true);
  });

  it("lists the callable tool names in its description (capped), so the model knows what it can call", () => {
    const t = runCodeTool([
      tool("read", () => Promise.resolve("")),
      tool("grep", () => Promise.resolve("")),
    ]);
    expect(t.description).toContain("read");
    expect(t.description).toContain("grep");
  });
});

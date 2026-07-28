// SPDX-License-Identifier: Apache-2.0

// The `navigate` built-in: position resolution (the symbol-name affordance that keeps an agent from
// having to guess a column) and the tool's rendering contract — notably that a server which never
// answered reads as "retry", never as "no results".
//
// The LspService is real; only the SESSION is faked, so these exercise the actual service parsing
// and workspace-relative rendering rather than stubbing them out.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LspService } from "../lsp/index.js";
import type { LspRequestOutcome, LspSession } from "../lsp/index.js";
import { navigateTool, resolvePosition } from "./navigate.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

function workspace(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "bw-nav-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content, "utf8");
  }
  return dir;
}

/** Scripted LSP replies, keyed by method; a method with no entry reports as never answered. */
type Script = Record<string, unknown>;

/**
 * An LspSession double answering from a script. The service only calls requestForFile/request/close
 * on it, so it is structurally sufficient — the cast is the same one service.test.ts uses, since a
 * class with private fields can't be satisfied structurally.
 */
function fakeSession(script: Script, unanswered: boolean): LspSession {
  const reply = (method: string): LspRequestOutcome =>
    unanswered || !(method in script)
      ? { answered: false }
      : { answered: true, result: script[method] };
  const stub = {
    requestForFile: (_path: string, method: string) => Promise.resolve(reply(method)),
    request: (method: string) => Promise.resolve(reply(method)),
    diagnostics: () => Promise.resolve({ available: true, diagnostics: [] }),
    urisWithDiagnostics: () => [],
    close: () => Promise.resolve(),
  };
  return stub as unknown as LspSession;
}

function serviceWith(
  workspaceDir: string,
  script: Script,
  opts: { unanswered?: boolean; available?: boolean } = {},
): LspService {
  return new LspService({
    workspaceDir,
    isAvailable: () => opts.available ?? true,
    createSession: () => fakeSession(script, opts.unanswered ?? false),
  });
}

function range(line: number, character: number) {
  return { start: { line, character }, end: { line, character: character + 4 } };
}

describe("resolvePosition", () => {
  const source = [
    "const parseConfig = 1;",
    "function parse(input) {",
    "  return parse(input);",
    "}",
  ].join("\n");

  it("passes explicit line+character straight through", () => {
    expect(resolvePosition(source, { line: 2, character: 10 })).toEqual({ line: 2, character: 10 });
  });

  it("resolves a symbol name to its first whole-word occurrence", () => {
    // Line 1 contains `parseConfig`, which must NOT match a search for `parse`.
    expect(resolvePosition(source, { symbol: "parse" })).toEqual({ line: 2, character: 10 });
  });

  it("matches a symbol that IS the longer identifier", () => {
    expect(resolvePosition(source, { symbol: "parseConfig" })).toEqual({ line: 1, character: 7 });
  });

  it("uses `line` to disambiguate a repeated name", () => {
    expect(resolvePosition(source, { symbol: "parse", line: 3 })).toEqual({
      line: 3,
      character: 10,
    });
  });

  it("treats $ as an identifier character, which a \\b regex would get wrong", () => {
    const text = "const $value = 1;\nconst value = 2;";
    expect(resolvePosition(text, { symbol: "value" })).toEqual({ line: 2, character: 7 });
  });

  it("fails loudly when no position was given, naming what to pass", () => {
    expect(() => resolvePosition(source, {})).toThrow(/needs a position/);
  });

  it("fails loudly when the symbol is absent, rather than returning a wrong position", () => {
    expect(() => resolvePosition(source, { symbol: "nope" })).toThrow(/was not found in the file/);
    expect(() => resolvePosition(source, { symbol: "parse", line: 1 })).toThrow(/on line 1/);
  });

  it("rejects a line past the end of the file", () => {
    expect(() => resolvePosition(source, { line: 999, character: 1 })).toThrow(/past the end/);
  });
});

describe("navigate tool", () => {
  async function run(tool: ReturnType<typeof navigateTool>, input: Record<string, unknown>) {
    const result = await tool.execute(input);
    return typeof result === "string" ? result : JSON.stringify(result);
  }

  it("reports a clean note (never an error) when no language server handles the file", async () => {
    const dir = workspace({ "notes.md": "# hi" });
    const tool = navigateTool(dir, serviceWith(dir, {}));
    await expect(
      run(tool, { operation: "definition", path: "notes.md", symbol: "hi" }),
    ).resolves.toMatch(/No language server available/);
  });

  it("renders definitions as workspace-relative path:line:col with the source line", async () => {
    const dir = workspace({
      "a.ts": "import { parse } from './b.js';\n",
      "b.ts": "export function parse(input: string) {\n  return input;\n}\n",
    });
    const tool = navigateTool(
      dir,
      serviceWith(dir, {
        "textDocument/definition": [{ uri: `file://${join(dir, "b.ts")}`, range: range(0, 16) }],
      }),
    );
    const out = await run(tool, { operation: "definition", path: "a.ts", symbol: "parse" });
    expect(out).toContain("b.ts:1:17");
    expect(out).toContain("export function parse(input: string) {");
    expect(out).not.toContain(dir); // the absolute workspace root must never leak
  });

  it("says RETRY, not 'no results', when the server never answered", async () => {
    const dir = workspace({ "a.ts": "const parse = 1;\n" });
    const tool = navigateTool(dir, serviceWith(dir, {}, { unanswered: true }));
    const out = await run(tool, { operation: "references", path: "a.ts", symbol: "parse" });
    // The distinction is load-bearing: "0 results" would tell the loop the symbol is dead code.
    expect(out).toMatch(/still indexing/);
    expect(out).toMatch(/retry/i);
    expect(out).not.toMatch(/No results/);
  });

  it("reports a genuine empty answer as no results", async () => {
    const dir = workspace({ "a.ts": "const parse = 1;\n" });
    const tool = navigateTool(dir, serviceWith(dir, { "textDocument/references": [] }));
    const out = await run(tool, { operation: "references", path: "a.ts", symbol: "parse" });
    expect(out).toMatch(/^No results for/);
  });

  it("renders document symbols with their kind and container", async () => {
    const dir = workspace({ "a.ts": "class Parser {\n  parse() {}\n}\n" });
    const tool = navigateTool(
      dir,
      serviceWith(dir, {
        "textDocument/documentSymbol": [
          {
            name: "Parser",
            kind: 5,
            range: range(0, 0),
            selectionRange: range(0, 6),
            children: [{ name: "parse", kind: 6, range: range(1, 2), selectionRange: range(1, 2) }],
          },
        ],
      }),
    );
    const out = await run(tool, { operation: "document_symbols", path: "a.ts" });
    expect(out).toContain("a.ts:1:7  class Parser");
    expect(out).toContain("a.ts:2:3  method Parser.parse");
  });

  it("walks the call hierarchy through prepare → incomingCalls", async () => {
    const dir = workspace({ "a.ts": "function parse() {}\n" });
    const tool = navigateTool(
      dir,
      serviceWith(dir, {
        "textDocument/prepareCallHierarchy": [
          {
            name: "parse",
            kind: 12,
            uri: `file://${join(dir, "a.ts")}`,
            range: range(0, 0),
            selectionRange: range(0, 9),
          },
        ],
        "callHierarchy/incomingCalls": [
          {
            from: {
              name: "main",
              kind: 12,
              uri: `file://${join(dir, "a.ts")}`,
              range: range(0, 0),
              selectionRange: range(0, 0),
            },
            fromRanges: [],
          },
        ],
      }),
    );
    const out = await run(tool, { operation: "incoming_calls", path: "a.ts", symbol: "parse" });
    expect(out).toContain("callers of `parse`");
    expect(out).toContain("function main");
  });

  it("requires a query for workspace_symbols", async () => {
    const dir = workspace({ "a.ts": "const parse = 1;\n" });
    const tool = navigateTool(dir, serviceWith(dir, {}));
    await expect(run(tool, { operation: "workspace_symbols", path: "a.ts" })).rejects.toThrow(
      /"query" must be a non-empty string/,
    );
  });

  it("rejects an unknown operation and a path outside the workspace", async () => {
    const dir = workspace({ "a.ts": "const parse = 1;\n" });
    const tool = navigateTool(dir, serviceWith(dir, {}));
    await expect(run(tool, { operation: "teleport", path: "a.ts" })).rejects.toThrow(
      /`operation` must be one of/,
    );
    await expect(
      run(tool, { operation: "definition", path: "../escape.ts", symbol: "x" }),
    ).rejects.toThrow(/escapes the workspace/);
  });

  it("rejects a path that does not exist", async () => {
    const dir = workspace({ "a.ts": "const parse = 1;\n" });
    const tool = navigateTool(dir, serviceWith(dir, {}));
    await expect(
      run(tool, { operation: "definition", path: "gone.ts", symbol: "x" }),
    ).rejects.toThrow(/no such file/);
  });

  it("returns hover text as-is, and a clear note when there is none", async () => {
    const dir = workspace({ "a.ts": "const parse = 1;\n" });
    const withHover = navigateTool(
      dir,
      serviceWith(dir, {
        "textDocument/hover": { contents: { kind: "markdown", value: "const parse: 1" } },
      }),
    );
    await expect(
      run(withHover, { operation: "hover", path: "a.ts", symbol: "parse" }),
    ).resolves.toBe("const parse: 1");

    const noHover = navigateTool(dir, serviceWith(dir, { "textDocument/hover": null }));
    await expect(
      run(noHover, { operation: "hover", path: "a.ts", symbol: "parse" }),
    ).resolves.toMatch(/No hover information for `parse`/);
  });
});

// SPDX-License-Identifier: Apache-2.0

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Diagnostic, FileDiagnostics, LspService } from "../lsp/index.js";
import type { RichToolResult } from "../tools.js";
import {
  editTool,
  globToRegExp,
  globTool,
  grepTool,
  lsTool,
  readTool,
  writeTool,
} from "./fs_tools.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

/** read/ls/grep/glob return a structured result; narrow it for assertions (cast-free). */
function rich(result: string | RichToolResult): RichToolResult {
  if (typeof result === "string") throw new Error("expected a structured tool result");
  return result;
}

function ws(): string {
  const dir = mkdtempSync(join(tmpdir(), "bw-fs-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("read", () => {
  it("reads a whole file and a line slice", async () => {
    const dir = ws();
    writeFileSync(join(dir, "f.txt"), "l1\nl2\nl3\nl4");
    const tool = readTool(dir);
    const whole = rich(await tool.execute({ path: "f.txt" }));
    expect(whole.llmText).toBe("l1\nl2\nl3\nl4");
    // Structured event for observers: kind, path, and the (capped) content.
    expect(whole.event.kind).toBe("file_read");
    expect(whole.event.data).toMatchObject({ path: "f.txt", output: "l1\nl2\nl3\nl4" });
    expect(rich(await tool.execute({ path: "f.txt", offset: 2, limit: 2 })).llmText).toBe("l2\nl3");
  });

  it("rejects a path escaping the workspace and a missing file", async () => {
    const tool = readTool(ws());
    await expect(tool.execute({ path: "../escape" })).rejects.toThrow(/escapes the workspace/);
    await expect(tool.execute({ path: "/etc/passwd" })).rejects.toThrow(/escapes the workspace/);
    await expect(tool.execute({ path: "nope.txt" })).rejects.toThrow(/no such file/);
  });
});

describe("write", () => {
  it("creates a file, making parent dirs", async () => {
    const dir = ws();
    const tool = writeTool(dir);
    await tool.execute({ path: "a/b/c.txt", content: "hi" });
    expect(readFileSync(join(dir, "a/b/c.txt"), "utf8")).toBe("hi");
  });

  it("overwrites and rejects an escape", async () => {
    const dir = ws();
    const tool = writeTool(dir);
    await tool.execute({ path: "f", content: "one" });
    await tool.execute({ path: "f", content: "two" });
    expect(readFileSync(join(dir, "f"), "utf8")).toBe("two");
    await expect(tool.execute({ path: "../x", content: "y" })).rejects.toThrow(/escapes/);
  });
});

describe("edit", () => {
  it("replaces a unique occurrence", async () => {
    const dir = ws();
    writeFileSync(join(dir, "f"), "alpha BETA gamma");
    const tool = editTool(dir);
    await tool.execute({ path: "f", old: "BETA", new: "delta" });
    expect(readFileSync(join(dir, "f"), "utf8")).toBe("alpha delta gamma");
  });

  it("emits a structured file_edit event with a unified diff and +/- counts", async () => {
    const dir = ws();
    writeFileSync(join(dir, "f.ts"), "a\nb\nc\n");
    const result = rich(await editTool(dir).execute({ path: "f.ts", old: "b", new: "B" }));
    expect(result.event.kind).toBe("file_edit");
    expect(result.event.humanSummary).toBe("edited f.ts (+1 -1)");
    expect(result.event.data).toMatchObject({ path: "f.ts", additions: 1, deletions: 1 });
    expect(result.event.data?.["diff"]).toContain("-b");
    expect(result.event.data?.["diff"]).toContain("+B");
  });

  it("write marks a brand-new file as created in its file_edit event", async () => {
    const dir = ws();
    const result = rich(await writeTool(dir).execute({ path: "new.ts", content: "x\ny" }));
    expect(result.event.kind).toBe("file_edit");
    expect(result.event.data).toMatchObject({ path: "new.ts", created: true, additions: 2 });
  });

  it("fails on an absent or ambiguous match unless replaceAll", async () => {
    const dir = ws();
    writeFileSync(join(dir, "f"), "x x x");
    const tool = editTool(dir);
    await expect(tool.execute({ path: "f", old: "z", new: "q" })).rejects.toThrow(/not found/);
    await expect(tool.execute({ path: "f", old: "x", new: "y" })).rejects.toThrow(
      /appears 3 times/,
    );
    await tool.execute({ path: "f", old: "x", new: "y", replaceAll: true });
    expect(readFileSync(join(dir, "f"), "utf8")).toBe("y y y");
  });
});

describe("ls", () => {
  it("lists files and dirs with sizes", async () => {
    const dir = ws();
    writeFileSync(join(dir, "file.txt"), "abc");
    mkdirSync(join(dir, "sub"));
    const out = rich(await lsTool(dir).execute({})).llmText;
    expect(out).toContain("file.txt  (3 bytes)");
    expect(out).toContain("sub/  (dir)");
  });

  it("rejects a non-directory / escaping path", async () => {
    const tool = lsTool(ws());
    await expect(tool.execute({ path: "../" })).rejects.toThrow(/escapes the workspace/);
    await expect(tool.execute({ path: "missing" })).rejects.toThrow(/no such directory/);
  });
});

describe("grep", () => {
  it("finds matches as path:line:text and reports none", async () => {
    const dir = ws();
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src/a.ts"), "const x = 1;\nconst FINDME = 2;\n");
    writeFileSync(join(dir, "src/b.ts"), "nothing here\n");
    const tool = grepTool(dir);
    const found = rich(await tool.execute({ pattern: "FINDME" }));
    expect(found.llmText).toContain("src/a.ts:2:const FINDME = 2;");
    expect(found.llmText).not.toContain(dir); // the absolute workspace path never leaks — only relative paths
    expect(found.event).toMatchObject({ kind: "search", data: { pattern: "FINDME" } });
    expect(rich(await tool.execute({ pattern: "ZZZNOPE" })).llmText).toBe("(no matches)");
  });

  it("skips node_modules/.git", async () => {
    const dir = ws();
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, "node_modules/dep.js"), "TARGETWORD");
    writeFileSync(join(dir, "real.js"), "TARGETWORD");
    const out = rich(await grepTool(dir).execute({ pattern: "TARGETWORD" })).llmText;
    expect(out).toContain("real.js");
    expect(out).not.toContain("node_modules");
  });
});

describe("glob", () => {
  it("translates patterns correctly", () => {
    expect(globToRegExp("*.ts").test("a.ts")).toBe(true);
    expect(globToRegExp("*.ts").test("dir/a.ts")).toBe(false);
    expect(globToRegExp("src/**/*.ts").test("src/x/y/z.ts")).toBe(true);
    expect(globToRegExp("src/**/*.ts").test("src/z.ts")).toBe(true);
    expect(globToRegExp("a?.js").test("ab.js")).toBe(true);
    expect(globToRegExp("a?.js").test("abc.js")).toBe(false);
  });

  it("finds files matching the pattern", async () => {
    const dir = ws();
    mkdirSync(join(dir, "src/inner"), { recursive: true });
    writeFileSync(join(dir, "src/a.ts"), "");
    writeFileSync(join(dir, "src/inner/b.ts"), "");
    writeFileSync(join(dir, "src/c.js"), "");
    const out = rich(await globTool(dir).execute({ pattern: "src/**/*.ts" })).llmText;
    expect(out).toContain("src/a.ts");
    expect(out).toContain("src/inner/b.ts");
    expect(out).not.toContain("c.js");
  });

  it("reports when nothing matches", async () => {
    expect(rich(await globTool(ws()).execute({ pattern: "**/*.zzz" })).llmText).toBe(
      "(no files matched)",
    );
  });
});

it("write then read round-trips through the workspace", async () => {
  const dir = ws();
  await writeTool(dir).execute({ path: "round.txt", content: "trip" });
  expect(existsSync(join(dir, "round.txt"))).toBe(true);
  expect(rich(await readTool(dir).execute({ path: "round.txt" })).llmText).toBe("trip");
});

// ----------------------------------------------------------------------------
// Diagnostics-after-edit (best-effort): write/edit append a language server's diagnostics when one
// is available, and degrade silently (plain write result, no error, no hang) when it isn't.
// ----------------------------------------------------------------------------

const ERROR_DIAG: Diagnostic = { line: 2, severity: "error", message: "boom", source: "ts 2304" };

/** A minimal LspService double — only the methods the fs tools call (supports + diagnostics). */
function fakeLsp(opts: {
  supports?: boolean;
  result?: FileDiagnostics;
  throwOnDiagnostics?: boolean;
}): LspService {
  const stub = {
    supports: () => opts.supports ?? true,
    diagnostics: () =>
      opts.throwOnDiagnostics === true
        ? Promise.reject(new Error("server hiccup"))
        : Promise.resolve(opts.result ?? { available: true, diagnostics: [ERROR_DIAG] }),
  };
  return stub as unknown as LspService;
}

describe("diagnostics-after-edit", () => {
  it("write appends the file's diagnostics after a successful write", async () => {
    const dir = ws();
    const out = rich(
      await writeTool(dir, fakeLsp({})).execute({ path: "a.ts", content: "x\noops;\n" }),
    ).llmText;
    expect(out).toContain("wrote a.ts");
    expect(out).toContain("error a.ts:2 boom [ts 2304]");
  });

  it("edit appends the file's diagnostics after a successful edit", async () => {
    const dir = ws();
    writeFileSync(join(dir, "a.ts"), "const ok = 1;\nbad;\n");
    const out = rich(
      await editTool(dir, fakeLsp({})).execute({ path: "a.ts", old: "bad", new: "oops" }),
    ).llmText;
    expect(out).toContain("edited a.ts");
    expect(out).toContain("error a.ts:2 boom");
  });

  it("appends nothing when the file has no diagnostics (clean write result)", async () => {
    const dir = ws();
    const lsp = fakeLsp({ result: { available: true, diagnostics: [] } });
    const out = rich(await writeTool(dir, lsp).execute({ path: "a.ts", content: "ok\n" })).llmText;
    expect(out).toBe("wrote a.ts (3 chars)");
  });

  it("with LSP unavailable for the file, the result is the plain write (no error, no append)", async () => {
    const dir = ws();
    const lsp = fakeLsp({ supports: false });
    const out = rich(
      await writeTool(dir, lsp).execute({ path: "notes.md", content: "hi" }),
    ).llmText;
    expect(out).toBe("wrote notes.md (2 chars)");
  });

  it("with NO LspService at all, write/edit behave exactly as before", async () => {
    const dir = ws();
    expect(rich(await writeTool(dir).execute({ path: "a.ts", content: "x" })).llmText).toBe(
      "wrote a.ts (1 chars)",
    );
    const out = rich(await editTool(dir).execute({ path: "a.ts", old: "x", new: "y" })).llmText;
    expect(out).toBe("edited a.ts (1 replacement)");
  });

  it("a language-server hiccup never fails the write (best-effort)", async () => {
    const dir = ws();
    const out = rich(
      await writeTool(dir, fakeLsp({ throwOnDiagnostics: true })).execute({
        path: "a.ts",
        content: "x\n",
      }),
    ).llmText;
    expect(out).toBe("wrote a.ts (2 chars)");
  });

  it("the write itself still succeeds even when diagnostics are appended (file is on disk)", async () => {
    const dir = ws();
    await writeTool(dir, fakeLsp({})).execute({ path: "a.ts", content: "payload\n" });
    expect(readFileSync(join(dir, "a.ts"), "utf8")).toBe("payload\n");
  });
});

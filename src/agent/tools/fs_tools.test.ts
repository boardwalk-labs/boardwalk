// SPDX-License-Identifier: Apache-2.0

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
    expect(await tool.execute({ path: "f.txt" })).toBe("l1\nl2\nl3\nl4");
    expect(await tool.execute({ path: "f.txt", offset: 2, limit: 2 })).toBe("l2\nl3");
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
    const out = await lsTool(dir).execute({});
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
    const out = await tool.execute({ pattern: "FINDME" });
    expect(out).toContain("src/a.ts:2:const FINDME = 2;");
    expect(out).not.toContain(dir); // the absolute workspace path never leaks — only relative paths
    expect(await tool.execute({ pattern: "ZZZNOPE" })).toBe("(no matches)");
  });

  it("skips node_modules/.git", async () => {
    const dir = ws();
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, "node_modules/dep.js"), "TARGETWORD");
    writeFileSync(join(dir, "real.js"), "TARGETWORD");
    const out = await grepTool(dir).execute({ pattern: "TARGETWORD" });
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
    const out = await globTool(dir).execute({ pattern: "src/**/*.ts" });
    expect(out).toContain("src/a.ts");
    expect(out).toContain("src/inner/b.ts");
    expect(out).not.toContain("c.js");
  });

  it("reports when nothing matches", async () => {
    expect(await globTool(ws()).execute({ pattern: "**/*.zzz" })).toBe("(no files matched)");
  });
});

it("write then read round-trips through the workspace", async () => {
  const dir = ws();
  await writeTool(dir).execute({ path: "round.txt", content: "trip" });
  expect(existsSync(join(dir, "round.txt"))).toBe(true);
  expect(await readTool(dir).execute({ path: "round.txt" })).toBe("trip");
});

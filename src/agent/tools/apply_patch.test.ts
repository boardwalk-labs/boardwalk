// SPDX-License-Identifier: Apache-2.0

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RichToolResult } from "../tools.js";
import { applyPatchTool, parsePatch } from "./apply_patch.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

/** apply_patch returns a structured result; narrow it for assertions (cast-free). */
function rich(result: string | RichToolResult): RichToolResult {
  if (typeof result === "string") throw new Error("expected a structured tool result");
  return result;
}

function ws(): string {
  const dir = mkdtempSync(join(tmpdir(), "bw-patch-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function patch(...lines: string[]): string {
  return ["*** Begin Patch", ...lines, "*** End Patch"].join("\n");
}

describe("apply_patch — parse", () => {
  it("requires the begin/end markers", () => {
    expect(() => parsePatch("no markers")).toThrow(/must start with/);
    expect(() => parsePatch("*** Begin Patch\nstuff")).toThrow(/must end with/);
  });

  it("parses add/update/delete actions", () => {
    const actions = parsePatch(
      patch(
        "*** Add File: new.ts",
        "+line",
        "*** Delete File: gone.ts",
        "*** Update File: ex.ts",
        "@@",
        " ctx",
        "-old",
        "+new",
      ),
    );
    expect(actions).toHaveLength(3);
    expect(actions[0]?.kind).toBe("add");
    expect(actions[1]?.kind).toBe("delete");
    expect(actions[2]?.kind).toBe("update");
  });
});

describe("apply_patch — apply", () => {
  it("adds a file", async () => {
    const dir = ws();
    await applyPatchTool(dir).execute({
      patch: patch("*** Add File: hello.ts", "+export const x = 1;", "+export const y = 2;"),
    });
    expect(readFileSync(join(dir, "hello.ts"), "utf8")).toBe(
      "export const x = 1;\nexport const y = 2;",
    );
  });

  it("updates a file by a located hunk", async () => {
    const dir = ws();
    writeFileSync(join(dir, "f.ts"), "a\nb\nc\n");
    await applyPatchTool(dir).execute({
      patch: patch("*** Update File: f.ts", "@@", " a", "-b", "+B", " c"),
    });
    expect(readFileSync(join(dir, "f.ts"), "utf8")).toBe("a\nB\nc\n");
  });

  it("deletes a file", async () => {
    const dir = ws();
    writeFileSync(join(dir, "old.ts"), "bye");
    await applyPatchTool(dir).execute({ patch: patch("*** Delete File: old.ts") });
    expect(existsSync(join(dir, "old.ts"))).toBe(false);
  });

  it("moves (renames) a file while updating it", async () => {
    const dir = ws();
    writeFileSync(join(dir, "from.ts"), "x\ny\n");
    await applyPatchTool(dir).execute({
      patch: patch("*** Update File: from.ts", "*** Move to: to.ts", "@@", " x", "-y", "+Y"),
    });
    expect(existsSync(join(dir, "from.ts"))).toBe(false);
    expect(readFileSync(join(dir, "to.ts"), "utf8")).toBe("x\nY\n");
  });

  it("applies a multi-file patch atomically across files", async () => {
    const dir = ws();
    writeFileSync(join(dir, "a.ts"), "1\n2\n");
    await applyPatchTool(dir).execute({
      patch: patch(
        "*** Add File: b.ts",
        "+new file",
        "*** Update File: a.ts",
        "@@",
        " 1",
        "-2",
        "+22",
      ),
    });
    expect(readFileSync(join(dir, "a.ts"), "utf8")).toBe("1\n22\n");
    expect(readFileSync(join(dir, "b.ts"), "utf8")).toBe("new file");
  });

  it("emits a structured file_edit event with a per-file unified diff", async () => {
    const dir = ws();
    writeFileSync(join(dir, "a.ts"), "1\n2\n");
    const result = rich(
      await applyPatchTool(dir).execute({
        patch: patch(
          "*** Add File: b.ts",
          "+new file",
          "*** Update File: a.ts",
          "@@",
          " 1",
          "-2",
          "+22",
        ),
      }),
    );
    expect(result.event.kind).toBe("file_edit");
    // The per-file diffs ride in data.files (asserted on the serialized payload — no casts).
    const serialized = JSON.stringify(result.event.data);
    expect(serialized).toContain('"path":"b.ts"');
    expect(serialized).toContain('"created":true');
    expect(serialized).toContain('"path":"a.ts"');
    expect(serialized).toContain("-2");
    expect(serialized).toContain("+22");
  });
});

describe("apply_patch — atomicity (NOTHING is written when any part fails)", () => {
  it("rejects the whole patch and writes nothing when one hunk does not match", async () => {
    const dir = ws();
    writeFileSync(join(dir, "a.ts"), "1\n2\n");
    await expect(
      applyPatchTool(dir).execute({
        patch: patch(
          "*** Add File: b.ts",
          "+should not be written",
          "*** Update File: a.ts",
          "@@",
          " 1",
          "-DOES-NOT-EXIST",
          "+x",
        ),
      }),
    ).rejects.toThrow(/did not match/);
    // b.ts must NOT exist — the add was planned but never committed because the update failed.
    expect(existsSync(join(dir, "b.ts"))).toBe(false);
    expect(readFileSync(join(dir, "a.ts"), "utf8")).toBe("1\n2\n");
  });

  it("rejects an add whose target already exists", async () => {
    const dir = ws();
    writeFileSync(join(dir, "exists.ts"), "here");
    await expect(
      applyPatchTool(dir).execute({ patch: patch("*** Add File: exists.ts", "+x") }),
    ).rejects.toThrow(/already exists/);
    expect(readFileSync(join(dir, "exists.ts"), "utf8")).toBe("here");
  });

  it("rejects an ambiguous hunk (matches more than once)", async () => {
    const dir = ws();
    writeFileSync(join(dir, "f.ts"), "x\nx\n");
    await expect(
      applyPatchTool(dir).execute({ patch: patch("*** Update File: f.ts", "@@", "-x", "+y") }),
    ).rejects.toThrow(/matched 2 locations/);
    expect(readFileSync(join(dir, "f.ts"), "utf8")).toBe("x\nx\n");
  });

  it("rejects a delete/update of a missing file and an escaping path", async () => {
    const dir = ws();
    await expect(
      applyPatchTool(dir).execute({ patch: patch("*** Delete File: nope.ts") }),
    ).rejects.toThrow(/no such file/);
    await expect(
      applyPatchTool(dir).execute({ patch: patch("*** Add File: ../escape.ts", "+x") }),
    ).rejects.toThrow(/escapes the workspace/);
  });

  it("rejects two actions touching the same path", async () => {
    const dir = ws();
    writeFileSync(join(dir, "f.ts"), "z\n");
    await expect(
      applyPatchTool(dir).execute({
        patch: patch("*** Delete File: f.ts", "*** Update File: f.ts", "@@", "-z", "+y"),
      }),
    ).rejects.toThrow(/touched by more than one action/);
  });
});

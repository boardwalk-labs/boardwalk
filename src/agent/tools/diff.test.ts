// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { createUnifiedDiff } from "./diff.js";

describe("createUnifiedDiff", () => {
  it("returns an empty diff for identical content", () => {
    expect(createUnifiedDiff("same\ntext", "same\ntext")).toEqual({
      diff: "",
      additions: 0,
      deletions: 0,
    });
  });

  it("renders a one-line change with surrounding context and a hunk header", () => {
    const out = createUnifiedDiff("a\nb\nc", "a\nB\nc");
    expect(out.diff).toBe(["@@ -1,3 +1,3 @@", " a", "-b", "+B", " c"].join("\n"));
    expect(out).toMatchObject({ additions: 1, deletions: 1 });
  });

  it("renders adding to an empty file as all-additions (old side 0,0)", () => {
    const out = createUnifiedDiff("", "x\ny");
    expect(out.diff).toBe(["@@ -0,0 +1,2 @@", "+x", "+y"].join("\n"));
    expect(out).toMatchObject({ additions: 2, deletions: 0 });
  });

  it("renders clearing a file as all-deletions (new side 0,0)", () => {
    const out = createUnifiedDiff("x\ny", "");
    expect(out.diff).toBe(["@@ -1,2 +0,0 @@", "-x", "-y"].join("\n"));
    expect(out).toMatchObject({ additions: 0, deletions: 2 });
  });

  it("shows only ±CONTEXT lines around an inserted line, not the whole file", () => {
    const before = Array.from({ length: 10 }, (_, i) => `L${String(i + 1)}`).join("\n");
    const after = before.replace("L5", "L5\nINSERTED");
    const out = createUnifiedDiff(before, after);
    expect(out).toMatchObject({ additions: 1, deletions: 0 });
    expect(out.diff).toContain("+INSERTED");
    // Context-bounded: distant lines (L1, L10) are not in the single hunk.
    expect(out.diff).toContain("@@");
    expect(out.diff).not.toContain("L1\n"); // first line is outside the context window
    expect(out.diff).not.toContain("L10");
  });

  it("splits two far-apart changes into separate hunks", () => {
    const before = Array.from({ length: 12 }, (_, i) => `L${String(i + 1)}`).join("\n");
    const after = before.replace("L1", "X1").replace("L12", "X12");
    const out = createUnifiedDiff(before, after);
    const headers = out.diff.split("\n").filter((l) => l.startsWith("@@"));
    expect(headers).toHaveLength(2);
    expect(out).toMatchObject({ additions: 2, deletions: 2 });
  });

  it("counts pure additions and deletions in a mixed change", () => {
    const out = createUnifiedDiff("keep\nremove1\nremove2\nkeep2", "keep\nadd1\nkeep2");
    expect(out.deletions).toBe(2);
    expect(out.additions).toBe(1);
  });

  it("handles a very large divergent region without hanging (coarse fallback)", () => {
    const before = Array.from({ length: 3000 }, (_, i) => `a${String(i)}`).join("\n");
    const after = Array.from({ length: 3000 }, (_, i) => `b${String(i)}`).join("\n");
    const out = createUnifiedDiff(before, after);
    // Every line differs → coarse block: all deleted, all added.
    expect(out.deletions).toBe(3000);
    expect(out.additions).toBe(3000);
  });
});

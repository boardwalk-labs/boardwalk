// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadAgentsMd } from "./agents_md.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "bw-agents-md-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Write a file under `dir`, creating parent directories. Path is `/`-separated, relative to dir. */
function plant(dir: string, relPath: string, content: string): void {
  const full = join(dir, ...relPath.split("/"));
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, "utf8");
}

describe("loadAgentsMd — discovery", () => {
  it("returns '' when the workspace has no AGENTS.md", () => {
    const dir = workspace();
    plant(dir, "src/index.ts", "export const x = 1;");
    expect(loadAgentsMd(dir)).toBe("");
  });

  it("loads the root AGENTS.md as a labeled block tagged with its relative path", () => {
    const dir = workspace();
    plant(dir, "AGENTS.md", "Use 2-space indent.");
    const out = loadAgentsMd(dir);
    expect(out).toBe('<AGENTS.md path="AGENTS.md">\nUse 2-space indent.\n</AGENTS.md>');
  });

  it("loads root + nested files, root first then nested, sorted by path", () => {
    const dir = workspace();
    plant(dir, "AGENTS.md", "root rules");
    plant(dir, "packages/api/AGENTS.md", "api rules");
    plant(dir, "packages/web/AGENTS.md", "web rules");
    const out = loadAgentsMd(dir);

    // All three present, each labeled with its workspace-relative POSIX path.
    expect(out).toContain('<AGENTS.md path="AGENTS.md">\nroot rules\n</AGENTS.md>');
    expect(out).toContain('<AGENTS.md path="packages/api/AGENTS.md">\napi rules\n</AGENTS.md>');
    expect(out).toContain('<AGENTS.md path="packages/web/AGENTS.md">\nweb rules\n</AGENTS.md>');
    // Root precedes the nested ones, and the nested ones are in path order.
    const order = ["AGENTS.md", "packages/api/AGENTS.md", "packages/web/AGENTS.md"].map((p) =>
      out.indexOf(`path="${p}"`),
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("skips node_modules, .git, dist/build, and dotdirs", () => {
    const dir = workspace();
    plant(dir, "AGENTS.md", "root");
    for (const skipped of [
      "node_modules/pkg/AGENTS.md",
      ".git/AGENTS.md",
      "dist/AGENTS.md",
      "build/AGENTS.md",
      ".next/AGENTS.md",
      "coverage/AGENTS.md",
      "vendor/AGENTS.md",
      ".hidden/AGENTS.md",
    ]) {
      plant(dir, skipped, `SHOULD-NOT-LOAD-${skipped}`);
    }
    const out = loadAgentsMd(dir);
    expect(out).toContain("root");
    expect(out).not.toContain("SHOULD-NOT-LOAD");
  });

  it("matches the filename AGENTS.md exactly (not agents.md / AGENT.md / AGENTS.markdown)", () => {
    const dir = workspace();
    plant(dir, "agents.md", "lowercase");
    plant(dir, "AGENT.md", "singular");
    plant(dir, "AGENTS.markdown", "wrong ext");
    expect(loadAgentsMd(dir)).toBe("");
  });
});

describe("loadAgentsMd — bounds", () => {
  it("caps the number of files at 16, preferring the shallowest", () => {
    const dir = workspace();
    plant(dir, "AGENTS.md", "ROOT-KEEP");
    // 20 nested files, one level down — only 15 of these should join the root (16 total).
    for (let i = 0; i < 20; i++) {
      plant(dir, `dir${String(i).padStart(2, "0")}/AGENTS.md`, `NESTED-${String(i)}`);
    }
    const out = loadAgentsMd(dir);
    const count = [...out.matchAll(/<AGENTS\.md path=/g)].length;
    expect(count).toBe(16);
    // The root (shallowest) is always kept.
    expect(out).toContain("ROOT-KEEP");
  });

  it("prefers shallow files over deep ones when over the file cap", () => {
    const dir = workspace();
    // 16 shallow files fill the cap; a deep one must be dropped (breadth-first by depth).
    for (let i = 0; i < 16; i++) {
      plant(dir, `top${String(i).padStart(2, "0")}/AGENTS.md`, `SHALLOW-${String(i)}`);
    }
    plant(dir, "a/b/c/AGENTS.md", "DEEP-SHOULD-DROP");
    const out = loadAgentsMd(dir);
    expect([...out.matchAll(/<AGENTS\.md path=/g)]).toHaveLength(16);
    expect(out).not.toContain("DEEP-SHOULD-DROP");
  });

  it("truncates a file over the per-file cap and notes the truncation", () => {
    const dir = workspace();
    const big = "x".repeat(40 * 1024); // > 32 KB per-file cap
    plant(dir, "AGENTS.md", big);
    const out = loadAgentsMd(dir);
    expect(out).toContain("[truncated: AGENTS.md exceeded 32768 bytes]");
    // It was actually clipped: the rendered block is well under the original size.
    expect(out.length).toBeLessThan(big.length);
  });

  it("respects the total-size budget across many files", () => {
    const dir = workspace();
    // Five ~32 KB files = ~160 KB raw, over the ~128 KB total cap: the rendered output is bounded.
    for (let i = 0; i < 5; i++) {
      plant(dir, `p${String(i)}/AGENTS.md`, "y".repeat(32 * 1024));
    }
    const out = loadAgentsMd(dir);
    // Total content stays within the 128 KB budget (plus the small wrapper/label overhead).
    expect(out.length).toBeLessThan(128 * 1024 + 16 * 256);
  });

  it("does not descend past the depth bound", () => {
    const dir = workspace();
    // Depth 0 = root; build a chain to depth 7 (one past MAX_DEPTH = 6).
    plant(dir, "a/b/c/d/e/f/AGENTS.md", "AT-DEPTH-6");
    plant(dir, "a/b/c/d/e/f/g/AGENTS.md", "AT-DEPTH-7-SHOULD-DROP");
    const out = loadAgentsMd(dir);
    expect(out).toContain("AT-DEPTH-6");
    expect(out).not.toContain("AT-DEPTH-7-SHOULD-DROP");
  });
});

describe("loadAgentsMd — containment", () => {
  it("cannot reach a file outside the workspace via a symlinked directory", () => {
    const outside = workspace();
    plant(outside, "AGENTS.md", "OUTSIDE-SECRET");
    const dir = workspace();
    plant(dir, "AGENTS.md", "inside-root");
    // A symlinked dir pointing out of the workspace must NOT be followed.
    try {
      symlinkSync(outside, join(dir, "linked"), "dir");
    } catch {
      return; // symlink creation unsupported on this platform — nothing to assert
    }
    const out = loadAgentsMd(dir);
    expect(out).toContain("inside-root");
    expect(out).not.toContain("OUTSIDE-SECRET");
  });
});

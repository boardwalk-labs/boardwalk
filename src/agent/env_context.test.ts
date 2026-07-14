// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildEnvContext, workspaceOrientation } from "./env_context.js";

const SUNDAY = new Date("2026-06-21T23:30:00.000Z");

describe("buildEnvContext", () => {
  it("renders a coarse UTC date with weekday, wrapped in an <env> block", () => {
    const out = buildEnvContext(SUNDAY, { hasClock: false });
    expect(out).toBe("<env>\nToday's date is Sunday, 2026-06-21 (UTC).\n</env>");
  });

  it("points at the clock tool only when it is present", () => {
    expect(buildEnvContext(SUNDAY, { hasClock: true })).toContain("use the `clock` tool");
    expect(buildEnvContext(SUNDAY, { hasClock: false })).not.toContain("clock");
  });

  it("uses the UTC calendar day even when the instant is late-night in other zones", () => {
    // 23:30Z is still the 21st in UTC (the 22nd in Tokyo) — the block reports the UTC day.
    expect(buildEnvContext(SUNDAY, { hasClock: false })).toContain("2026-06-21");
  });

  it("is a single content line without a workspace (cheap, cache-stable) — no time-of-day", () => {
    const out = buildEnvContext(SUNDAY, { hasClock: true });
    // Exactly one line between the <env> tags, and no HH:MM (would imply false precision + churn).
    const inner = out.replace("<env>\n", "").replace("\n</env>", "");
    expect(inner.includes("\n")).toBe(false);
    expect(/\d\d:\d\d/.test(out)).toBe(false);
  });

  it("adds the workspace-orientation line when a snapshot is provided", () => {
    const out = buildEnvContext(SUNDAY, {
      hasClock: false,
      workspace: { entries: ["repo/", "README.md"], more: 0 },
    });
    expect(out).toContain(
      "The workspace root contains: repo/, README.md — file paths in tool calls are workspace-relative.",
    );
  });

  it("folds entries beyond the cap into a +N more note", () => {
    const out = buildEnvContext(SUNDAY, {
      hasClock: false,
      workspace: { entries: ["a/", "b/"], more: 12 },
    });
    expect(out).toContain("a/, b/, …(+12 more)");
  });

  it("says so when the workspace is empty (still orients: paths are workspace-relative)", () => {
    const out = buildEnvContext(SUNDAY, { hasClock: false, workspace: { entries: [], more: 0 } });
    expect(out).toContain("The workspace is empty.");
    expect(out).toContain("workspace-relative");
  });

  it("omits the workspace line entirely for a null snapshot (no fs tools / unreadable root)", () => {
    const out = buildEnvContext(SUNDAY, { hasClock: false, workspace: null });
    expect(out).not.toContain("workspace");
  });
});

describe("workspaceOrientation", () => {
  it("snapshots sorted top-level entries, marking directories with a trailing slash", () => {
    const dir = mkdtempSync(join(tmpdir(), "bw-env-ws-"));
    try {
      mkdirSync(join(dir, "sub"));
      writeFileSync(join(dir, "file.txt"), "x", "utf8");
      expect(workspaceOrientation(dir)).toEqual({ entries: ["file.txt", "sub/"], more: 0 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("caps the entry list and counts the remainder", () => {
    const dir = mkdtempSync(join(tmpdir(), "bw-env-ws-"));
    try {
      for (let i = 0; i < 35; i++) writeFileSync(join(dir, `f${String(i).padStart(2, "0")}`), "");
      const ws = workspaceOrientation(dir);
      expect(ws?.entries).toHaveLength(30);
      expect(ws?.more).toBe(5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null for an unreadable root (best-effort, never a failure)", () => {
    expect(workspaceOrientation("/no/such/dir/exists")).toBeNull();
  });
});

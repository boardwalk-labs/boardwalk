// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildToolSet } from "./tools.js";

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
});

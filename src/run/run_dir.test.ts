// SPDX-License-Identifier: Apache-2.0

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bundledAgentsMdPath, packageRoot, skillsDirOf, writePackage } from "./run_dir.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "bw-run-dir-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Build a source skills/ tree (folder-per-skill + resources) and return its path. */
function sourceSkills(tree: Record<string, Record<string, string>>): string {
  const root = join(tempDir(), "skills");
  for (const [name, files] of Object.entries(tree)) {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    for (const [file, content] of Object.entries(files))
      writeFileSync(join(dir, file), content, "utf8");
  }
  return root;
}

describe("writePackage", () => {
  it("copies the skills/ subtree (folder-per-skill + non-.md resources) into the package root", () => {
    const dataDir = tempDir();
    const skillsSourceDir = sourceSkills({
      reviewer: { "SKILL.md": "review body", "checklist.md": "1) parameterize" },
    });
    const root = writePackage(dataDir, "wf_1", { skillsSourceDir });

    expect(root).toBe(packageRoot(dataDir, "wf_1"));
    const skills = skillsDirOf(root);
    expect(readFileSync(join(skills, "reviewer", "SKILL.md"), "utf8")).toBe("review body");
    expect(readFileSync(join(skills, "reviewer", "checklist.md"), "utf8")).toBe("1) parameterize");
  });

  it("replaces the package wholesale on redeploy (drops a removed skill folder)", () => {
    const dataDir = tempDir();
    writePackage(dataDir, "wf_1", {
      skillsSourceDir: sourceSkills({
        reviewer: { "SKILL.md": "a" },
        deployer: { "SKILL.md": "b" },
      }),
    });
    // Redeploy with only `reviewer`: the stale `deployer` folder must be gone.
    const root = writePackage(dataDir, "wf_1", {
      skillsSourceDir: sourceSkills({ reviewer: { "SKILL.md": "a2" } }),
    });
    const skills = skillsDirOf(root);
    expect(readFileSync(join(skills, "reviewer", "SKILL.md"), "utf8")).toBe("a2");
    expect(existsSync(join(skills, "deployer"))).toBe(false);
  });

  it("writes the bundled AGENTS.md and tolerates a package with no skills", () => {
    const dataDir = tempDir();
    const root = writePackage(dataDir, "wf_1", { agentsMd: "standing rules" });
    expect(readFileSync(bundledAgentsMdPath(root), "utf8")).toBe("standing rules");
    expect(existsSync(skillsDirOf(root))).toBe(false);
  });
});

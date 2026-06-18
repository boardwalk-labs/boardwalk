// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EngineError } from "../errors.js";
import {
  listSkillFiles,
  loadSkillBody,
  loadSkillCatalogEntry,
  loadSkillResource,
  parseSkillFrontmatter,
} from "./skills.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

/** A temp skills/ dir with one folder-per-skill written into it; returns the skills dir path. */
function skillsDirWith(name: string, skillMd: string, files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "bw-skills-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), skillMd, "utf8");
  for (const [file, content] of Object.entries(files))
    writeFileSync(join(dir, file), content, "utf8");
  return root;
}

describe("parseSkillFrontmatter", () => {
  it("parses name + description and returns the body after the fence", () => {
    const fm = parseSkillFrontmatter(
      "---\nname: reviewer\ndescription: Review PRs\n---\nThe body.",
    );
    expect(fm).toEqual({ name: "reviewer", description: "Review PRs", body: "The body." });
  });

  it("treats a file with no fence as all body", () => {
    const fm = parseSkillFrontmatter("# Just markdown\nno frontmatter here");
    expect(fm.name).toBeUndefined();
    expect(fm.description).toBeUndefined();
    expect(fm.body).toBe("# Just markdown\nno frontmatter here");
  });

  it("treats an unterminated fence as all body (not frontmatter)", () => {
    const fm = parseSkillFrontmatter("---\nname: reviewer\nno closing fence");
    expect(fm.name).toBeUndefined();
    expect(fm.body).toBe("---\nname: reviewer\nno closing fence");
  });

  it("strips one layer of matching quotes and ignores unknown keys", () => {
    const fm = parseSkillFrontmatter(
      `---\nname: "reviewer"\ndescription: 'Review a PR'\nallowed-tools: Bash\n---\nbody`,
    );
    expect(fm.name).toBe("reviewer");
    expect(fm.description).toBe("Review a PR");
    expect(fm.body).toBe("body");
  });

  it("tolerates CRLF line endings", () => {
    const fm = parseSkillFrontmatter(
      "---\r\nname: reviewer\r\ndescription: x\r\n---\r\nbody\r\nmore",
    );
    expect(fm.name).toBe("reviewer");
    expect(fm.description).toBe("x");
    expect(fm.body).toBe("body\nmore");
  });
});

describe("loadSkillCatalogEntry", () => {
  it("returns name + description from frontmatter", () => {
    const dir = skillsDirWith("reviewer", "---\ndescription: Review PRs\n---\nbody");
    expect(loadSkillCatalogEntry(dir, "reviewer")).toEqual({
      name: "reviewer",
      description: "Review PRs",
    });
  });

  it("falls back to the first prose line when frontmatter omits a description", () => {
    const dir = skillsDirWith("reviewer", "# Heading\n\nDo the thing carefully.\nmore");
    expect(loadSkillCatalogEntry(dir, "reviewer").description).toBe("Do the thing carefully.");
  });

  it("falls back to (no description) for an empty body and no frontmatter", () => {
    const dir = skillsDirWith("reviewer", "");
    expect(loadSkillCatalogEntry(dir, "reviewer").description).toBe("(no description)");
  });

  it("throws a valid-name error for a malformed name", () => {
    const dir = skillsDirWith("reviewer", "---\ndescription: x\n---\nbody");
    expect(() => loadSkillCatalogEntry(dir, "../etc/passwd")).toThrow(/not a valid skill name/);
  });

  it("throws when no skills were deployed (null dir)", () => {
    expect(() => loadSkillCatalogEntry(null, "reviewer")).toThrow(/no skills were deployed/);
  });

  it("throws a missing-skill error naming the folder layout", () => {
    const dir = skillsDirWith("reviewer", "---\ndescription: x\n---\nbody");
    expect(() => loadSkillCatalogEntry(dir, "ghost")).toThrow(/no skills\/ghost\/SKILL\.md/);
  });

  it("throws a migration hint when a leftover flat skills/<name>.md exists", () => {
    const dir = skillsDirWith("reviewer", "---\ndescription: x\n---\nbody");
    writeFileSync(join(dir, "legacy.md"), "old", "utf8");
    try {
      loadSkillCatalogEntry(dir, "legacy");
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(EngineError);
      expect((e as EngineError).message).toMatch(/old flat layout/);
    }
  });
});

describe("loadSkillBody", () => {
  it("returns the trimmed body", () => {
    const dir = skillsDirWith("reviewer", "---\ndescription: x\n---\n  The full procedure.  ");
    expect(loadSkillBody(dir, "reviewer")).toBe("The full procedure.");
  });
});

describe("listSkillFiles + loadSkillResource", () => {
  it("lists bundled resource files (excluding SKILL.md), sorted", () => {
    const dir = skillsDirWith("reviewer", "---\ndescription: x\n---\nbody", {
      "checklist.md": "a",
      "template.txt": "b",
    });
    expect(listSkillFiles(dir, "reviewer")).toEqual(["checklist.md", "template.txt"]);
  });

  it("reads a bundled resource file by name", () => {
    const dir = skillsDirWith("reviewer", "---\ndescription: x\n---\nbody", {
      "checklist.md": "RESOURCE-CONTENT",
    });
    expect(loadSkillResource(dir, "reviewer", "checklist.md")).toBe("RESOURCE-CONTENT");
  });

  it("rejects a resource path that escapes the skill folder", () => {
    const dir = skillsDirWith("reviewer", "---\ndescription: x\n---\nbody");
    expect(() => loadSkillResource(dir, "reviewer", "../../etc/passwd")).toThrow(
      /escapes the "reviewer" skill folder/,
    );
  });

  it("throws for a missing resource file", () => {
    const dir = skillsDirWith("reviewer", "---\ndescription: x\n---\nbody");
    expect(() => loadSkillResource(dir, "reviewer", "nope.txt")).toThrow(/no bundled file/);
  });
});

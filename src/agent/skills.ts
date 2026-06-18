// SPDX-License-Identifier: Apache-2.0

// Agent Skills — folder-per-skill with progressive disclosure.
//
// An author pins the skills a leaf may use via `agent({ skills: [...] })`. Each named skill is a
// directory `skills/<name>/SKILL.md` (deployed alongside the program) with YAML frontmatter
// (`name`, `description`) and a markdown body, plus any bundled resource files beside it. Rather
// than eager-inject every body, the leaf sees a compact CATALOG (name + description) and loads a
// skill's full instructions ON DEMAND via the built-in `skill` tool — which can also return a
// bundled resource file from the skill's own folder. This keeps the standing context small while
// the procedure detail (and its reference files) is one tool call away — progressive disclosure.
//
// This module is the pure filesystem + parsing half (no tool/loop dependency); `tools.ts` wires the
// catalog block and the `skill` tool on top. Resource reads are path-contained to the skill folder
// (a skill name + file are runtime input, treated as untrusted).

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { EngineError } from "../errors.js";

/** A skill name is also a directory name — keep it filesystem-safe before touching disk. */
export const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** Caps so a hostile or sprawling file can't blow the context window (mirrors the AGENTS.md loader's
 *  bounds): a short cap on the catalog description, a generous one on a loaded body/resource. */
const MAX_DESCRIPTION_BYTES = 500;
const MAX_BODY_BYTES = 64 * 1024;

export interface SkillFrontmatter {
  name?: string;
  description?: string;
  /** Everything after the closing frontmatter fence (or the whole file when there is no fence). */
  body: string;
}

/**
 * Parse a SKILL.md into its frontmatter fields + body. Tolerant by design: a file that does not
 * open with a `---` fence is treated as all body (no metadata). Within the fence only the
 * recognized scalar keys (`name`, `description`) are read — one layer of matching surrounding
 * quotes is stripped; every other key (including `allowed-tools` and any multi-line/array YAML)
 * is ignored. This is deliberately a minimal frontmatter reader, not a YAML engine: the two fields
 * we honor are simple one-line strings.
 */
export function parseSkillFrontmatter(text: string): SkillFrontmatter {
  // Normalize CRLF so the fence + line logic is platform-stable.
  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { body: normalized };
  }
  // The closing fence is a `\n---` after the opening fence; the body begins after that fence line.
  const close = normalized.indexOf("\n---", 3);
  if (close === -1) {
    // An unterminated fence isn't frontmatter — treat the whole file as body.
    return { body: normalized };
  }
  const block = normalized.slice(4, close);
  const afterFence = normalized.indexOf("\n", close + 1);
  const body = afterFence === -1 ? "" : normalized.slice(afterFence + 1);

  const out: SkillFrontmatter = { body };
  for (const line of block.split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    if (key !== "name" && key !== "description") continue;
    out[key] = stripQuotes(line.slice(colon + 1).trim());
  }
  return out;
}

function stripQuotes(value: string): string {
  const first = value[0];
  if (value.length >= 2 && (first === '"' || first === "'") && value.endsWith(first)) {
    return value.slice(1, -1);
  }
  return value;
}

/** The validated deploy folder for a pinned skill (its SKILL.md must exist). Throws a loud,
 *  actionable error when the name is invalid or the skill/SKILL.md is absent — a pinned skill MUST
 *  resolve (never silently degrade); a leftover flat `skills/<name>.md` gets a migration hint. */
function skillFolder(skillsDir: string | null, name: string): string {
  if (!SKILL_NAME_RE.test(name)) {
    throw new EngineError("VALIDATION", `Skill name "${name}" is not a valid skill name.`);
  }
  if (skillsDir === null) {
    throw new EngineError(
      "VALIDATION",
      `agent() selected skill "${name}" but no skills were deployed with this workflow.`,
      `Deploy the workflow with a skills/${name}/SKILL.md file alongside the program.`,
    );
  }
  const dir = join(skillsDir, name);
  if (existsSync(join(dir, "SKILL.md"))) return dir;
  // A leftover flat layout is the likeliest mistake — name the migration explicitly.
  if (existsSync(join(skillsDir, `${name}.md`))) {
    throw new EngineError(
      "VALIDATION",
      `Skill "${name}" uses the old flat layout skills/${name}.md.`,
      `Move it to skills/${name}/SKILL.md (folder-per-skill, with optional bundled resources beside it).`,
    );
  }
  throw new EngineError(
    "VALIDATION",
    `agent() selected skill "${name}" but no skills/${name}/SKILL.md was deployed with this workflow.`,
    `Deploy the workflow with a skills/${name}/SKILL.md file alongside the program.`,
  );
}

/** One catalog row (name + short description) for a pinned skill. Validates the skill resolves NOW,
 *  so a missing/misnamed skill fails when the tool set is built — before any model call. */
export function loadSkillCatalogEntry(
  skillsDir: string | null,
  name: string,
): { name: string; description: string } {
  const fm = parseSkillFrontmatter(
    readFileSync(join(skillFolder(skillsDir, name), "SKILL.md"), "utf8"),
  );
  const trimmed = fm.description?.trim();
  const description = trimmed !== undefined && trimmed !== "" ? trimmed : firstProseLine(fm.body);
  return { name, description: clip(description || "(no description)", MAX_DESCRIPTION_BYTES) };
}

/** The full SKILL.md body for a pinned skill, loaded on demand by the `skill` tool. */
export function loadSkillBody(skillsDir: string | null, name: string): string {
  const fm = parseSkillFrontmatter(
    readFileSync(join(skillFolder(skillsDir, name), "SKILL.md"), "utf8"),
  );
  return clip(fm.body.trim(), MAX_BODY_BYTES);
}

/** Names of the bundled resource files beside a skill's SKILL.md (top-level files only, sorted). */
export function listSkillFiles(skillsDir: string | null, name: string): string[] {
  const dir = skillFolder(skillsDir, name);
  return readdirSync(dir)
    .filter((entry) => entry !== "SKILL.md" && isFile(join(dir, entry)))
    .sort();
}

/** Read a bundled resource file from a skill's folder, contained to that folder (untrusted input). */
export function loadSkillResource(skillsDir: string | null, name: string, file: string): string {
  const dir = skillFolder(skillsDir, name);
  const candidate = resolve(dir, file);
  if (candidate !== dir && !candidate.startsWith(dir + sep)) {
    throw new EngineError("VALIDATION", `Skill file "${file}" escapes the "${name}" skill folder.`);
  }
  if (!isFile(candidate)) {
    throw new EngineError("VALIDATION", `Skill "${name}" has no bundled file "${file}".`);
  }
  return clip(readFileSync(candidate, "utf8"), MAX_BODY_BYTES);
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** First non-empty, non-heading line of a body — a description fallback when frontmatter omits one. */
function firstProseLine(body: string): string {
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (trimmed !== "" && !trimmed.startsWith("#")) return trimmed;
  }
  return "";
}

/** Clip to at most `maxBytes` UTF-8 bytes on a char boundary (same idiom as the AGENTS.md loader). */
function clip(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let content = text.slice(0, maxBytes);
  while (Buffer.byteLength(content, "utf8") > maxBytes) content = content.slice(0, -1);
  return content;
}

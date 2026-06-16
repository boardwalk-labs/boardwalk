// SPDX-License-Identifier: Apache-2.0

// AGENTS.md auto-load — project context for the agent() leaf.
//
// The widely-adopted convention (OpenAI Codex, opencode, Cursor): a coding agent auto-discovers
// `AGENTS.md` files in its working directory and reads them into context, so a repo can hand the
// agent project-specific instructions with no per-call wiring. Boardwalk honors it default-on:
// every agent() leaf, when it runs, discovers the workflow's AGENTS.md files and prepends them to
// the leaf's context preamble (the same channel skills use). No AGENTS.md ⇒ nothing is added.
//
// TWO tiers, mirroring the convention's general→specific hierarchy (a global/standing file, then the
// repo root, then nested) — exactly how Codex/opencode layer a global config file over a walked repo:
//   1. BUNDLED — the SINGLE AGENTS.md at the workflow PACKAGE root (alongside the program + skills/).
//      The author's standing instructions, read by every agent() in the workflow regardless of what
//      the run cloned into its workspace. Lives at `<programDir>/AGENTS.md`. It is the root file ONLY
//      — a bundled workflow has no meaningful runtime subtree (the program is one inlined module, and
//      package source like `lib/foo.ts` is bundled away), so a nested AGENTS.md in the package would
//      describe source that no longer exists at run time. Reading just the root file also makes this
//      tier identical on every engine: `boardwalk dev` writes one file at the package root, and the
//      hosted platform extracts one at the artifact root — same bytes, same single read.
//   2. WORKSPACE — an AGENTS.md the run produced (e.g. a codebase it cloned into /workspace), root
//      PLUS nested subtree files (the repo hierarchy). Lives under `workspaceDir`.
// Blocks are concatenated BUNDLED first, then WORKSPACE (general→specific). The two roots are always
// distinct directories in the engine (the package dir is shared across runs; the workspace is the
// per-run isolated dir), but we DEDUP by absolute realpath defensively so an embedder that wires the
// same dir for both can never emit a file twice.
//
// Trust model: this is just a filesystem read — the content goes into model context exactly like a
// skill or a tool result, so the loop's existing prompt redaction scrubs it before any model call.
// Each walk is confined to its root (model-untrusted paths never escape it) and the COMBINED set is
// BOUNDED on file count, per-file size, and total size, so re-reading per leaf stays cheap and a
// hostile or sprawling tree can't blow up the context window.

import { realpathSync, type Dirent, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** The convention's exact spelling — matched case-sensitively, like the tools that read it. */
const AGENTS_MD_FILENAME = "AGENTS.md";

/** Directories never worth walking for project context (build output, VCS, deps, any dotdir). */
const SKIP_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
  "vendor",
]);

/** Bounds — generous for real repos, tight enough that re-reading per leaf is cheap. Applied across
 *  the COMBINED bundled+workspace set, not per root. */
const MAX_DEPTH = 6;
const MAX_FILES = 16;
const MAX_FILE_BYTES = 32 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024;

/** Which tier a discovered file came from — the label the model sees (`source="…"`). */
type AgentsMdSource = "workflow" | "workspace";

interface DiscoveredFile {
  /** Which tier (bundled package vs. run workspace) the file came from. */
  source: AgentsMdSource;
  /** Root-relative POSIX-ish path (the label the model sees), root first then nested. */
  relPath: string;
  content: string;
  /** True when the file was clipped to MAX_FILE_BYTES (a note is rendered in its place). */
  truncated: boolean;
}

/** A root being read: the directory plus the source tier its files are tagged with. */
interface Root {
  dir: string;
  source: AgentsMdSource;
}

/**
 * Render the workflow's AGENTS.md project context as one preamble block, or "" when there is none.
 *
 * Two tiers, concatenated general→specific: the BUNDLED package's standing instructions (the single
 * `<programDir>/AGENTS.md`, read first) then the run WORKSPACE (`workspaceDir` — root plus nested
 * subtree files, in path order). The bundled tier is the root file ONLY; nested discovery is a
 * workspace concern (a cloned repo legitimately has a hierarchy; a bundled package does not). The
 * combined set honors every bound, the bundled file claiming the budget first. A file reachable from
 * both roots (the defensive same-dir case) is emitted once. The caller prepends the result to the
 * leaf's preamble BEFORE skills — project rules frame the task; skills are the procedure. Returns ""
 * so an empty result splices cleanly into the preamble array (no blank block).
 */
export function loadAgentsMd(workspaceDir: string, programDir?: string): string {
  const budget: Budget = { count: 0, bytes: 0, seen: new Set() };
  const blocks: DiscoveredFile[] = [];

  // BUNDLED tier (general): the single root AGENTS.md in the workflow package — the author's standing
  // instructions, claiming the shared budget first.
  if (programDir !== undefined) {
    const bundled = readRootAgentsMd(programDir, "workflow", budget);
    if (bundled !== null) blocks.push(bundled);
  }
  // WORKSPACE tier (specific): the run's workspace, root + nested, drawing on whatever budget remains.
  blocks.push(...walkRoot({ dir: workspaceDir, source: "workspace" }, budget));

  if (blocks.length === 0) return "";
  return blocks.map(renderBlock).join("\n\n");
}

function renderBlock(file: DiscoveredFile): string {
  const body = file.truncated
    ? `${file.content}\n[truncated: AGENTS.md exceeded ${String(MAX_FILE_BYTES)} bytes]`
    : file.content;
  return `<AGENTS.md source="${file.source}" path="${file.relPath}">\n${body}\n</AGENTS.md>`;
}

/** Running state shared across the per-root walks so the caps span the COMBINED bundled+workspace set. */
interface Budget {
  /** Files accepted so far, across all roots (the MAX_FILES cap). */
  count: number;
  /** Bytes of content accepted so far, across all roots (the MAX_TOTAL_BYTES cap). */
  bytes: number;
  /** Absolute realpaths already accepted — dedup across roots (the `dev` same-dir case). */
  seen: Set<string>;
}

/**
 * Read the SINGLE root `<dir>/AGENTS.md` (the bundled tier's standing instructions), bounded and
 * deduped against the shared budget. Returns null when it is absent/unreadable, already seen (the
 * defensive same-dir case), or there is no budget left — project context is best-effort, never a
 * reason to fail a run.
 */
function readRootAgentsMd(
  dir: string,
  source: AgentsMdSource,
  budget: Budget,
): DiscoveredFile | null {
  if (budget.count >= MAX_FILES) return null;
  const full = join(dir, AGENTS_MD_FILENAME);
  // Dedup by realpath BEFORE reading: the same file reachable from two roots costs nothing.
  const real = realpathOrNull(full);
  if (real !== null && budget.seen.has(real)) return null;
  const file = readBounded({ dir, source }, full, MAX_TOTAL_BYTES - budget.bytes);
  if (file === null) return null;
  if (real !== null) budget.seen.add(real);
  budget.count += 1;
  budget.bytes += Buffer.byteLength(file.content, "utf8");
  return file;
}

/** Breadth-first walk of ONE root, root-first then nested by path, drawing on the shared budget. */
function walkRoot(root: Root, budget: Budget): DiscoveredFile[] {
  const found: DiscoveredFile[] = [];

  // Breadth-first: each frontier level is one directory depth. Shallower AGENTS.md files (closer to
  // the root, more relevant) are collected first, so the MAX_FILES cap drops the deepest ones.
  let frontier: string[] = [root.dir];
  for (let depth = 0; depth <= MAX_DEPTH && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const dir of frontier) {
      let entries: Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue; // unreadable directory — skip it, never fail the run on project context
      }
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!isSkippedDir(entry.name)) next.push(full);
          continue;
        }
        if (entry.name !== AGENTS_MD_FILENAME) continue;
        if (budget.count >= MAX_FILES) continue;
        // Dedup by realpath BEFORE reading: the same file reachable from two roots costs nothing.
        const real = realpathOrNull(full);
        if (real !== null && budget.seen.has(real)) continue;
        const file = readBounded(root, full, MAX_TOTAL_BYTES - budget.bytes);
        if (file === null) continue; // unreadable, escapes the root, or no budget left
        if (real !== null) budget.seen.add(real);
        budget.count += 1;
        budget.bytes += Buffer.byteLength(file.content, "utf8");
        found.push(file);
      }
    }
    frontier = next;
  }

  // Root first, then nested by path — stable, deterministic order regardless of readdir ordering.
  found.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return found;
}

/** Resolve a path to its absolute realpath for dedup; null when it can't be resolved (skip dedup). */
function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** A dotdir or a named build/VCS/dependency dir — never walked for project context. */
function isSkippedDir(name: string): boolean {
  return name.startsWith(".") || SKIP_DIRS.has(name);
}

/**
 * Read one AGENTS.md, clipped to the per-file cap AND whatever remains of the total budget. Returns
 * null when the file escapes its root (defense in depth — the walk only descends into it), is
 * unreadable, or there is no remaining budget. The root-relative path uses forward slashes so the
 * rendered label is platform-stable.
 */
function readBounded(root: Root, fullPath: string, remainingTotal: number): DiscoveredFile | null {
  if (remainingTotal <= 0) return null;
  const rel = relative(root.dir, fullPath);
  // Confine to the root: a `..` segment means the path climbed out (only reachable via a
  // symlinked dir, which the walk doesn't follow — kept as a hard backstop).
  if (rel === "" || rel.startsWith("..") || rel.includes(`..${sep}`)) return null;
  let raw: string;
  try {
    raw = readFileSync(fullPath, "utf8");
  } catch {
    return null;
  }
  const cap = Math.min(MAX_FILE_BYTES, remainingTotal);
  const clipped = clip(raw, cap);
  return {
    source: root.source,
    relPath: rel.split(sep).join("/"),
    content: clipped.content,
    truncated: clipped.truncated,
  };
}

/** Clip `text` to at most `maxBytes` UTF-8 bytes on a char boundary, flagging truncation. */
function clip(text: string, maxBytes: number): { content: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return { content: text, truncated: false };
  // Walk back from a length over-estimate by whole characters (Buffer.subarray could split a
  // multi-byte char): a char is at most 4 UTF-8 bytes, so maxBytes chars is a safe upper bound.
  let content = text.slice(0, maxBytes);
  while (Buffer.byteLength(content, "utf8") > maxBytes) {
    content = content.slice(0, -1);
  }
  return { content, truncated: true };
}

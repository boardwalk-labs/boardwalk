// SPDX-License-Identifier: Apache-2.0

// AGENTS.md auto-load — project context for the agent() leaf.
//
// The widely-adopted convention (OpenAI Codex, opencode, Cursor): a coding agent auto-discovers
// `AGENTS.md` files in its working directory and reads them into context, so a repo can hand the
// agent project-specific instructions with no per-call wiring. Boardwalk honors it default-on:
// every agent() leaf, when it runs, discovers the workspace's AGENTS.md files and prepends them to
// the leaf's context preamble (the same channel skills use). No AGENTS.md ⇒ nothing is added.
//
// Trust model: this is just a workspace read — the content goes into model context exactly like a
// skill or a tool result, so the loop's existing prompt redaction scrubs it before any model call.
// The walk is confined to the workspace (model-untrusted paths never escape it) and BOUNDED on file
// count, per-file size, and total size, so re-reading per leaf stays cheap and a hostile or sprawling
// tree can't blow up the context window.

import { type Dirent, readdirSync, readFileSync } from "node:fs";
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

/** Bounds — generous for real repos, tight enough that re-reading per leaf is cheap. */
const MAX_DEPTH = 6;
const MAX_FILES = 16;
const MAX_FILE_BYTES = 32 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024;

interface DiscoveredFile {
  /** Workspace-relative POSIX-ish path (the label the model sees), root first then nested. */
  relPath: string;
  content: string;
  /** True when the file was clipped to MAX_FILE_BYTES (a note is rendered in its place). */
  truncated: boolean;
}

/**
 * Render the workspace's AGENTS.md project context as one preamble block, or "" when there is none.
 *
 * Each file becomes a labeled block tagged with its workspace-relative path, root first then nested
 * (sorted by path so the order is stable): `<AGENTS.md path="AGENTS.md">…</AGENTS.md>`. The caller
 * prepends the result to the leaf's preamble BEFORE skills — project rules frame the task; skills are
 * the procedure. Returns "" so an empty result splices cleanly into the preamble array (no blank block).
 */
export function loadAgentsMd(workspaceDir: string): string {
  const files = discoverAgentsMd(workspaceDir);
  if (files.length === 0) return "";
  return files.map(renderBlock).join("\n\n");
}

function renderBlock(file: DiscoveredFile): string {
  const body = file.truncated
    ? `${file.content}\n[truncated: AGENTS.md exceeded ${String(MAX_FILE_BYTES)} bytes]`
    : file.content;
  return `<AGENTS.md path="${file.relPath}">\n${body}\n</AGENTS.md>`;
}

/**
 * Walk `workspaceDir` for AGENTS.md files, honoring every bound. The walk is breadth-first by depth
 * so the shallowest (most relevant) files win the file-count cap; results are sorted by path with the
 * root file first. Symlinked dirs are not followed (statSync is lexical here, and the workspace is the
 * containment boundary — the built-in tools can't create a symlink that points out). Unreadable
 * entries are skipped silently: project context is best-effort, never a reason to fail a run.
 */
function discoverAgentsMd(workspaceDir: string): DiscoveredFile[] {
  const found: DiscoveredFile[] = [];
  let totalBytes = 0;

  // Breadth-first: each frontier level is one directory depth. Shallower AGENTS.md files (closer to
  // the root, more relevant) are collected first, so the MAX_FILES cap drops the deepest ones.
  let frontier: string[] = [workspaceDir];
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
        if (found.length >= MAX_FILES) continue;
        const file = readBounded(workspaceDir, full, MAX_TOTAL_BYTES - totalBytes);
        if (file === null) continue; // unreadable, escapes the workspace, or no budget left
        found.push(file);
        totalBytes += Buffer.byteLength(file.content, "utf8");
      }
    }
    frontier = next;
  }

  // Root first, then nested by path — stable, deterministic order regardless of readdir ordering.
  return found.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

/** A dotdir or a named build/VCS/dependency dir — never walked for project context. */
function isSkippedDir(name: string): boolean {
  return name.startsWith(".") || SKIP_DIRS.has(name);
}

/**
 * Read one AGENTS.md, clipped to the per-file cap AND whatever remains of the total budget. Returns
 * null when the file escapes the workspace (defense in depth — the walk only descends into it), is
 * unreadable, or there is no remaining budget. The workspace-relative path uses forward slashes so
 * the rendered label is platform-stable.
 */
function readBounded(
  workspaceDir: string,
  fullPath: string,
  remainingTotal: number,
): DiscoveredFile | null {
  if (remainingTotal <= 0) return null;
  const rel = relative(workspaceDir, fullPath);
  // Confine to the workspace: a `..` segment means the path climbed out (only reachable via a
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

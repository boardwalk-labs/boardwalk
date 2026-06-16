// SPDX-License-Identifier: Apache-2.0

// Filesystem containment for the built-in coding tools (read/write/edit/ls/grep/glob/bash/
// apply_patch). Every path a tool touches is model-chosen — untrusted input — so it is resolved
// against the run's workspace root and rejected if it escapes (absolute paths and `..` traversal
// are normalized away by resolve()). NOTE: resolve() is LEXICAL — it does not follow symlinks, so a
// symlink inside the workspace that points outside is not caught here. That is hard to reach (the
// built-in tools can't create a symlink — no `ln`, no symlink write) and the hosted platform's OS
// sandbox is the real backstop; resolving via realpath is a hardening follow-up. The workspace is
// the containment boundary: the tools never address a path outside it lexically.

import { resolve, sep } from "node:path";
import { EngineError } from "../../errors.js";

/**
 * Resolve a model-chosen relative path inside `workspaceDir`, rejecting any escape. The result is
 * an absolute path guaranteed to be `workspaceDir` itself or a descendant of it. An absolute input
 * or a `..` that climbs out both fail loudly (VALIDATION) — there is no silent clamping.
 */
export function containedPath(workspaceDir: string, relativePath: string): string {
  // An empty path means "the workspace root" — legal for ls/glob, not for file ops (callers gate).
  const candidate = resolve(workspaceDir, relativePath);
  if (candidate !== workspaceDir && !candidate.startsWith(workspaceDir + sep)) {
    throw new EngineError(
      "VALIDATION",
      `Path "${relativePath}" escapes the workspace directory.`,
      "Built-in tools may only touch files inside the run's workspace; use a workspace-relative path.",
    );
  }
  return candidate;
}

/** A relative path back to `workspaceDir`, used for human-readable tool output (never leaks the root). */
export function workspaceRelative(workspaceDir: string, absolutePath: string): string {
  if (absolutePath === workspaceDir) return ".";
  const prefix = workspaceDir + sep;
  return absolutePath.startsWith(prefix) ? absolutePath.slice(prefix.length) : absolutePath;
}

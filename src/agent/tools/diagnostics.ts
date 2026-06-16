// SPDX-License-Identifier: Apache-2.0

// The `diagnostics` built-in: query a workspace file's language-server diagnostics on demand. It is
// the self-correct edge an autonomous coding agent leans on — after editing, ask for the file's
// type/lint errors and fix them with no human in the loop. ENGINE-NATIVE (the engine spawns the
// language server in the run's workspace) and BEST-EFFORT (no server for the extension, or its
// binary not installed → a clear "no language server available" note, never an error).
//
// Read-only: it syncs the file's on-disk contents to the server and reports diagnostics; it never
// mutates the workspace, so it joins the `"read-only"` built-in set. Confined to the workspace via
// containedPath like every other coding tool — a model-chosen path is untrusted input.

import { existsSync, statSync } from "node:fs";
import { EngineError } from "../../errors.js";
import type { LspService } from "../lsp/index.js";
import { renderDiagnostics } from "../lsp/index.js";
import type { ExecutableTool } from "../tools.js";
import { containedPath, workspaceRelative } from "./sandbox.js";

export function diagnosticsTool(workspaceDir: string, lsp: LspService): ExecutableTool {
  return {
    name: "diagnostics",
    description:
      "Report a workspace file's language-server diagnostics (type errors, lint warnings) so you " +
      "can fix what you just wrote. Set `workspace: true` to instead list every file the server " +
      "currently reports errors in. Best-effort: a file with no installed language server returns " +
      "a short note, never an error.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative file path." },
        workspace: {
          type: "boolean",
          description:
            "List the set of files the language server currently reports diagnostics in (default false).",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    execute: async (input) => {
      const path = requireString(input, "path");
      const file = containedPath(workspaceDir, path);
      if (!existsSync(file) || statSync(file).isDirectory()) {
        throw new EngineError("VALIDATION", `diagnostics: no such file "${path}".`);
      }

      if (input["workspace"] === true) {
        const uris = lsp.filesWithDiagnostics(file);
        if (uris.length === 0) return "No files currently report diagnostics.";
        const rel = uris.map((uri) => workspaceRelative(workspaceDir, fileUriToPath(uri))).sort();
        return `Files with diagnostics:\n${rel.join("\n")}`;
      }

      const result = await lsp.diagnostics(file);
      if (!result.available) {
        return `No language server available for ${path} — diagnostics skipped.`;
      }
      return renderDiagnostics(path, result.diagnostics);
    },
  };
}

/** Decode a file:// URI back to a filesystem path (the inverse of pathToFileURL for display). */
function fileUriToPath(uri: string): string {
  if (!uri.startsWith("file://")) return uri;
  try {
    return decodeURIComponent(new URL(uri).pathname);
  } catch {
    return uri;
  }
}

function requireString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string") {
    throw new EngineError("VALIDATION", `Tool input "${key}" must be a string.`);
  }
  return value;
}

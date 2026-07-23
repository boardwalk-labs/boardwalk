// SPDX-License-Identifier: Apache-2.0

// Loading a BUILT workflow package from a directory — the engine's deploy unit.
//
// A package directory is what §8 of the format describes, in its built form:
//
//   my-workflow/
//     workflow.jsonc      — the descriptor (or strict-JSON workflow.json; both present = error)
//     index.mjs           — the built entry, default-exporting run() (SDK left external —
//                           exactly what `boardwalk build` emits)
//     skills/             — optional; deployed wholesale
//     AGENTS.md           — optional; the author's standing instructions
//
// The descriptor is the source of truth for everything the engine must know WITHOUT running
// the program (slug, triggers, permissions, budget). The engine derives no I/O schemas — the
// untyped floor — so the stored manifest is exactly the descriptor.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DescriptorValidationError,
  parseWorkflowDescriptor,
  type WorkflowDescriptor,
} from "@boardwalk-labs/workflow";
import { EngineError } from "./errors.js";

/** A loaded, validated workflow package, ready to hand to `Engine.deployWorkflow`. */
export interface LoadedWorkflowPackage {
  /** The validated descriptor (the manifest minus the build-derived I/O schemas). */
  descriptor: WorkflowDescriptor;
  /** The raw descriptor text (JSONC), preserved for callers that re-parse. */
  descriptorText: string;
  /** The built program source (single-file ESM, `@boardwalk-labs/workflow` external). */
  program: string;
  /** The entry filename the program was read from (for diagnostics). */
  entryFile: string;
  /** Absolute path to the package's skills/ directory, when present. */
  skillsSourceDir?: string;
  /** The bundled AGENTS.md content, when present. */
  agentsMd?: string;
}

/** Entry filenames tried, in order, when the descriptor declares none. */
const DEFAULT_ENTRIES = ["index.mjs", "index.js"];

/**
 * Load a built workflow package from `dir`: find + parse the descriptor, resolve the built
 * entry, and pick up the package artifacts (skills/, AGENTS.md). Throws
 * `EngineError("VALIDATION", …)` with an actionable message on every malformed-package shape.
 */
export function loadWorkflowPackage(dir: string): LoadedWorkflowPackage {
  const descriptorText = readDescriptorText(dir);
  let descriptor: WorkflowDescriptor;
  try {
    descriptor = parseWorkflowDescriptor(descriptorText);
  } catch (err) {
    if (err instanceof DescriptorValidationError) {
      throw new EngineError("VALIDATION", `${dir}: ${err.message}`);
    }
    throw err;
  }

  const entryFile = resolveEntryFile(dir, descriptor.entry);
  const program = readFileSync(join(dir, entryFile), "utf8");
  const skillsDir = join(dir, "skills");
  const agentsMdPath = join(dir, "AGENTS.md");
  return {
    descriptor,
    descriptorText,
    program,
    entryFile,
    ...(existsSync(skillsDir) ? { skillsSourceDir: skillsDir } : {}),
    ...(existsSync(agentsMdPath) ? { agentsMd: readFileSync(agentsMdPath, "utf8") } : {}),
  };
}

/** Find the descriptor: `workflow.jsonc` preferred, `workflow.json` accepted, both = error. */
function readDescriptorText(dir: string): string {
  const jsonc = join(dir, "workflow.jsonc");
  const json = join(dir, "workflow.json");
  const hasJsonc = existsSync(jsonc);
  const hasJson = existsSync(json);
  if (hasJsonc && hasJson) {
    throw new EngineError(
      "VALIDATION",
      `${dir} has BOTH workflow.jsonc and workflow.json — a package carries exactly one descriptor.`,
      "Delete one of them (workflow.jsonc is the conventional choice).",
    );
  }
  if (!hasJsonc && !hasJson) {
    throw new EngineError(
      "VALIDATION",
      `${dir} has no workflow.jsonc (or workflow.json) — every workflow package needs a descriptor.`,
      'Add a workflow.jsonc with at least { "slug": "...", "triggers": [{ "kind": "manual" }] }.',
    );
  }
  return readFileSync(hasJsonc ? jsonc : json, "utf8");
}

/**
 * Resolve the BUILT entry module inside the package. The descriptor's `entry` (when declared)
 * must name a built `.mjs`/`.js` file — this engine never transpiles; `boardwalk build` does.
 * Undeclared ⇒ `index.mjs`, then `index.js`. The manifest schema already confines `entry` to a
 * relative, escape-free path, so a join stays inside the package.
 */
function resolveEntryFile(dir: string, declared: string | undefined): string {
  if (declared !== undefined) {
    if (!declared.endsWith(".mjs") && !declared.endsWith(".js")) {
      throw new EngineError(
        "VALIDATION",
        `${dir}: entry "${declared}" is not built JavaScript — this engine runs built programs only.`,
        "Build the workflow (`boardwalk build`) and point `entry` at the emitted .mjs, or omit `entry` and name the file index.mjs.",
      );
    }
    if (!existsSync(join(dir, declared))) {
      throw new EngineError(
        "VALIDATION",
        `${dir}: the declared entry "${declared}" does not exist in the package.`,
        "Check the `entry` path in workflow.jsonc against the package contents.",
      );
    }
    return declared;
  }
  for (const candidate of DEFAULT_ENTRIES) {
    if (existsSync(join(dir, candidate))) return candidate;
  }
  throw new EngineError(
    "VALIDATION",
    `${dir} has no entry module (looked for ${DEFAULT_ENTRIES.join(", ")}).`,
    "Build the workflow to index.mjs (`boardwalk build`), or declare `entry` in workflow.jsonc.",
  );
}

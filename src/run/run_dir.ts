// Per-run on-disk layout + the SDK-sharing symlink.
//
//   <dataDir>/runs/<runId>/
//     program/index.mjs                          — the deployed bundle (SDK left external)
//     program/node_modules/@boardwalk-labs/workflow   — symlink to the ENGINE's installed SDK
//     workspace/                                 — the run's cwd (isolated per run)
//     artifacts/                                 — artifacts.write targets
//
// Why the symlink: the SDK's host state is a module-level singleton, so the program and the
// child entry (engine code) must load the SAME module instance for installHost() to be visible
// to the program's hooks. The program bundle imports `@boardwalk-labs/workflow` bare; this symlink
// makes that specifier resolve — and Node's default symlink realpathing collapses it onto the
// engine's own copy, giving one shared instance with no bundler in the engine at all.

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { z } from "zod";
import { EngineError } from "../errors.js";

// A file from disk is a trust boundary — parse, don't cast.
const packageNameSchema = z.looseObject({ name: z.string().optional() });

export interface RunDirs {
  root: string;
  programPath: string;
  workspaceDir: string;
  artifactsDir: string;
}

/** Lay out (or re-lay-out, on restart) the run directory for a program bundle. Idempotent. */
export function prepareRunDir(dataDir: string, runId: string, program: string): RunDirs {
  const root = join(dataDir, "runs", runId);
  const programDir = join(root, "program");
  const workspaceDir = join(root, "workspace");
  const artifactsDir = join(root, "artifacts");
  mkdirSync(programDir, { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });
  mkdirSync(artifactsDir, { recursive: true });

  const programPath = join(programDir, "index.mjs");
  writeFileSync(programPath, program, "utf8");

  const linkParent = join(programDir, "node_modules", "@boardwalk-labs");
  const linkPath = join(linkParent, "workflow");
  if (!existsSync(linkPath)) {
    mkdirSync(linkParent, { recursive: true });
    symlinkSync(sdkPackageDir(), linkPath, "dir");
  }

  return { root, programPath, workspaceDir, artifactsDir };
}

/** Remove a run directory (terminal-run cleanup; never called on active runs). */
export function removeRunDir(dataDir: string, runId: string): void {
  rmSync(join(dataDir, "runs", runId), { recursive: true, force: true });
}

// ----------------------------------------------------------------------------
// Workspace persistence (manifest workspace.persist + per-agent memory dirs — SPEC §2.3)
//
// The durable store is a per-WORKFLOW directory tree under <dataDir>/persist/<workflowId>:
// hydrated into the run's workspace at FIRST start (a crash-restart keeps the workspace as
// the crashed pass left it — re-hydrating would erase exactly the mid-run writes the
// restarted pass uses to recover), and written back at SUCCESSFUL run end only. What gets
// written back = the manifest's workspace.persist selection PLUS every memory dir agent()
// calls used this run (memory is auto-persisted, no declaration). Concurrent runs sharing a
// persistent dir are last-writer-wins by contract.
// ----------------------------------------------------------------------------

export type PersistSelection = boolean | readonly string[] | undefined;

/** The workflow's durable persistence root. */
export function persistRoot(dataDir: string, workflowId: string): string {
  return join(dataDir, "persist", workflowId);
}

/**
 * Copy persisted state into a fresh run workspace (first attempt only — see above). The whole
 * durable root is hydrated: it only ever contains what a previous successful run persisted
 * (declared dirs + memory dirs), so all of it belongs in the workspace.
 */
export function hydrateWorkspace(root: string, workspaceDir: string): void {
  if (existsSync(root)) cpSync(root, workspaceDir, { recursive: true });
}

/**
 * Replace the durable store with the run's final state (successful runs only). `memoryDirs`
 * are the per-agent memory directories used this run — persisted in addition to the
 * manifest's selection (deduplicated; a memory dir inside `persist: true` costs nothing).
 */
export function persistWorkspace(
  root: string,
  persist: PersistSelection,
  memoryDirs: ReadonlySet<string>,
  workspaceDir: string,
): void {
  if (persist === true) {
    rmSync(root, { recursive: true, force: true });
    cpSync(workspaceDir, root, { recursive: true });
    return;
  }
  const declared = persist === undefined || persist === false ? [] : persist;
  const dirs = new Set([...declared, ...memoryDirs]);
  for (const dir of dirs) {
    const source = join(workspaceDir, dir);
    const target = join(root, dir);
    rmSync(target, { recursive: true, force: true });
    if (existsSync(source)) {
      mkdirSync(dirname(target), { recursive: true });
      cpSync(source, target, { recursive: true });
    }
  }
}

let cachedSdkDir: string | null = null;

/**
 * The engine's installed `@boardwalk-labs/workflow` package root. Resolved from the package's main
 * entry and walked up to its package.json — the exports map doesn't expose "./package.json",
 * so `require.resolve("@boardwalk-labs/workflow/package.json")` would throw.
 */
export function sdkPackageDir(): string {
  if (cachedSdkDir !== null) return cachedSdkDir;
  const require = createRequire(import.meta.url);
  let dir = dirname(require.resolve("@boardwalk-labs/workflow"));
  for (let depth = 0; depth < 10; depth++) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      const pkg = packageNameSchema.safeParse(JSON.parse(readFileSync(pkgPath, "utf8")));
      if (pkg.success && pkg.data.name === "@boardwalk-labs/workflow") {
        cachedSdkDir = dir;
        return dir;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new EngineError(
    "INTERNAL",
    "Could not locate the installed @boardwalk-labs/workflow package root.",
  );
}

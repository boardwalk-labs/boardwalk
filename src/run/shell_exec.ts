// SPDX-License-Identifier: Apache-2.0

// The local `shell()` capability backend: run a command in the run's workspace and resolve
// to the COMPLETED result — exit code included, never thrown (a failing command is data to
// branch on). Runs in the run process, the trusted program layer, exactly where the program's
// own child_process would run; the sandbox story is the run's, not this function's.
//
// Contract (matches the SDK's `shell()` + the hosted runner's semantics):
//   - non-zero exit RESOLVES; only "could not run at all" rejects
//   - cwd defaults to the workspace root; a relative cwd resolves against it
//   - kill-by-timeout (or by the output cap) resolves exit `128 + signum` (SIGTERM ⇒ 143)
//   - stdout/stderr are captured up to `maxBuffer` bytes each (default 16 MiB), then the
//     command is killed and the captured prefix returned

import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import { resolve } from "node:path";
import type { ShellOptions } from "@boardwalk-labs/workflow";
import type { ShellResult } from "@boardwalk-labs/workflow/runtime";

/** Default per-stream capture cap (16 MiB), matching the SDK's documented host default. */
const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;

/** SIGKILL follows this long after a timeout's SIGTERM if the process ignores it. */
const KILL_GRACE_MS = 5_000;

export interface ShellExecContext {
  /** The run's workspace root — the default (and the base for a relative `opts.cwd`). */
  workspaceDir: string;
}

/** Run `cmd` through the system shell and resolve to its {@link ShellResult}. */
export function shellExec(
  cmd: string,
  opts: ShellOptions | undefined,
  ctx: ShellExecContext,
): Promise<ShellResult> {
  const cwd = opts?.cwd !== undefined ? resolve(ctx.workspaceDir, opts.cwd) : ctx.workspaceDir;
  const maxBuffer = opts?.maxBuffer ?? DEFAULT_MAX_BUFFER;
  return new Promise<ShellResult>((resolvePromise, rejectPromise) => {
    const child = spawn(cmd, {
      shell: true,
      cwd,
      env: { ...process.env, ...(opts?.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
      // Own process GROUP: `sh -c` may not exec-optimize, leaving the real command a GRANDCHILD
      // holding the stdio pipes — killing only the shell would leak it and `close` would not
      // fire until the grandchild exits. Group-kill reaches the whole tree.
      detached: true,
    });

    let stdout = "";
    let stderr = "";
    let capExceeded = false;
    let killTimer: NodeJS.Timeout | null = null;
    let graceTimer: NodeJS.Timeout | null = null;

    const killTree = (signal: NodeJS.Signals): void => {
      // Negative pid = the process group (see `detached` above). Fall back to the direct child
      // when the group is already gone.
      try {
        if (child.pid !== undefined) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        child.kill(signal);
      }
    };
    const kill = (): void => {
      killTree("SIGTERM");
      // A process ignoring SIGTERM still ends: SIGKILL after a short grace.
      graceTimer = setTimeout(() => {
        killTree("SIGKILL");
      }, KILL_GRACE_MS);
      graceTimer.unref();
    };

    if (opts?.timeoutMs !== undefined) {
      killTimer = setTimeout(kill, opts.timeoutMs);
    }

    const capture = (current: string, chunk: Buffer): string => {
      if (current.length >= maxBuffer) return current;
      const next = current + chunk.toString("utf8");
      if (next.length > maxBuffer) {
        capExceeded = true;
        kill(); // output cap exceeded — stop the command; `close` rejects below
        return next.slice(0, maxBuffer);
      }
      return next;
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = capture(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = capture(stderr, chunk);
    });

    child.on("error", (err) => {
      // The command could not run at all (e.g. no shell) — the ONE rejecting case.
      if (killTimer !== null) clearTimeout(killTimer);
      if (graceTimer !== null) clearTimeout(graceTimer);
      rejectPromise(err);
    });
    child.on("close", (code, signal) => {
      if (killTimer !== null) clearTimeout(killTimer);
      if (graceTimer !== null) clearTimeout(graceTimer);
      if (capExceeded) {
        // The ratified contract (lockstep with the hosted runner): an exceeded output cap
        // REJECTS — never a silently truncated success.
        rejectPromise(new Error(`shell output exceeded maxBuffer (${String(maxBuffer)} bytes)`));
        return;
      }
      resolvePromise({ exitCode: exitCodeOf(code, signal), stdout, stderr });
    });
  });
}

/** POSIX convention: a signal death reports `128 + signum` (SIGTERM ⇒ 143, SIGKILL ⇒ 137). */
function exitCodeOf(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  if (signal !== null) {
    const signum = osConstants.signals[signal];
    return 128 + signum;
  }
  return -1; // neither code nor signal — Node contract says this can't happen; be explicit
}

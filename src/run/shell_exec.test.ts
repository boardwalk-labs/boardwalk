// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { shellExec } from "./shell_exec.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "bw-shell-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("shellExec", () => {
  it("resolves stdout/stderr and exit code 0 for a successful command", async () => {
    const result = await shellExec("echo out && echo err 1>&2", undefined, {
      workspaceDir: makeWorkspace(),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("out\n");
    expect(result.stderr).toBe("err\n");
  });

  it("a non-zero exit RESOLVES — failure is data, not an exception", async () => {
    const result = await shellExec("exit 7", undefined, { workspaceDir: makeWorkspace() });
    expect(result.exitCode).toBe(7);
  });

  it("runs in the workspace by default; a relative cwd resolves against it", async () => {
    const workspaceDir = makeWorkspace();
    mkdirSync(join(workspaceDir, "sub"));
    const root = await shellExec("pwd", undefined, { workspaceDir });
    expect(root.stdout.trim().endsWith(workspaceDir.split("/").at(-1) ?? "")).toBe(true);
    const sub = await shellExec("pwd", { cwd: "sub" }, { workspaceDir });
    expect(sub.stdout.trim().endsWith("/sub")).toBe(true);
  });

  it("merges opts.env over the process environment", async () => {
    const result = await shellExec(
      "echo $BW_SHELL_TEST_VAR",
      { env: { BW_SHELL_TEST_VAR: "v1" } },
      {
        workspaceDir: makeWorkspace(),
      },
    );
    expect(result.stdout).toBe("v1\n");
  });

  it("kill-by-timeout resolves exit 128 + signum (SIGTERM ⇒ 143)", async () => {
    const result = await shellExec(
      "sleep 30",
      { timeoutMs: 100 },
      {
        workspaceDir: makeWorkspace(),
      },
    );
    expect(result.exitCode).toBe(143);
  }, 10_000);

  it("caps captured output at maxBuffer and kills the command, keeping the prefix", async () => {
    const result = await shellExec(
      // Emit far more than the cap, then try to keep going.
      `yes 0123456789 | head -c 100000; sleep 30`,
      { maxBuffer: 1000 },
      { workspaceDir: makeWorkspace() },
    );
    expect(result.stdout.length).toBe(1000);
    expect(result.exitCode).toBe(143); // killed by the cap's SIGTERM
  }, 10_000);
});

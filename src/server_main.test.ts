// Tests for the server composition root: every config default, override, and rejection in
// loadServerConfig (the trust boundary for operator input), the .env resolution rules, and
// one boot-and-shutdown smoke of startServer on an ephemeral port + throwaway data dir.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EngineError } from "./errors.js";
import { loadServerConfig, resolveEngineEnv, startServer } from "./server_main.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/** Run `fn`, demand it throws an EngineError, and hand the error back for assertions. */
function captureEngineError(fn: () => unknown): EngineError {
  try {
    fn();
  } catch (err) {
    if (err instanceof EngineError) return err;
    throw new Error(`expected an EngineError, got: ${String(err)}`);
  }
  throw new Error("expected the call to throw, but it returned");
}

describe("loadServerConfig", () => {
  it("applies every default with an empty environment", () => {
    expect(loadServerConfig({})).toEqual({
      dataDir: "./boardwalk-data",
      host: "127.0.0.1",
      port: 8080,
      inference: undefined,
      envFile: undefined,
      workflowsDir: "boardwalk-data/workflows",
    });
  });

  it("defaults the data dir to /data inside the container", () => {
    expect(loadServerConfig({ BOARDWALK_IN_DOCKER: "1" }).dataDir).toBe("/data");
  });

  it("lets an explicit data dir beat the in-container default", () => {
    const config = loadServerConfig({ BOARDWALK_IN_DOCKER: "1", BOARDWALK_DATA_DIR: "/srv/bw" });
    expect(config.dataDir).toBe("/srv/bw");
  });

  it("honors host, port, and env-file overrides", () => {
    const config = loadServerConfig({
      BOARDWALK_HOST: "0.0.0.0",
      BOARDWALK_PORT: "9999",
      BOARDWALK_ENV_FILE: "/etc/boardwalk/.env",
    });
    expect(config.host).toBe("0.0.0.0");
    expect(config.port).toBe(9999);
    expect(config.envFile).toBe("/etc/boardwalk/.env");
  });

  it("accepts port 0 (ephemeral bind)", () => {
    expect(loadServerConfig({ BOARDWALK_PORT: "0" }).port).toBe(0);
  });

  it.each(["abc", "-1", "65536", "8080.5"])("rejects BOARDWALK_PORT=%s", (raw) => {
    const err = captureEngineError(() => loadServerConfig({ BOARDWALK_PORT: raw }));
    expect(err.code).toBe("VALIDATION");
    expect(err.message).toContain("BOARDWALK_PORT");
    expect(err.message).toContain(raw);
  });

  it("treats empty-string variables as unset (docker -e VAR= behavior)", () => {
    const config = loadServerConfig({
      BOARDWALK_DATA_DIR: "",
      BOARDWALK_HOST: "",
      BOARDWALK_PORT: "",
      BOARDWALK_DEFAULT_MODEL: "",
      BOARDWALK_PROVIDERS: "",
      BOARDWALK_ENV_FILE: "",
    });
    expect(config).toEqual({
      dataDir: "./boardwalk-data",
      host: "127.0.0.1",
      port: 8080,
      inference: undefined,
      envFile: undefined,
      workflowsDir: "boardwalk-data/workflows",
    });
  });

  it("defaults the workflows dir under the data dir; explicit override wins", () => {
    expect(loadServerConfig({ BOARDWALK_DATA_DIR: "/srv/bw" }).workflowsDir).toBe(
      "/srv/bw/workflows",
    );
    expect(loadServerConfig({ BOARDWALK_WORKFLOWS_DIR: "/etc/boardwalk/flows" }).workflowsDir).toBe(
      "/etc/boardwalk/flows",
    );
  });

  it("maps BOARDWALK_DEFAULT_MODEL to inference.default_model", () => {
    const config = loadServerConfig({ BOARDWALK_DEFAULT_MODEL: "anthropic/claude-sonnet-4-5" });
    expect(config.inference).toEqual({ default_model: "anthropic/claude-sonnet-4-5" });
  });

  it("parses a full BOARDWALK_PROVIDERS table", () => {
    const config = loadServerConfig({
      BOARDWALK_DEFAULT_MODEL: "ollama/llama3.3",
      BOARDWALK_PROVIDERS: JSON.stringify({
        ollama: { base_url: "http://localhost:11434/v1" },
        groq: {
          base_url: "https://api.groq.com/openai/v1",
          api_key_env: "GROQ_API_KEY",
          protocol: "openai",
        },
      }),
    });
    expect(config.inference).toEqual({
      default_model: "ollama/llama3.3",
      providers: {
        ollama: { base_url: "http://localhost:11434/v1" },
        groq: {
          base_url: "https://api.groq.com/openai/v1",
          api_key_env: "GROQ_API_KEY",
          protocol: "openai",
        },
      },
    });
  });

  it("keeps omitted provider fields absent, not undefined", () => {
    const config = loadServerConfig({
      BOARDWALK_PROVIDERS: JSON.stringify({ ollama: { base_url: "http://localhost:11434/v1" } }),
    });
    // toStrictEqual distinguishes a missing key from an explicit undefined — the engine's
    // exactOptionalPropertyTypes contract wants the key gone entirely.
    expect(config.inference?.providers).toStrictEqual({
      ollama: { base_url: "http://localhost:11434/v1" },
    });
  });

  it("parses provider headers: static strings and { from_env } refs", () => {
    const config = loadServerConfig({
      BOARDWALK_PROVIDERS: JSON.stringify({
        azure: {
          base_url: "https://my-rg.openai.azure.example/openai",
          headers: { "api-key": { from_env: "AZURE_KEY" }, "x-ms-client": "boardwalk" },
        },
      }),
    });
    expect(config.inference?.providers).toStrictEqual({
      azure: {
        base_url: "https://my-rg.openai.azure.example/openai",
        headers: { "api-key": { from_env: "AZURE_KEY" }, "x-ms-client": "boardwalk" },
      },
    });
  });

  it("rejects a malformed header value, naming the path", () => {
    const raw = JSON.stringify({
      azure: { base_url: "https://x.example/v1", headers: { "api-key": { fromenv: "K" } } },
    });
    const err = captureEngineError(() => loadServerConfig({ BOARDWALK_PROVIDERS: raw }));
    expect(err.code).toBe("VALIDATION");
    expect(err.message).toContain("azure");
    expect(err.message).toContain("api-key");
  });

  it("rejects BOARDWALK_PROVIDERS that is not valid JSON", () => {
    const err = captureEngineError(() => loadServerConfig({ BOARDWALK_PROVIDERS: "{nope" }));
    expect(err.code).toBe("VALIDATION");
    expect(err.message).toContain("BOARDWALK_PROVIDERS");
    expect(err.message).toContain("not valid JSON");
    expect(err.hint).toContain("base_url");
  });

  it("rejects a provider entry missing base_url, naming the bad path", () => {
    const err = captureEngineError(() =>
      loadServerConfig({ BOARDWALK_PROVIDERS: JSON.stringify({ groq: { api_key_env: "K" } }) }),
    );
    expect(err.code).toBe("VALIDATION");
    expect(err.message).toContain("BOARDWALK_PROVIDERS");
    expect(err.message).toContain("groq.base_url");
  });

  it("rejects unknown provider keys (typo protection)", () => {
    const err = captureEngineError(() =>
      loadServerConfig({
        BOARDWALK_PROVIDERS: JSON.stringify({
          ollama: { base_url: "http://localhost:11434/v1", apikey_env: "K" },
        }),
      }),
    );
    expect(err.code).toBe("VALIDATION");
    expect(err.message).toContain("ollama");
  });

  it("rejects an unknown protocol value", () => {
    const err = captureEngineError(() =>
      loadServerConfig({
        BOARDWALK_PROVIDERS: JSON.stringify({
          x: { base_url: "https://example.com/v1", protocol: "grpc" },
        }),
      }),
    );
    expect(err.code).toBe("VALIDATION");
    expect(err.message).toContain("x.protocol");
  });

  it("rejects BOARDWALK_PROVIDERS that is JSON but not an object of providers", () => {
    const err = captureEngineError(() => loadServerConfig({ BOARDWALK_PROVIDERS: "[1,2]" }));
    expect(err.code).toBe("VALIDATION");
    expect(err.message).toContain("BOARDWALK_PROVIDERS");
  });
});

describe("resolveEngineEnv", () => {
  it("parses an explicit BOARDWALK_ENV_FILE and labels errors with its path", () => {
    const dir = makeTempDir("bw-envfile-");
    const path = join(dir, "secrets.env");
    writeFileSync(path, "API_TOKEN=tok-123\nEMPTY_OK=\n# comment\n");
    expect(resolveEngineEnv({ envFile: path, dataDir: dir })).toEqual({
      env: { API_TOKEN: "tok-123", EMPTY_OK: "" },
      envLabel: path,
    });
  });

  it("fails closed when the explicit env file is missing", () => {
    const dir = makeTempDir("bw-envfile-");
    const missing = join(dir, "nope.env");
    const err = captureEngineError(() => resolveEngineEnv({ envFile: missing, dataDir: dir }));
    expect(err.code).toBe("VALIDATION");
    expect(err.message).toContain("BOARDWALK_ENV_FILE");
    expect(err.message).toContain(missing);
  });

  it("falls back to <dataDir>/.env when present", () => {
    const dir = makeTempDir("bw-envfile-");
    writeFileSync(join(dir, ".env"), "FROM_DEFAULT=yes\n");
    expect(resolveEngineEnv({ envFile: undefined, dataDir: dir })).toEqual({
      env: { FROM_DEFAULT: "yes" },
      envLabel: join(dir, ".env"),
    });
  });

  it("returns null when no env file exists anywhere", () => {
    const dir = makeTempDir("bw-envfile-");
    expect(resolveEngineEnv({ envFile: undefined, dataDir: dir })).toBeNull();
  });
});

describe("startServer", () => {
  it("boots on an ephemeral port, serves the API, logs startup lines, shuts down cleanly", async () => {
    const dataDir = makeTempDir("bw-server-main-");
    const lines: string[] = [];
    const running = await startServer(
      {
        dataDir,
        host: "127.0.0.1",
        port: 0,
        inference: undefined,
        envFile: undefined,
        workflowsDir: join(dataDir, "workflows"), // absent → nothing to deploy
      },
      (line) => lines.push(line),
    );
    cleanups.push(() => running.shutdown());

    expect(running.port).toBeGreaterThan(0);
    const res = await fetch(`http://127.0.0.1:${running.port}/api/workflows`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ workflows: [] });

    expect(lines.some((l) => l.includes("recovery sweep"))).toBe(true);
    expect(lines.some((l) => l.includes(dataDir))).toBe(true);
    expect(lines.some((l) => l.includes(`http://127.0.0.1:${running.port}`))).toBe(true);
    expect(lines.some((l) => l.includes("workflows deployed: 0"))).toBe(true);

    // Shutdown is idempotent (signal handlers may race a test teardown).
    await running.shutdown();
    await running.shutdown();
    await expect(fetch(`http://127.0.0.1:${running.port}/api/workflows`)).rejects.toThrow();
  });

  it("deploys built workflows from the workflows dir on boot (self-host deploy)", async () => {
    const dataDir = makeTempDir("bw-server-dir-");
    const workflowsDir = makeTempDir("bw-flows-");
    writeFileSync(
      join(workflowsDir, "from-dir.mjs"),
      `import { output } from "@boardwalk-labs/workflow";
       export const meta = { name: "from-dir", triggers: [{ kind: "manual" }] };
       output({ deployed: true });`,
    );
    // A non-workflow file in the dir must be skipped, not crash the boot.
    writeFileSync(join(workflowsDir, "notes.txt"), "ignore me");

    const lines: string[] = [];
    const running = await startServer(
      {
        dataDir,
        host: "127.0.0.1",
        port: 0,
        inference: undefined,
        envFile: undefined,
        workflowsDir,
      },
      (line) => lines.push(line),
    );
    cleanups.push(() => running.shutdown());

    expect(lines.some((l) => l.includes('deployed "from-dir"'))).toBe(true);
    expect(lines.some((l) => l.includes("workflows deployed: 1"))).toBe(true);

    const res = await fetch(`http://127.0.0.1:${running.port}/api/workflows`);
    const body: unknown = await res.json();
    expect(body).toEqual({
      workflows: [expect.objectContaining({ name: "from-dir" })],
    });
  });
});

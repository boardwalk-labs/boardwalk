// The composition root for the `boardwalk-server` binary (SPEC §2.4 + §5): parse config,
// construct the Engine, mount the HTTP surface, wire graceful shutdown. Everything here is
// glue — run semantics live in the engine, routing in the server, so this file stays thin
// enough that config parsing (tested below) plus the already-tested pieces carry the risk.
//
// Config is ENVIRONMENT VARIABLES ONLY in v0 (`BOARDWALK_` prefix). A `boardwalk.toml` file
// is deferred: Node has no TOML built-in and the zero-dependency rule (CODE_QUALITY §10)
// beats a hand-rolled parser. Env vars are also what Docker/systemd operators reach for
// first, so the deferral costs nothing in practice.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { z } from "zod";
import type { InferenceConfig, ProviderConfig } from "./agent/resolve.js";
import { Engine } from "./engine.js";
import { EngineError } from "./errors.js";
import { createEngineServer } from "./server/server.js";

const DEFAULT_PORT = 8080;
const DEFAULT_HOST = "127.0.0.1";

/** Fully-resolved server configuration — every field present, defaults applied. */
export interface ServerConfig {
  /** Where everything lives (SQLite DB, run dirs, artifacts). Created on boot if missing. */
  dataDir: string;
  /** Bind address. Loopback by default — the surface has no auth beyond webhook auth. */
  host: string;
  /** Listen port. 0 binds an ephemeral port (the resolved port is logged). */
  port: number;
  /** Default model + provider table for agent() leaves; undefined when none configured. */
  inference: InferenceConfig | undefined;
  /** Explicit BOARDWALK_ENV_FILE path; undefined means "use <dataDir>/.env if it exists". */
  envFile: string | undefined;
}

// Why strictObject: a typo'd provider key ("apikey_env") silently doing nothing is exactly
// the config bug an operator can't see — fail loudly at boot instead.
const providerEntrySchema = z.strictObject({
  base_url: z.url(),
  api_key_env: z.string().min(1).optional(),
  protocol: z.enum(["anthropic", "openai"]).optional(),
});

const providersSchema = z.record(z.string().min(1), providerEntrySchema);

const PROVIDERS_HINT =
  "Expected a JSON object of named providers, e.g. " +
  '{"ollama":{"base_url":"http://localhost:11434/v1"},' +
  '"groq":{"base_url":"https://api.groq.com/openai/v1","api_key_env":"GROQ_API_KEY"}}.';

/** One line per Zod issue, path-prefixed, so the operator sees which provider field is wrong. */
function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) =>
      issue.path.length > 0
        ? `${issue.path.map(String).join(".")}: ${issue.message}`
        : issue.message,
    )
    .join("; ");
}

// Why allow 0: `listen(0)` binds an ephemeral port, which embedders and tests rely on; the
// engine server reports the resolved port, so it is never a silent surprise.
const portSchema = z.coerce.number().int().min(0).max(65535);

function parsePort(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_PORT;
  const parsed = portSchema.safeParse(raw);
  if (!parsed.success) {
    throw new EngineError(
      "VALIDATION",
      `BOARDWALK_PORT must be an integer between 0 and 65535, got "${raw}".`,
      "Unset BOARDWALK_PORT to use the default (8080); 0 binds an ephemeral port.",
    );
  }
  return parsed.data;
}

function parseProviders(raw: string | undefined): Record<string, ProviderConfig> | undefined {
  if (raw === undefined) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new EngineError(
      "VALIDATION",
      `BOARDWALK_PROVIDERS is not valid JSON: ${err instanceof Error ? err.message : String(err)}.`,
      PROVIDERS_HINT,
    );
  }
  const parsed = providersSchema.safeParse(json);
  if (!parsed.success) {
    throw new EngineError(
      "VALIDATION",
      `BOARDWALK_PROVIDERS is malformed: ${formatIssues(parsed.error)}.`,
      PROVIDERS_HINT,
    );
  }
  // Why rebuild instead of returning parsed.data: under exactOptionalPropertyTypes, Zod's
  // optional fields type as `string | undefined` while ProviderConfig declares plain optional
  // keys — constructing entries keyless-when-absent satisfies the stricter shape with no cast.
  const providers: Record<string, ProviderConfig> = {};
  for (const [name, entry] of Object.entries(parsed.data)) {
    providers[name] = {
      base_url: entry.base_url,
      ...(entry.api_key_env !== undefined ? { api_key_env: entry.api_key_env } : {}),
      ...(entry.protocol !== undefined ? { protocol: entry.protocol } : {}),
    };
  }
  return providers;
}

/**
 * Parse server config from an environment map. Pure (no filesystem, no process globals) so
 * every default and failure mode is unit-testable; `main()` passes `process.env`.
 */
export function loadServerConfig(env: Record<string, string | undefined>): ServerConfig {
  // Why empty string counts as unset: `docker run -e BOARDWALK_PORT=` (and compose files with
  // blank values) produce empty strings, and nobody means "the empty data dir" by that.
  const get = (name: string): string | undefined => {
    const value = env[name];
    return value === undefined || value === "" ? undefined : value;
  };

  // BOARDWALK_IN_DOCKER is set by the Dockerfile so the image defaults to the conventional
  // volume mount point without baking container assumptions into bare-metal installs.
  const inDocker = get("BOARDWALK_IN_DOCKER") === "1";
  const dataDir = get("BOARDWALK_DATA_DIR") ?? (inDocker ? "/data" : "./boardwalk-data");
  const defaultModel = get("BOARDWALK_DEFAULT_MODEL");
  const providers = parseProviders(get("BOARDWALK_PROVIDERS"));
  const inference: InferenceConfig | undefined =
    defaultModel === undefined && providers === undefined
      ? undefined
      : {
          ...(defaultModel !== undefined ? { default_model: defaultModel } : {}),
          ...(providers !== undefined ? { providers } : {}),
        };

  return {
    dataDir,
    host: get("BOARDWALK_HOST") ?? DEFAULT_HOST,
    port: parsePort(get("BOARDWALK_PORT")),
    inference,
    envFile: get("BOARDWALK_ENV_FILE"),
  };
}

/**
 * Resolve the engine's secret/env source (SPEC §2.3 `secrets.get`): the configured
 * BOARDWALK_ENV_FILE, else `<dataDir>/.env` when present. An explicitly named file that does
 * not exist fails closed — a typo'd path silently falling back to process.env would make
 * `secrets.get` read the wrong values with no warning.
 */
export function resolveEngineEnv(
  config: Pick<ServerConfig, "envFile" | "dataDir">,
): { env: Record<string, string>; envLabel: string } | null {
  const explicit = config.envFile !== undefined;
  const path = config.envFile ?? join(config.dataDir, ".env");
  if (!existsSync(path)) {
    if (explicit) {
      throw new EngineError(
        "VALIDATION",
        `BOARDWALK_ENV_FILE points at "${path}" but no file exists there.`,
        "Create the file, or unset BOARDWALK_ENV_FILE to fall back to the process environment.",
      );
    }
    return null;
  }
  const parsed = parseEnv(readFileSync(path, "utf8"));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (value !== undefined) env[key] = value;
  }
  return { env, envLabel: path };
}

/** A booted server: the resolved port plus an idempotent teardown for signal handlers/tests. */
export interface RunningServer {
  port: number;
  /** Stop accepting connections, then release the engine (scheduler loop + DB handle). */
  shutdown(): Promise<void>;
}

/**
 * Boot the engine + HTTP surface from a resolved config. Split from `main()` so the whole
 * boot path (sweep, listen, startup logging, teardown) is testable without touching process
 * signals or `process.exit`.
 */
export async function startServer(
  config: ServerConfig,
  log: (line: string) => void,
): Promise<RunningServer> {
  const engineEnv = resolveEngineEnv(config);
  const engine = new Engine({
    dataDir: config.dataDir,
    log,
    ...(engineEnv !== null ? { env: engineEnv.env, envLabel: engineEnv.envLabel } : {}),
    ...(config.inference !== undefined ? { inference: config.inference } : {}),
  });
  try {
    const swept = engine.start();
    log(
      `recovery sweep: restarted ${String(swept.resumed.length)} run(s), ` +
        `cancelled ${String(swept.cancelled.length)}`,
    );
    const server = createEngineServer(engine, { host: config.host, log });
    const { port } = await server.listen(config.port);
    log(`data dir: ${resolve(config.dataDir)}`);
    log(`listening on http://${config.host}:${String(port)}`);
    log(`workflows deployed: ${String(engine.store.listWorkflows().length)}`);

    let closed = false;
    return {
      port,
      shutdown: async (): Promise<void> => {
        if (closed) return;
        closed = true;
        // Server first so no new runs arrive while the engine is releasing the scheduler.
        await server.close();
        engine.close();
      },
    };
  } catch (err) {
    // The engine owns the SQLite handle from construction; a failed listen must not leak it.
    engine.close();
    throw err;
  }
}

/**
 * The `boardwalk-server` entrypoint (invoked by bin/boardwalk-server.js). Owns the only
 * process-global concerns in the package: process.env, signal handlers, and exit codes.
 */
export async function main(): Promise<void> {
  const log = (line: string): void => {
    process.stderr.write(`${line}\n`);
  };
  const config = loadServerConfig(process.env);
  const running = await startServer(config, log);

  const onSignal = (signal: NodeJS.Signals): void => {
    log(`${signal} received — shutting down`);
    void running.shutdown().then(
      () => process.exit(0),
      (err: unknown) => {
        log(`shutdown failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      },
    );
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}

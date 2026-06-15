// SPDX-License-Identifier: Apache-2.0

// Model + provider resolution for the agent() leaf (SPEC §2.3 "model resolution").
//
// `provider` and `model` are ORTHOGONAL (decided 2026-06-12):
//   - `provider` picks who FULFILLS the call. Default: `boardwalk` (managed inference).
//   - `model` is an OPAQUE string passed VERBATIM to that provider. The engine never parses,
//     prefixes, or rewrites it — if a local server hosts "anthropic/sonnet-4.5", that exact
//     string is what the server receives.
//
// Inference is EXPLICIT: the engine never silently reaches for a user's own provider key.
// Using your own key (a built-in vendor) or any configured endpoint — including a LOCAL
// OpenAI-compatible server — requires naming the provider. With no provider named, the call
// goes to the Boardwalk managed lane, which is "set up" iff BOARDWALK_API_KEY is present;
// otherwise it errors with every way to fix it.
//
// Pure function: the supervisor calls it server-side so engine config and key material stay
// out of reach of anything but the run that asked.

import { EngineError } from "../errors.js";

/** Wire protocol an endpoint speaks. Anthropic + OpenAI are HTTP-key-authed; bedrock is the
 *  Anthropic Messages schema over AWS Bedrock Runtime, SigV4-authed (no API key). */
export type ProviderProtocol = "anthropic" | "openai" | "bedrock";

/** The default provider when an agent() call names none. */
export const BOARDWALK_PROVIDER = "boardwalk";

// What the managed lane is asked for when no model is named — the gateway routes ("Auto").
// NOTE (pending the gateway contract): confirm the route-for-me signal against the real
// Boardwalk inference gateway API; this engine sends model: "auto".
const AUTO_MODEL = "auto";

// The Boardwalk managed-inference gateway (OpenAI-compatible). `boardwalk.sh` is the placeholder
// domain; override with BOARDWALK_INFERENCE_URL or config. The Auto
// ROUTER itself lives in hosted Boardwalk — this engine only forwards to the gateway.
const DEFAULT_BOARDWALK_INFERENCE_URL = "https://api.boardwalk.sh/v1";

/** A custom header value: a static string, or `{ from_env }` to read it from the engine's
 *  environment at call time (for secret-bearing headers — values never sit in config). */
export type HeaderValue = string | { from_env: string };

/**
 * AWS Bedrock provider config (only meaningful with `protocol: "bedrock"`). The region is plain
 * config; credentials follow the same `*_env` indirection as `api_key_env`/header `from_env` — the
 * secret VALUES come from the engine environment, never inline config, and are redacted like a key.
 */
export interface AwsProviderConfig {
  /** AWS region, e.g. "us-east-1" — picks the bedrock-runtime endpoint. */
  region: string;
  /** Env var holding the AWS access key id. */
  access_key_id_env: string;
  /** Env var holding the AWS secret access key (a secret value — redacted). */
  secret_access_key_env: string;
  /** Env var holding an STS session token, for temporary credentials (a secret value — redacted). */
  session_token_env?: string;
}

/** One entry in the engine config's provider table. */
export interface ProviderConfig {
  /**
   * OpenAI-compatible endpoint base URL (e.g. http://localhost:11434/v1 for a local Ollama).
   * Required for every protocol EXCEPT `protocol: "bedrock"`, whose endpoint is derived from
   * `aws.region` (an explicit base_url then overrides it — for a VPC endpoint or regional proxy).
   */
  base_url?: string;
  /** Env var holding the API key. Omit for endpoints that need none (local servers, bedrock). */
  api_key_env?: string;
  /** Defaults to "openai" — the lingua franca of self-hosted/compatible endpoints. */
  protocol?: ProviderProtocol;
  /**
   * Extra request headers, for endpoints whose auth isn't bearer/x-api-key shaped (e.g. Azure
   * OpenAI's `api-key`). Custom headers WIN over the computed auth header on collision;
   * `content-type` is engine-owned and cannot be overridden. `{ from_env }` values are
   * redacted from all model-bound context, like the API key.
   */
  headers?: Record<string, HeaderValue>;
  /** AWS config — required for (and only used by) `protocol: "bedrock"`. */
  aws?: AwsProviderConfig;
}

export interface InferenceConfig {
  /** Used when an agent() call omits `model` — still passed VERBATIM to the chosen provider. */
  default_model?: string;
  /** Named providers, selected per call via `opts.provider`. */
  providers?: Record<string, ProviderConfig>;
  /** Override the Boardwalk managed-inference gateway URL (else BOARDWALK_INFERENCE_URL, else the default). */
  boardwalk_base_url?: string;
}

export interface ResolvedModel {
  /** Who fulfills the call. */
  provider: string;
  /** The model string, exactly as the program supplied it (or the configured/auto default). */
  model: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  /** Plaintext key, resolved from the environment. Null when the provider needs none. */
  apiKey: string | null;
  /** Extra request headers, already resolved (custom auth schemes, org headers, …). */
  headers: Record<string, string>;
  /** Names of `headers` whose values came from the environment — redacted like the API key. */
  secretHeaderNames: readonly string[];
  /**
   * AWS region + SigV4 credentials, resolved from the environment — present ONLY for
   * `protocol: "bedrock"` (apiKey is null then). `secretAccessKey`/`sessionToken` are secret
   * values: the seam registers them with the redactor exactly like the API key.
   */
  aws?:
    | {
        region: string;
        accessKeyId: string;
        secretAccessKey: string;
        sessionToken?: string | undefined;
      }
    | undefined;
}

interface BuiltinProvider {
  protocol: ProviderProtocol;
  baseUrl: string;
  keyEnvs: readonly string[];
}

// Built-in direct-call providers — used only when NAMED explicitly; key from the conventional
// env var. The engine never auto-selects one (that would be spending your key without you
// asking); you opt in with `provider: "anthropic"` etc.
const BUILTINS: Record<string, BuiltinProvider> = {
  anthropic: {
    protocol: "anthropic",
    baseUrl: "https://api.anthropic.com",
    keyEnvs: ["ANTHROPIC_API_KEY"],
  },
  openai: {
    protocol: "openai",
    baseUrl: "https://api.openai.com/v1",
    keyEnvs: ["OPENAI_API_KEY"],
  },
  google: {
    // Why the /openai path: Google publishes an OpenAI-compatible surface for Gemini; using it
    // keeps this engine at two wire protocols instead of three.
    protocol: "openai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    keyEnvs: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  },
};

export interface ResolveArgs {
  /** The agent() call's `model`, if given. Opaque — never parsed. */
  model?: string | undefined;
  /** The agent() call's `provider`, if given. Default: the Boardwalk managed lane. */
  provider?: string | undefined;
  config: InferenceConfig;
  /** Secret/env lookup (the engine's env map layered over process.env). */
  getEnv: (name: string) => string | undefined;
}

/** Resolve an agent() call to a concrete endpoint + key, or throw with a pointer at the fix. */
export function resolveModel(args: ResolveArgs): ResolvedModel {
  const provider = args.provider ?? BOARDWALK_PROVIDER;
  const model = args.model ?? args.config.default_model;

  if (provider === BOARDWALK_PROVIDER) {
    return resolveBoardwalk(model, args);
  }

  // Only the managed lane routes for you — an explicit provider needs a model.
  if (model === undefined || model.length === 0) {
    throw new EngineError(
      "MODEL_UNRESOLVED",
      `Provider "${provider}" needs a model.`,
      `Pass { model: "..." } with whatever model id "${provider}" expects, or set ` +
        "inference.default_model in the engine config.",
    );
  }

  const configured = args.config.providers?.[provider];
  if (configured !== undefined) {
    return resolveConfigured(provider, model, configured, args.getEnv);
  }

  const builtin = BUILTINS[provider];
  if (builtin !== undefined) {
    return resolveBuiltin(provider, model, builtin, args.getEnv);
  }

  throw new EngineError(
    "MODEL_UNRESOLVED",
    `Unknown inference provider "${provider}".`,
    `Built-ins: ${Object.keys(BUILTINS).join(", ")}, plus "${BOARDWALK_PROVIDER}" (managed, the ` +
      `default). Any OpenAI-compatible endpoint — including a local server — works via ` +
      `inference.providers.${provider} = { base_url, api_key_env } in the engine config.`,
  );
}

/** The managed lane: forward to the Boardwalk gateway. "Set up" iff BOARDWALK_API_KEY is present. */
function resolveBoardwalk(model: string | undefined, args: ResolveArgs): ResolvedModel {
  const apiKey = args.getEnv("BOARDWALK_API_KEY");
  if (apiKey === undefined || apiKey.length === 0) {
    throw new EngineError(
      "MODEL_UNRESOLVED",
      "No inference is set up for this run. agent() defaults to Boardwalk managed inference, " +
        "but BOARDWALK_API_KEY is not set.",
      "Set BOARDWALK_API_KEY to use Boardwalk managed inference, or name a provider explicitly: " +
        '{ provider: "anthropic" } (or openai/google) with that provider\'s API key set, or ' +
        "point inference.providers at any OpenAI-compatible server — including a local one " +
        "like Ollama.",
    );
  }
  const baseUrl =
    args.config.boardwalk_base_url ??
    args.getEnv("BOARDWALK_INFERENCE_URL") ??
    DEFAULT_BOARDWALK_INFERENCE_URL;
  return {
    provider: BOARDWALK_PROVIDER,
    model: model !== undefined && model.length > 0 ? model : AUTO_MODEL,
    protocol: "openai",
    baseUrl,
    apiKey,
    headers: {},
    secretHeaderNames: [],
  };
}

function resolveConfigured(
  provider: string,
  model: string,
  configured: ProviderConfig,
  getEnv: (name: string) => string | undefined,
): ResolvedModel {
  if (configured.protocol === "bedrock") {
    return resolveBedrock(provider, model, configured, getEnv);
  }
  if (configured.base_url === undefined) {
    throw new EngineError(
      "VALIDATION",
      `Provider "${provider}" has no base_url.`,
      "Set inference.providers." + provider + ".base_url (only bedrock derives its endpoint).",
    );
  }
  let apiKey: string | null = null;
  if (configured.api_key_env !== undefined) {
    const value = getEnv(configured.api_key_env);
    if (value === undefined || value.length === 0) {
      throw new EngineError(
        "PROVIDER_ERROR",
        `Provider "${provider}" needs an API key but ${configured.api_key_env} is not set.`,
        `Set ${configured.api_key_env} in the engine's environment.`,
      );
    }
    apiKey = value;
  }
  const { headers, secretHeaderNames } = resolveHeaders(provider, configured.headers, getEnv);
  return {
    provider,
    model,
    protocol: configured.protocol ?? "openai",
    baseUrl: configured.base_url,
    apiKey,
    headers,
    secretHeaderNames,
  };
}

/**
 * Resolve a BYO Bedrock provider: region drives the endpoint, credentials come from the env vars
 * the config names (the `*_env` indirection — secret values never sit in config). apiKey is null;
 * Bedrock authenticates per-request with SigV4 (bedrock.ts), not a bearer/x-api-key header.
 */
function resolveBedrock(
  provider: string,
  model: string,
  configured: ProviderConfig,
  getEnv: (name: string) => string | undefined,
): ResolvedModel {
  const aws = configured.aws;
  if (aws === undefined) {
    throw new EngineError(
      "VALIDATION",
      `Provider "${provider}" uses protocol "bedrock" but has no aws config.`,
      `Set inference.providers.${provider}.aws = { region, access_key_id_env, secret_access_key_env }.`,
    );
  }
  const accessKeyId = requireEnv(provider, aws.access_key_id_env, getEnv);
  const secretAccessKey = requireEnv(provider, aws.secret_access_key_env, getEnv);
  // Session token is optional (only STS temporary credentials carry one); absent is fine, but an
  // env var named-but-empty is an operator mistake worth surfacing.
  const sessionToken =
    aws.session_token_env !== undefined
      ? requireEnv(provider, aws.session_token_env, getEnv)
      : undefined;
  // Custom headers (org/proxy headers) still ride along; the adapter folds them into the
  // SigV4-signed request before signing.
  const { headers, secretHeaderNames } = resolveHeaders(provider, configured.headers, getEnv);

  return {
    provider,
    model,
    protocol: "bedrock",
    // The endpoint is region-derived by default; an explicit base_url overrides it for VPC
    // interface endpoints / regional proxies (and is what tests point at a local fake). The
    // SigV4 signature still uses aws.region for its credential scope regardless.
    baseUrl: configured.base_url ?? `https://bedrock-runtime.${aws.region}.amazonaws.com`,
    apiKey: null,
    headers,
    secretHeaderNames,
    aws: {
      region: aws.region,
      accessKeyId,
      secretAccessKey,
      ...(sessionToken !== undefined ? { sessionToken } : {}),
    },
  };
}

/** Read a required secret env var, failing closed with a pointer when unset/empty. */
function requireEnv(
  provider: string,
  envName: string,
  getEnv: (name: string) => string | undefined,
): string {
  const value = getEnv(envName);
  if (value === undefined || value.length === 0) {
    throw new EngineError(
      "PROVIDER_ERROR",
      `Provider "${provider}" needs ${envName}, which is not set.`,
      `Set ${envName} in the engine's environment.`,
    );
  }
  return value;
}

/** Resolve a provider's custom header map; `{ from_env }` values are looked up fail-closed. */
function resolveHeaders(
  provider: string,
  configured: Record<string, HeaderValue> | undefined,
  getEnv: (name: string) => string | undefined,
): { headers: Record<string, string>; secretHeaderNames: string[] } {
  const headers: Record<string, string> = {};
  const secretHeaderNames: string[] = [];
  for (const [name, value] of Object.entries(configured ?? {})) {
    if (name.toLowerCase() === "content-type") {
      // The engine owns the body format; a configured content-type would silently break it.
      throw new EngineError(
        "VALIDATION",
        `Provider "${provider}" configures a content-type header — the engine owns that header.`,
      );
    }
    if (typeof value === "string") {
      headers[name] = value;
      continue;
    }
    const resolved = getEnv(value.from_env);
    if (resolved === undefined || resolved.length === 0) {
      throw new EngineError(
        "PROVIDER_ERROR",
        `Provider "${provider}" header "${name}" needs ${value.from_env}, which is not set.`,
        `Set ${value.from_env} in the engine's environment.`,
      );
    }
    headers[name] = resolved;
    secretHeaderNames.push(name);
  }
  return { headers, secretHeaderNames };
}

function resolveBuiltin(
  provider: string,
  model: string,
  builtin: BuiltinProvider,
  getEnv: (name: string) => string | undefined,
): ResolvedModel {
  const apiKey = builtin.keyEnvs.map(getEnv).find((v) => v !== undefined && v.length > 0);
  if (apiKey === undefined) {
    throw new EngineError(
      "PROVIDER_ERROR",
      `Provider "${provider}" needs an API key but ${builtin.keyEnvs.join(" / ")} is not set.`,
      `Set ${builtin.keyEnvs[0] ?? "the provider API key"} in the engine's environment.`,
    );
  }
  return {
    provider,
    model,
    protocol: builtin.protocol,
    baseUrl: builtin.baseUrl,
    apiKey,
    headers: {},
    secretHeaderNames: [],
  };
}

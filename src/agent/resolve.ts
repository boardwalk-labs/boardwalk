// Model + provider resolution for the agent() leaf (SPEC §2.3 "model resolution").
//
// Inference is EXPLICIT (decided 2026-06-12): the engine never silently reaches for a user's
// own provider key. The default provider is `boardwalk` (managed inference) — when an agent()
// call names no provider and no model, the run goes to the Boardwalk managed lane, which is
// "set up" when BOARDWALK_API_KEY is present; otherwise it errors with the ways to fix it.
// Naming a provider explicitly (`anthropic/claude-…` with your own key, or an OpenAI-compatible
// endpoint in inference.providers — including a LOCAL server like Ollama) is always honored.
//
// A model ref is `<provider>/<model-id>` (the id may itself contain `/` or `:`). Pure function:
// the supervisor calls it server-side so engine config and key material stay out of reach of
// anything but the run that asked.

import { EngineError } from "../errors.js";

/** Wire protocol an endpoint speaks. Anthropic has its own; everything else is OpenAI-shaped. */
export type ProviderProtocol = "anthropic" | "openai";

/** The default provider when an agent() call names neither a provider nor a model. */
export const BOARDWALK_PROVIDER = "boardwalk";

// The managed-lane model id when no model is named — the gateway routes ("Auto").
// NOTE (pending the gateway contract): this engine forwards `model: "auto"` to the managed
// endpoint as the route-for-me signal. Confirm against the Boardwalk inference gateway's API.
const AUTO_MODEL = "auto";

// The Boardwalk managed-inference gateway (OpenAI-compatible). `boardwalk.sh` is the placeholder
// domain (MASTER_SPEC stack notes); override with BOARDWALK_INFERENCE_URL or config. The Auto
// ROUTER itself lives in Boardwalk Cloud — this engine only forwards to the gateway, it does
// not route.
const DEFAULT_BOARDWALK_INFERENCE_URL = "https://api.boardwalk.sh/v1";

/** One entry in the engine config's provider table. */
export interface ProviderConfig {
  /** OpenAI-compatible endpoint base URL (e.g. http://localhost:11434/v1 for a local Ollama). */
  base_url: string;
  /** Env var holding the API key. Omit for endpoints that need none (local servers). */
  api_key_env?: string;
  /** Defaults to "openai" — the lingua franca of self-hosted/compatible endpoints. */
  protocol?: ProviderProtocol;
}

export interface InferenceConfig {
  /** Used when an agent() call omits `model`. Omission otherwise defaults to the managed lane. */
  default_model?: string;
  /** Named providers, reusable across workflows; referenced by ref prefix or opts.provider. */
  providers?: Record<string, ProviderConfig>;
  /** Override the Boardwalk managed-inference gateway URL (else BOARDWALK_INFERENCE_URL, else the default). */
  boardwalk_base_url?: string;
}

export interface ResolvedModel {
  /** The canonical `<provider>/<model-id>` ref (also the billing/rate-table key). */
  ref: string;
  provider: string;
  modelId: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  /** Plaintext key, resolved from the environment. Null when the provider needs none. */
  apiKey: string | null;
}

interface BuiltinProvider {
  protocol: ProviderProtocol;
  baseUrl: string;
  keyEnvs: readonly string[];
  keyRequired: boolean;
}

// Built-in direct-call providers — used only when NAMED explicitly; key from the conventional
// env var. The engine never auto-selects one of these (that would be using your key without
// you asking); you opt in by writing `anthropic/…`, `openai/…`, or `google/…`.
const BUILTINS: Record<string, BuiltinProvider> = {
  anthropic: {
    protocol: "anthropic",
    baseUrl: "https://api.anthropic.com",
    keyEnvs: ["ANTHROPIC_API_KEY"],
    keyRequired: true,
  },
  openai: {
    protocol: "openai",
    baseUrl: "https://api.openai.com/v1",
    keyEnvs: ["OPENAI_API_KEY"],
    keyRequired: true,
  },
  google: {
    // Why the /openai path: Google publishes an OpenAI-compatible surface for Gemini; using it
    // keeps this engine at two wire protocols instead of three.
    protocol: "openai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    keyEnvs: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    keyRequired: true,
  },
};

export interface ResolveArgs {
  /** The agent() call's `model`, if given. */
  model?: string | undefined;
  /** The agent() call's `provider`, if given (overrides the ref's prefix). */
  provider?: string | undefined;
  config: InferenceConfig;
  /** Secret/env lookup (the engine's env map layered over process.env). */
  getEnv: (name: string) => string | undefined;
}

/** Resolve an agent() call to a concrete endpoint + key, or throw with a pointer at the fix. */
export function resolveModel(args: ResolveArgs): ResolvedModel {
  const ref = args.model ?? args.config.default_model;
  const { provider, modelId } = selectProviderAndModel(ref, args.provider);

  if (provider === BOARDWALK_PROVIDER) {
    return resolveBoardwalk(modelId, args);
  }

  // Explicit, named providers require a model id (only the managed lane routes for you).
  if (modelId === null || modelId.length === 0) {
    throw new EngineError(
      "MODEL_UNRESOLVED",
      `Provider "${provider}" needs a model id.`,
      `Pass { model: "${provider}/<model-id>" } (e.g. "anthropic/claude-sonnet-4-5").`,
    );
  }

  const configured = args.config.providers?.[provider];
  if (configured !== undefined) {
    return resolveConfigured(provider, modelId, configured, args.getEnv);
  }

  const builtin = BUILTINS[provider];
  if (builtin !== undefined) {
    return resolveBuiltin(provider, modelId, builtin, args.getEnv);
  }

  throw new EngineError(
    "MODEL_UNRESOLVED",
    `Unknown inference provider "${provider}".`,
    `Built-ins: ${Object.keys(BUILTINS).join(", ")}, plus "${BOARDWALK_PROVIDER}" (managed). ` +
      `Any OpenAI-compatible endpoint — including a local server — works via ` +
      `inference.providers.${provider} = { base_url, api_key_env } in the engine config.`,
  );
}

/**
 * Decide which provider and model id an agent() call resolves to. A model id of `null` means
 * "none named" — valid only for the managed lane (which routes), an error for explicit providers.
 */
function selectProviderAndModel(
  ref: string | undefined,
  explicitProvider: string | undefined,
): { provider: string; modelId: string | null } {
  if (explicitProvider !== undefined) {
    if (ref === undefined) return { provider: explicitProvider, modelId: null };
    const slash = ref.indexOf("/");
    // The ref may be a bare model id or a full `<provider>/<id>` matching the explicit provider.
    const modelId =
      slash > 0 && ref.slice(0, slash) === explicitProvider ? ref.slice(slash + 1) : ref;
    return { provider: explicitProvider, modelId };
  }
  if (ref !== undefined) {
    const slash = ref.indexOf("/");
    if (slash <= 0) {
      throw new EngineError(
        "MODEL_UNRESOLVED",
        `Model ref "${ref}" is missing its provider prefix.`,
        'Use "<provider>/<model-id>", e.g. "anthropic/claude-sonnet-4-5" or "openai/gpt-4o".',
      );
    }
    return { provider: ref.slice(0, slash), modelId: ref.slice(slash + 1) };
  }
  // No provider, no model, no default → the Boardwalk managed lane (which routes).
  return { provider: BOARDWALK_PROVIDER, modelId: null };
}

/** The managed lane: forward to the Boardwalk gateway. "Set up" iff BOARDWALK_API_KEY is present. */
function resolveBoardwalk(modelId: string | null, args: ResolveArgs): ResolvedModel {
  const apiKey = args.getEnv("BOARDWALK_API_KEY");
  if (apiKey === undefined || apiKey.length === 0) {
    throw new EngineError(
      "MODEL_UNRESOLVED",
      "No inference is set up for this run. agent() defaults to Boardwalk managed inference, " +
        "but BOARDWALK_API_KEY is not set.",
      "Set BOARDWALK_API_KEY to use Boardwalk managed inference, or name a provider explicitly: " +
        'pass { model: "anthropic/claude-sonnet-4-5" } (or openai/google) with that provider\'s ' +
        "API key, or point inference.providers at any OpenAI-compatible server — including a " +
        "local one like Ollama.",
    );
  }
  const baseUrl =
    args.config.boardwalk_base_url ??
    args.getEnv("BOARDWALK_INFERENCE_URL") ??
    DEFAULT_BOARDWALK_INFERENCE_URL;
  const id = modelId !== null && modelId.length > 0 ? modelId : AUTO_MODEL;
  return {
    ref: `${BOARDWALK_PROVIDER}/${id}`,
    provider: BOARDWALK_PROVIDER,
    modelId: id,
    protocol: "openai",
    baseUrl,
    apiKey,
  };
}

function resolveConfigured(
  provider: string,
  modelId: string,
  configured: ProviderConfig,
  getEnv: (name: string) => string | undefined,
): ResolvedModel {
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
  return {
    ref: `${provider}/${modelId}`,
    provider,
    modelId,
    protocol: configured.protocol ?? "openai",
    baseUrl: configured.base_url,
    apiKey,
  };
}

function resolveBuiltin(
  provider: string,
  modelId: string,
  builtin: BuiltinProvider,
  getEnv: (name: string) => string | undefined,
): ResolvedModel {
  const apiKey = builtin.keyEnvs.map(getEnv).find((v) => v !== undefined && v.length > 0);
  if (apiKey === undefined && builtin.keyRequired) {
    throw new EngineError(
      "PROVIDER_ERROR",
      `Provider "${provider}" needs an API key but ${builtin.keyEnvs.join(" / ")} is not set.`,
      `Set ${builtin.keyEnvs[0] ?? "the provider API key"} in the engine's environment.`,
    );
  }
  return {
    ref: `${provider}/${modelId}`,
    provider,
    modelId,
    protocol: builtin.protocol,
    baseUrl: builtin.baseUrl,
    apiKey: apiKey ?? null,
  };
}

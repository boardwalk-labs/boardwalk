// Model + provider resolution for the agent() leaf (SPEC §2.3 "model resolution").
//
// A model ref is `<provider>/<model-id>` (the id may itself contain `/` or `:`). Resolution is
// engine-dependent by contract (MASTER_SPEC §4): this LOCAL engine uses an explicit ref, else
// the configured default model, else fails with a pointer at the config — it never routes.
// Pure function: the supervisor calls it server-side so engine config and key material stay
// out of reach of anything but the run that asked.

import { EngineError } from "../errors.js";

/** Wire protocol an endpoint speaks. Anthropic has its own; everything else is OpenAI-shaped. */
export type ProviderProtocol = "anthropic" | "openai";

/** One entry in the engine config's provider table. */
export interface ProviderConfig {
  /** OpenAI-compatible endpoint base URL (e.g. http://localhost:11434/v1 for Ollama). */
  base_url: string;
  /** Env var holding the API key. Omit for endpoints that need none (local servers). */
  api_key_env?: string;
  /** Defaults to "openai" — the lingua franca of self-hosted/compatible endpoints. */
  protocol?: ProviderProtocol;
}

export interface InferenceConfig {
  /** Used when an agent() call omits `model`. No default — omission must be a deliberate choice. */
  default_model?: string;
  /** Named providers, reusable across workflows; referenced by ref prefix or opts.provider. */
  providers?: Record<string, ProviderConfig>;
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

// Built-in direct-call providers — key from the conventional env var, no config needed.
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
  if (ref === undefined) {
    throw new EngineError(
      "MODEL_UNRESOLVED",
      "agent() was called without a model and this engine has no default model configured.",
      'Pass { model: "<provider>/<model-id>" } (e.g. "anthropic/claude-sonnet-4-5"), or set ' +
        "inference.default_model in the engine config. Automatic model routing is a Boardwalk " +
        "Cloud capability.",
    );
  }

  const slash = ref.indexOf("/");
  let provider: string;
  let modelId: string;
  if (args.provider !== undefined) {
    provider = args.provider;
    // With an explicit provider, the ref may be a bare model id or a full `<provider>/<id>`.
    modelId = slash > 0 && ref.slice(0, slash) === provider ? ref.slice(slash + 1) : ref;
  } else {
    if (slash <= 0) {
      throw new EngineError(
        "MODEL_UNRESOLVED",
        `Model ref "${ref}" is missing its provider prefix.`,
        'Use "<provider>/<model-id>", e.g. "anthropic/claude-sonnet-4-5" or "openai/gpt-4o".',
      );
    }
    provider = ref.slice(0, slash);
    modelId = ref.slice(slash + 1);
  }
  if (modelId.length === 0) {
    throw new EngineError("MODEL_UNRESOLVED", `Model ref "${ref}" has an empty model id.`);
  }

  if (provider === "boardwalk") {
    throw new EngineError(
      "UNSUPPORTED",
      'The "boardwalk" provider is Boardwalk Cloud managed inference — this engine calls ' +
        "providers directly with your own keys.",
      'Use a direct provider ("anthropic/…", "openai/…") or configure one in inference.providers.',
    );
  }

  const configured = args.config.providers?.[provider];
  if (configured !== undefined) {
    const protocol = configured.protocol ?? "openai";
    let apiKey: string | null = null;
    if (configured.api_key_env !== undefined) {
      const value = args.getEnv(configured.api_key_env);
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
      protocol,
      baseUrl: configured.base_url,
      apiKey,
    };
  }

  const builtin = BUILTINS[provider];
  if (builtin !== undefined) {
    const apiKey = builtin.keyEnvs.map(args.getEnv).find((v) => v !== undefined && v.length > 0);
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

  throw new EngineError(
    "MODEL_UNRESOLVED",
    `Unknown inference provider "${provider}".`,
    `Built-ins: ${Object.keys(BUILTINS).join(", ")}. Any OpenAI-compatible endpoint works via ` +
      `inference.providers.${provider} = { base_url, api_key_env } in the engine config.`,
  );
}

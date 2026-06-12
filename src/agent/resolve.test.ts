import { describe, expect, it } from "vitest";
import { EngineError } from "../errors.js";
import { resolveModel, type InferenceConfig } from "./resolve.js";

function env(vars: Record<string, string>): (name: string) => string | undefined {
  return (name) => vars[name];
}

const none: InferenceConfig = {};

describe("resolveModel", () => {
  it("resolves a built-in anthropic ref with its conventional key env", () => {
    const r = resolveModel({
      model: "anthropic/claude-sonnet-4-5",
      config: none,
      getEnv: env({ ANTHROPIC_API_KEY: "sk-ant-x" }),
    });
    expect(r).toEqual({
      ref: "anthropic/claude-sonnet-4-5",
      provider: "anthropic",
      modelId: "claude-sonnet-4-5",
      protocol: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-ant-x",
    });
  });

  it("keeps slashes and colons inside the model id", () => {
    const r = resolveModel({
      model: "openai/ft:gpt-4o/org/abc",
      config: none,
      getEnv: env({ OPENAI_API_KEY: "sk-x" }),
    });
    expect(r.modelId).toBe("ft:gpt-4o/org/abc");
  });

  it("google uses its OpenAI-compatible surface and accepts either key env", () => {
    const viaGemini = resolveModel({
      model: "google/gemini-2.5-pro",
      config: none,
      getEnv: env({ GEMINI_API_KEY: "g-1" }),
    });
    expect(viaGemini.protocol).toBe("openai");
    expect(viaGemini.baseUrl).toContain("/openai");
    const viaGoogle = resolveModel({
      model: "google/gemini-2.5-pro",
      config: none,
      getEnv: env({ GOOGLE_API_KEY: "g-2" }),
    });
    expect(viaGoogle.apiKey).toBe("g-2");
  });

  it("falls back to the configured default model when the call omits one", () => {
    const r = resolveModel({
      config: { default_model: "anthropic/claude-haiku-4-5" },
      getEnv: env({ ANTHROPIC_API_KEY: "k" }),
    });
    expect(r.ref).toBe("anthropic/claude-haiku-4-5");
  });

  it("no model + no provider + no managed key → MODEL_UNRESOLVED naming the escape hatches", () => {
    expect(() => resolveModel({ config: none, getEnv: env({}) })).toThrowError(EngineError);
    try {
      resolveModel({ config: none, getEnv: env({}) });
    } catch (err) {
      expect(err).toBeInstanceOf(EngineError);
      if (err instanceof EngineError) {
        expect(err.code).toBe("MODEL_UNRESOLVED");
        // Names all three ways to set inference up: managed key, explicit provider, local server.
        expect(err.message).toContain("BOARDWALK_API_KEY");
        expect(err.hint).toContain("anthropic/claude-sonnet-4-5");
        expect(err.hint).toContain("Ollama");
      }
    }
  });

  it("default managed lane: no model/provider, BOARDWALK_API_KEY set → boardwalk/auto", () => {
    const r = resolveModel({ config: none, getEnv: env({ BOARDWALK_API_KEY: "bw-key" }) });
    expect(r).toEqual({
      ref: "boardwalk/auto",
      provider: "boardwalk",
      modelId: "auto",
      protocol: "openai",
      baseUrl: "https://api.boardwalk.sh/v1",
      apiKey: "bw-key",
    });
  });

  it("managed lane with an explicit model forwards that model to the gateway", () => {
    const r = resolveModel({
      model: "boardwalk/claude-sonnet-4-5",
      config: none,
      getEnv: env({ BOARDWALK_API_KEY: "bw-key" }),
    });
    expect(r.provider).toBe("boardwalk");
    expect(r.modelId).toBe("claude-sonnet-4-5");
    expect(r.apiKey).toBe("bw-key");
  });

  it("the managed gateway URL is overridable via config and env", () => {
    const viaConfig = resolveModel({
      config: { boardwalk_base_url: "https://gw.example/v1" },
      getEnv: env({ BOARDWALK_API_KEY: "k" }),
    });
    expect(viaConfig.baseUrl).toBe("https://gw.example/v1");
    const viaEnv = resolveModel({
      config: none,
      getEnv: env({ BOARDWALK_API_KEY: "k", BOARDWALK_INFERENCE_URL: "http://localhost:9000/v1" }),
    });
    expect(viaEnv.baseUrl).toBe("http://localhost:9000/v1");
  });

  it("NEVER auto-selects a user's own provider key — anthropic must be named", () => {
    // A user with ANTHROPIC_API_KEY set but no model named gets the managed-lane error, not a
    // silent anthropic call: inference is explicit.
    try {
      resolveModel({ config: none, getEnv: env({ ANTHROPIC_API_KEY: "sk-ant-x" }) });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(EngineError);
      if (err instanceof EngineError) expect(err.code).toBe("MODEL_UNRESOLVED");
    }
  });

  it("fails on a ref without a provider prefix", () => {
    expect(() =>
      resolveModel({ model: "claude-sonnet-4-5", config: none, getEnv: env({}) }),
    ).toThrow(/missing its provider prefix/);
  });

  it("resolves a configured OpenAI-compatible provider, keyless when api_key_env is omitted", () => {
    const config: InferenceConfig = {
      providers: { ollama: { base_url: "http://localhost:11434/v1" } },
    };
    const r = resolveModel({ model: "ollama/llama3.3", config, getEnv: env({}) });
    expect(r).toEqual({
      ref: "ollama/llama3.3",
      provider: "ollama",
      modelId: "llama3.3",
      protocol: "openai",
      baseUrl: "http://localhost:11434/v1",
      apiKey: null,
    });
  });

  it("configured providers shadow built-ins and honor api_key_env", () => {
    const config: InferenceConfig = {
      providers: {
        openai: { base_url: "https://proxy.internal/v1", api_key_env: "PROXY_KEY" },
      },
    };
    const r = resolveModel({ model: "openai/gpt-4o", config, getEnv: env({ PROXY_KEY: "p" }) });
    expect(r.baseUrl).toBe("https://proxy.internal/v1");
    expect(r.apiKey).toBe("p");

    expect(() => resolveModel({ model: "openai/gpt-4o", config, getEnv: env({}) })).toThrow(
      /PROXY_KEY is not set/,
    );
  });

  it("explicit opts.provider routes a bare model id, and strips a matching ref prefix", () => {
    const config: InferenceConfig = {
      providers: { fireworks: { base_url: "https://api.fireworks.ai/v1" } },
    };
    const bare = resolveModel({
      model: "llama-v3p3-70b",
      provider: "fireworks",
      config,
      getEnv: env({}),
    });
    expect(bare.ref).toBe("fireworks/llama-v3p3-70b");
    const prefixed = resolveModel({
      model: "fireworks/llama-v3p3-70b",
      provider: "fireworks",
      config,
      getEnv: env({}),
    });
    expect(prefixed.modelId).toBe("llama-v3p3-70b");
  });

  it("missing built-in key fails PROVIDER_ERROR naming the env var", () => {
    try {
      resolveModel({ model: "anthropic/claude-sonnet-4-5", config: none, getEnv: env({}) });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(EngineError);
      if (err instanceof EngineError) {
        expect(err.code).toBe("PROVIDER_ERROR");
        expect(err.message).toContain("ANTHROPIC_API_KEY");
      }
    }
  });

  it("explicit boardwalk provider without a managed key → MODEL_UNRESOLVED (not set up)", () => {
    try {
      resolveModel({ provider: "boardwalk", config: none, getEnv: env({}) });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(EngineError);
      if (err instanceof EngineError) {
        expect(err.code).toBe("MODEL_UNRESOLVED");
        expect(err.message).toContain("BOARDWALK_API_KEY");
      }
    }
  });

  it("unknown provider fails with the providers-config pointer in the hint", () => {
    try {
      resolveModel({ model: "nope/x", config: none, getEnv: env({}) });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(EngineError);
      if (err instanceof EngineError) {
        expect(err.code).toBe("MODEL_UNRESOLVED");
        expect(err.hint).toContain("inference.providers.nope");
      }
    }
  });

  it("rejects an empty model id for an explicit provider", () => {
    expect(() => resolveModel({ model: "openai/", config: none, getEnv: env({}) })).toThrow(
      /needs a model id/,
    );
  });
});

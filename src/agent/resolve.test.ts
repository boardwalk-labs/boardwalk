import { describe, expect, it } from "vitest";
import { EngineError } from "../errors.js";
import { resolveModel, type InferenceConfig } from "./resolve.js";

function env(vars: Record<string, string>): (name: string) => string | undefined {
  return (name) => vars[name];
}

const none: InferenceConfig = {};

describe("resolveModel", () => {
  it("resolves a built-in vendor with your own key ONLY when the provider is named", () => {
    const r = resolveModel({
      model: "anthropic/claude-sonnet-4-5",
      provider: "anthropic",
      config: none,
      getEnv: env({ ANTHROPIC_API_KEY: "sk-ant-x" }),
    });
    expect(r).toEqual({
      provider: "anthropic",
      model: "anthropic/claude-sonnet-4-5", // verbatim — the prefix is part of the model string
      protocol: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-ant-x",
    });
  });

  it("keeps slashes and colons inside the model id", () => {
    const r = resolveModel({
      model: "openai/ft:gpt-4o/org/abc",
      provider: "openai",
      config: none,
      getEnv: env({ OPENAI_API_KEY: "sk-x" }),
    });
    expect(r.model).toBe("openai/ft:gpt-4o/org/abc"); // verbatim, untouched
  });

  it("google uses its OpenAI-compatible surface and accepts either key env", () => {
    const viaGemini = resolveModel({
      model: "google/gemini-2.5-pro",
      provider: "google",
      config: none,
      getEnv: env({ GEMINI_API_KEY: "g-1" }),
    });
    expect(viaGemini.protocol).toBe("openai");
    expect(viaGemini.baseUrl).toContain("/openai");
    const viaGoogle = resolveModel({
      model: "google/gemini-2.5-pro",
      provider: "google",
      config: none,
      getEnv: env({ GOOGLE_API_KEY: "g-2" }),
    });
    expect(viaGoogle.apiKey).toBe("g-2");
  });

  it("default_model sets the managed lane's model when a call omits one", () => {
    const r = resolveModel({
      config: { default_model: "anthropic/claude-haiku-4-5" },
      getEnv: env({ BOARDWALK_API_KEY: "bw" }),
    });
    expect(r.provider).toBe("boardwalk");
    expect(r.model).toBe("anthropic/claude-haiku-4-5"); // verbatim to the gateway
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
        expect(err.hint).toContain('provider: "anthropic"');
        expect(err.hint).toContain("Ollama");
      }
    }
  });

  it("default managed lane: no model/provider, BOARDWALK_API_KEY set → boardwalk/auto", () => {
    const r = resolveModel({ config: none, getEnv: env({ BOARDWALK_API_KEY: "bw-key" }) });
    expect(r).toEqual({
      provider: "boardwalk",
      model: "auto",
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
    expect(r.model).toBe("boardwalk/claude-sonnet-4-5"); // even a 'boardwalk/' prefix is verbatim
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

  it("a bare model ref with no provider goes to the managed lane (no prefix required)", () => {
    const r = resolveModel({
      model: "claude-sonnet-4-5",
      config: none,
      getEnv: env({ BOARDWALK_API_KEY: "bw" }),
    });
    expect(r.provider).toBe("boardwalk");
    expect(r.model).toBe("claude-sonnet-4-5");
  });

  it("resolves a configured OpenAI-compatible provider, keyless when api_key_env is omitted", () => {
    const config: InferenceConfig = {
      providers: { ollama: { base_url: "http://localhost:11434/v1" } },
    };
    const r = resolveModel({ model: "llama3.3", provider: "ollama", config, getEnv: env({}) });
    expect(r).toEqual({
      provider: "ollama",
      model: "llama3.3",
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
    const r = resolveModel({
      model: "gpt-4o",
      provider: "openai",
      config,
      getEnv: env({ PROXY_KEY: "p" }),
    });
    expect(r.baseUrl).toBe("https://proxy.internal/v1");
    expect(r.apiKey).toBe("p");

    expect(() =>
      resolveModel({ model: "gpt-4o", provider: "openai", config, getEnv: env({}) }),
    ).toThrow(/PROXY_KEY is not set/);
  });

  it("the model string is NEVER rewritten — a locally-hosted vendor-prefixed id stays intact", () => {
    const config: InferenceConfig = {
      providers: { local: { base_url: "http://localhost:8000/v1" } },
    };
    const r = resolveModel({
      model: "anthropic/sonnet-4.5",
      provider: "local",
      config,
      getEnv: env({}),
    });
    expect(r.model).toBe("anthropic/sonnet-4.5"); // exactly as supplied — no provider prefixing
    expect(r.provider).toBe("local");
  });

  it("missing built-in key fails PROVIDER_ERROR naming the env var", () => {
    try {
      resolveModel({
        model: "anthropic/claude-sonnet-4-5",
        provider: "anthropic",
        config: none,
        getEnv: env({}),
      });
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
      resolveModel({ model: "x", provider: "nope", config: none, getEnv: env({}) });
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
    expect(() =>
      resolveModel({ model: "", provider: "openai", config: none, getEnv: env({}) }),
    ).toThrow(/needs a model/);
  });
});

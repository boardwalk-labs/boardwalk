// Provider adapters for the agent() leaf — two wire protocols cover everything (SPEC §2.3):
// Anthropic's Messages API (streamed) and OpenAI-style chat completions (the lingua franca of
// OpenAI, Google's compat surface, vLLM, Ollama, Together, Fireworks, Groq…).
//
// Zero SDK dependencies: plain fetch + Zod-validated responses (a provider's response is a
// trust boundary like any other). Retry policy per CODE_QUALITY §4.3: exponential backoff with
// jitter on 429/5xx/network errors; a non-rate-limit 4xx never retries.

import { z } from "zod";
import type { TokenUsage } from "@boardwalk/workflow";
import { EngineError } from "../errors.js";

export interface ChatArgs {
  baseUrl: string;
  apiKey: string | null;
  modelId: string;
  prompt: string;
  /** Anthropic requires max_tokens; this default is deliberately generous. */
  maxTokens?: number;
}

export interface ChatResult {
  text: string;
  usage: TokenUsage;
}

/** Injectable effects so adapter logic is unit-testable without a network or real waits. */
export interface ProviderIo {
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  /** Streamed text chunks, in order, as they arrive (drives text_delta events). */
  onDelta?: (text: string) => void;
}

const DEFAULT_MAX_TOKENS = 8192;
const RETRY_ATTEMPTS = 5;
const RETRY_BASE_MS = 500;

/** An HTTP failure that carries its status so the retry policy can classify it. */
class ProviderHttpError extends Error {
  readonly status: number;
  constructor(status: number, body: string) {
    super(`provider returned ${String(status)}: ${body.slice(0, 300)}`);
    this.status = status;
  }
}

// ----------------------------------------------------------------------------
// Anthropic Messages API (streaming)
// ----------------------------------------------------------------------------

// Parsed per-frame by `type` (unknown frame kinds — ping, content_block_start/stop,
// message_stop — are forward compatibility, not errors).
const frameHeadSchema = z.looseObject({ type: z.string() });
const messageStartSchema = z.looseObject({
  message: z.looseObject({
    usage: z.looseObject({ input_tokens: z.number().int().nonnegative().optional() }),
  }),
});
const contentBlockDeltaSchema = z.looseObject({
  delta: z.looseObject({ type: z.string(), text: z.string().optional() }),
});
const messageDeltaSchema = z.looseObject({
  usage: z.looseObject({ output_tokens: z.number().int().nonnegative().optional() }),
});

export async function chatAnthropic(args: ChatArgs, io: ProviderIo = {}): Promise<ChatResult> {
  const doFetch = io.fetchImpl ?? fetch;
  const response = await withRetry(io, async () => {
    const res = await doFetch(`${args.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        ...(args.apiKey !== null ? { "x-api-key": args.apiKey } : {}),
      },
      body: JSON.stringify({
        model: args.modelId,
        max_tokens: args.maxTokens ?? DEFAULT_MAX_TOKENS,
        stream: true,
        messages: [{ role: "user", content: args.prompt }],
      }),
    });
    if (!res.ok) throw new ProviderHttpError(res.status, await res.text());
    return res;
  });

  let text = "";
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  for await (const data of sseDataLines(response)) {
    const json = safeJson(data);
    const head = frameHeadSchema.safeParse(json);
    if (!head.success) continue;
    if (head.data.type === "message_start") {
      const frame = messageStartSchema.safeParse(json);
      if (frame.success) inputTokens = frame.data.message.usage.input_tokens ?? inputTokens;
    } else if (head.data.type === "content_block_delta") {
      const frame = contentBlockDeltaSchema.safeParse(json);
      const chunk = frame.success ? frame.data.delta.text : undefined;
      if (chunk !== undefined && chunk.length > 0) {
        text += chunk;
        io.onDelta?.(chunk);
      }
    } else if (head.data.type === "message_delta") {
      const frame = messageDeltaSchema.safeParse(json);
      if (frame.success) outputTokens = frame.data.usage.output_tokens ?? outputTokens;
    }
  }
  return {
    text,
    usage: {
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
    },
  };
}

// ----------------------------------------------------------------------------
// OpenAI-compatible chat completions (non-streaming in v0 — one final delta)
// ----------------------------------------------------------------------------

const openAiResponseSchema = z.looseObject({
  choices: z
    .array(
      z.looseObject({
        message: z.looseObject({ content: z.string().nullable() }),
      }),
    )
    .min(1),
  usage: z
    .looseObject({
      prompt_tokens: z.number().int().nonnegative().optional(),
      completion_tokens: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

export async function chatOpenAi(args: ChatArgs, io: ProviderIo = {}): Promise<ChatResult> {
  const doFetch = io.fetchImpl ?? fetch;
  const response = await withRetry(io, async () => {
    const res = await doFetch(`${args.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(args.apiKey !== null ? { authorization: `Bearer ${args.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: args.modelId,
        messages: [{ role: "user", content: args.prompt }],
      }),
    });
    if (!res.ok) throw new ProviderHttpError(res.status, await res.text());
    return res;
  });

  const parsed = openAiResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new EngineError("PROVIDER_ERROR", "Provider returned a malformed chat completion.");
  }
  const text = parsed.data.choices[0]?.message.content ?? "";
  if (text.length > 0) io.onDelta?.(text);
  const usage = parsed.data.usage;
  return {
    text,
    usage: {
      ...(usage?.prompt_tokens !== undefined ? { inputTokens: usage.prompt_tokens } : {}),
      ...(usage?.completion_tokens !== undefined ? { outputTokens: usage.completion_tokens } : {}),
    },
  };
}

// ----------------------------------------------------------------------------
// Shared plumbing
// ----------------------------------------------------------------------------

/** Retry transient failures (429/5xx/network) with exponential backoff + jitter. */
async function withRetry<T>(io: ProviderIo, fn: () => Promise<T>): Promise<T> {
  const sleep = io.sleepImpl ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let lastError: unknown;
  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await sleep(RETRY_BASE_MS * 2 ** (attempt - 1) + Math.random() * 250);
    }
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (err instanceof ProviderHttpError) {
        const retryable = err.status === 429 || err.status >= 500;
        if (!retryable) {
          throw new EngineError("PROVIDER_ERROR", err.message);
        }
        continue;
      }
      // fetch network failures surface as TypeError — retryable; anything else is a bug.
      if (err instanceof TypeError) continue;
      throw err;
    }
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new EngineError(
    "PROVIDER_ERROR",
    `Provider still failing after ${String(RETRY_ATTEMPTS)} attempts: ${detail}`,
  );
}

/** Iterate the `data:` payloads of an SSE response body. */
async function* sseDataLines(response: Response): AsyncGenerator<string> {
  const body = response.body;
  if (body === null) return;
  const decoder = new TextDecoder();
  let buffer = "";
  // Why the explicit AsyncIterable<unknown>: undici types the stream's chunks as `any`;
  // narrowing each chunk keeps the no-unsafe rules honest.
  const chunks: AsyncIterable<unknown> = body;
  for await (const chunk of chunks) {
    if (!(chunk instanceof Uint8Array)) continue;
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trimEnd();
      buffer = buffer.slice(newline + 1);
      if (line.startsWith("data:")) {
        const data = line.slice(5).trim();
        if (data.length > 0 && data !== "[DONE]") yield data;
      }
      newline = buffer.indexOf("\n");
    }
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

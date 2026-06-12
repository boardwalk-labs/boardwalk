// Provider adapters for the agent() leaf — two wire protocols cover everything (SPEC §2.3):
// Anthropic's Messages API (streamed) and OpenAI-style chat completions (the lingua franca of
// OpenAI, Google's compat surface, vLLM, Ollama, Together, Fireworks, Groq…). Each adapter
// maps the loop's neutral conversation (conversation.ts) to its wire format and executes ONE
// model turn; the tool loop itself lives in leaf.ts.
//
// Zero SDK dependencies: plain fetch + Zod-validated responses (a provider's response is a
// trust boundary like any other). Retry policy per CODE_QUALITY §4.3: exponential backoff with
// jitter on 429/5xx/network errors; a non-rate-limit 4xx never retries.

import { z } from "zod";
import { EngineError } from "../errors.js";
import { isJsonValue, isPlainObject } from "../json_value.js";
import type { ChatMessage, ChatTurn, ToolCallRequest, ToolSpec } from "./conversation.js";
import { sseDataLines } from "./sse.js";

export interface ChatArgs {
  baseUrl: string;
  apiKey: string | null;
  /** Opaque model string, sent verbatim. */
  model: string;
  messages: readonly ChatMessage[];
  tools: readonly ToolSpec[];
  /** Anthropic requires max_tokens; this default is deliberately generous. */
  maxTokens?: number;
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

function anthropicMessages(messages: readonly ChatMessage[]): unknown[] {
  return messages.map((message) => {
    switch (message.role) {
      case "user":
        return { role: "user", content: [{ type: "text", text: message.text }] };
      case "assistant": {
        const content: unknown[] = [];
        if (message.text.length > 0) content.push({ type: "text", text: message.text });
        for (const call of message.toolCalls) {
          content.push({ type: "tool_use", id: call.id, name: call.name, input: call.input });
        }
        return { role: "assistant", content };
      }
      case "tool_results":
        return {
          role: "user",
          content: message.results.map((result) => ({
            type: "tool_result",
            tool_use_id: result.id,
            content: result.content,
            is_error: result.isError,
          })),
        };
    }
  });
}

const frameHeadSchema = z.looseObject({ type: z.string() });
const messageStartSchema = z.looseObject({
  message: z.looseObject({
    usage: z.looseObject({ input_tokens: z.number().int().nonnegative().optional() }),
  }),
});
const contentBlockStartSchema = z.looseObject({
  content_block: z.looseObject({
    type: z.string(),
    id: z.string().optional(),
    name: z.string().optional(),
  }),
});
const contentBlockDeltaSchema = z.looseObject({
  delta: z.looseObject({
    type: z.string(),
    text: z.string().optional(),
    partial_json: z.string().optional(),
  }),
});
const messageDeltaSchema = z.looseObject({
  delta: z.looseObject({ stop_reason: z.string().nullable().optional() }).optional(),
  usage: z.looseObject({ output_tokens: z.number().int().nonnegative().optional() }).optional(),
});

export async function chatAnthropic(args: ChatArgs, io: ProviderIo = {}): Promise<ChatTurn> {
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
        model: args.model,
        max_tokens: args.maxTokens ?? DEFAULT_MAX_TOKENS,
        stream: true,
        messages: anthropicMessages(args.messages),
        ...(args.tools.length > 0
          ? {
              tools: args.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                input_schema: tool.inputSchema,
              })),
            }
          : {}),
      }),
    });
    if (!res.ok) throw new ProviderHttpError(res.status, await res.text());
    return res;
  });

  let text = "";
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let stopReason: string | null = null;
  const toolCalls: ToolCallRequest[] = [];
  // The currently-streaming tool_use block: input arrives as partial JSON deltas.
  let openToolCall: { id: string; name: string; partialJson: string } | null = null;

  for await (const data of sseDataLines(response)) {
    const json = safeJson(data);
    const head = frameHeadSchema.safeParse(json);
    if (!head.success) continue; // unknown frame kinds are forward compatibility, not errors
    switch (head.data.type) {
      case "message_start": {
        const frame = messageStartSchema.safeParse(json);
        if (frame.success) inputTokens = frame.data.message.usage.input_tokens ?? inputTokens;
        break;
      }
      case "content_block_start": {
        const frame = contentBlockStartSchema.safeParse(json);
        if (frame.success && frame.data.content_block.type === "tool_use") {
          openToolCall = {
            id: frame.data.content_block.id ?? `call-${String(toolCalls.length + 1)}`,
            name: frame.data.content_block.name ?? "",
            partialJson: "",
          };
        }
        break;
      }
      case "content_block_delta": {
        const frame = contentBlockDeltaSchema.safeParse(json);
        if (!frame.success) break;
        const chunk = frame.data.delta.text;
        if (chunk !== undefined && chunk.length > 0) {
          text += chunk;
          io.onDelta?.(chunk);
        }
        if (frame.data.delta.partial_json !== undefined && openToolCall !== null) {
          openToolCall.partialJson += frame.data.delta.partial_json;
        }
        break;
      }
      case "content_block_stop": {
        if (openToolCall !== null) {
          toolCalls.push({
            id: openToolCall.id,
            name: openToolCall.name,
            input: parseToolInput(openToolCall.partialJson, openToolCall.name),
          });
          openToolCall = null;
        }
        break;
      }
      case "message_delta": {
        const frame = messageDeltaSchema.safeParse(json);
        if (frame.success) {
          outputTokens = frame.data.usage?.output_tokens ?? outputTokens;
          stopReason = frame.data.delta?.stop_reason ?? stopReason;
        }
        break;
      }
    }
  }
  return {
    text,
    toolCalls,
    usage: {
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
    },
    wantsTools: stopReason === "tool_use" || toolCalls.length > 0,
  };
}

// ----------------------------------------------------------------------------
// OpenAI-compatible chat completions (non-streaming in v0 — one final delta)
// ----------------------------------------------------------------------------

function openAiMessages(messages: readonly ChatMessage[]): unknown[] {
  const out: unknown[] = [];
  for (const message of messages) {
    switch (message.role) {
      case "user":
        out.push({ role: "user", content: message.text });
        break;
      case "assistant":
        out.push({
          role: "assistant",
          content: message.text.length > 0 ? message.text : null,
          ...(message.toolCalls.length > 0
            ? {
                tool_calls: message.toolCalls.map((call) => ({
                  id: call.id,
                  type: "function",
                  function: { name: call.name, arguments: JSON.stringify(call.input) },
                })),
              }
            : {}),
        });
        break;
      case "tool_results":
        for (const result of message.results) {
          out.push({ role: "tool", tool_call_id: result.id, content: result.content });
        }
        break;
    }
  }
  return out;
}

const openAiResponseSchema = z.looseObject({
  choices: z
    .array(
      z.looseObject({
        finish_reason: z.string().nullable().optional(),
        message: z.looseObject({
          content: z.string().nullable().optional(),
          tool_calls: z
            .array(
              z.looseObject({
                id: z.string(),
                function: z.looseObject({ name: z.string(), arguments: z.string() }),
              }),
            )
            .optional(),
        }),
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

export async function chatOpenAi(args: ChatArgs, io: ProviderIo = {}): Promise<ChatTurn> {
  const doFetch = io.fetchImpl ?? fetch;
  const response = await withRetry(io, async () => {
    const res = await doFetch(`${args.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(args.apiKey !== null ? { authorization: `Bearer ${args.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: args.model,
        messages: openAiMessages(args.messages),
        ...(args.tools.length > 0
          ? {
              tools: args.tools.map((tool) => ({
                type: "function",
                function: {
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.inputSchema,
                },
              })),
            }
          : {}),
      }),
    });
    if (!res.ok) throw new ProviderHttpError(res.status, await res.text());
    return res;
  });

  const parsed = openAiResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new EngineError("PROVIDER_ERROR", "Provider returned a malformed chat completion.");
  }
  const choice = parsed.data.choices[0];
  const text = choice?.message.content ?? "";
  if (text.length > 0) io.onDelta?.(text);
  const toolCalls: ToolCallRequest[] = (choice?.message.tool_calls ?? []).map((call) => ({
    id: call.id,
    name: call.function.name,
    input: parseToolInput(call.function.arguments, call.function.name),
  }));
  const usage = parsed.data.usage;
  return {
    text,
    toolCalls,
    usage: {
      ...(usage?.prompt_tokens !== undefined ? { inputTokens: usage.prompt_tokens } : {}),
      ...(usage?.completion_tokens !== undefined ? { outputTokens: usage.completion_tokens } : {}),
    },
    wantsTools: choice?.finish_reason === "tool_calls" || toolCalls.length > 0,
  };
}

// ----------------------------------------------------------------------------
// Shared plumbing
// ----------------------------------------------------------------------------

/** Model-produced tool input is untrusted (CODE_QUALITY §2.1): parse, demand a JSON object. */
function parseToolInput(raw: string, toolName: string): Record<string, unknown> {
  const value = raw.trim().length === 0 ? {} : safeJson(raw);
  if (isPlainObject(value) && isJsonValue(value)) {
    return value;
  }
  throw new EngineError(
    "PROVIDER_ERROR",
    `The model produced malformed input for tool "${toolName}" (not a JSON object).`,
  );
}

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

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// SPDX-License-Identifier: Apache-2.0

// Provider adapters for the agent() leaf — two wire protocols cover everything (SPEC §2.3):
// Anthropic's Messages API (streamed) and OpenAI-style chat completions (the lingua franca of
// OpenAI, Google's compat surface, vLLM, Ollama, Together, Fireworks, Groq…). Each adapter
// maps the loop's neutral conversation (conversation.ts) to its wire format and executes ONE
// model turn; the tool loop itself lives in leaf.ts.
//
// Zero SDK dependencies: plain fetch + Zod-validated responses (a provider's response is a
// trust boundary like any other). Retry policy: exponential backoff with
// jitter on 429/5xx/network errors; a non-rate-limit 4xx never retries.

import { z } from "zod";
import type { NormalizedReasoning } from "@boardwalk-labs/workflow";
import { EngineError } from "../errors.js";
import { isJsonValue, isPlainObject } from "../json_value.js";
import type {
  ChatMessage,
  ChatTurn,
  ContentPart,
  FileSource,
  ToolCallRequest,
  ToolSpec,
} from "./conversation.js";
import {
  reasoningToAnthropicThinking,
  reasoningToOpenAiEffort,
  reasoningToUnified,
} from "./reasoning.js";
import { sseDataLines } from "./sse.js";

export interface ChatArgs {
  baseUrl: string;
  apiKey: string | null;
  /** Extra request headers (custom auth schemes etc.). WIN over computed auth on collision;
   *  content-type stays engine-owned. */
  headers?: Record<string, string>;
  /** Opaque model string, sent verbatim. */
  model: string;
  messages: readonly ChatMessage[];
  tools: readonly ToolSpec[];
  /** Anthropic requires max_tokens; this default is deliberately generous. */
  maxTokens?: number;
  /** Reasoning-effort control, already normalized (SDK `normalizeReasoning`). Encoded per protocol:
   *  the Anthropic adapters derive a `thinking` token budget; the OpenAI adapter emits the unified
   *  `reasoning` object on the managed lane, or `reasoning_effort` otherwise (`reasoningStyle`). */
  reasoning?: NormalizedReasoning;
  /** How the OpenAI adapter encodes `reasoning`: `"unified"` (the managed lane → the unified
   *  `reasoning` object) or `"openai_effort"` (a BYO OpenAI-compatible endpoint → `reasoning_effort`).
   *  Ignored by the Anthropic/Bedrock adapters. Defaults to `"openai_effort"`. */
  reasoningStyle?: "unified" | "openai_effort";
  /** AWS region + SigV4 credentials — present only for the bedrock protocol (chatBedrock). */
  aws?:
    | {
        region: string;
        accessKeyId: string;
        secretAccessKey: string;
        sessionToken?: string | undefined;
      }
    | undefined;
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
export class ProviderHttpError extends Error {
  readonly status: number;
  constructor(status: number, body: string) {
    super(`provider returned ${String(status)}: ${body.slice(0, 300)}`);
    this.status = status;
  }
}

// ----------------------------------------------------------------------------
// Anthropic Messages API (streaming)
// ----------------------------------------------------------------------------

/**
 * The Anthropic Messages request body, MINUS the transport-specific fields (`model`, `stream`,
 * and — for Bedrock — `anthropic_version`). Shared so the BYO Bedrock adapter (bedrock.ts) builds
 * the exact same body: Bedrock speaks the Anthropic Messages schema but takes the model from the
 * URL and stamps its own `anthropic_version`.
 */
export function anthropicMessagesBody(args: {
  messages: readonly ChatMessage[];
  tools: readonly ToolSpec[];
  maxTokens?: number;
  reasoning?: NormalizedReasoning;
}): Record<string, unknown> {
  const baseMaxTokens = args.maxTokens ?? DEFAULT_MAX_TOKENS;
  // Extended thinking: an effort level becomes a token budget (Anthropic takes a budget, not an
  // effort), and max_tokens is grown when needed to stay strictly above it. Off when no reasoning.
  const thinking = reasoningToAnthropicThinking(args.reasoning, baseMaxTokens);
  const messages = anthropicMessages(args.messages);
  const tools = args.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }));
  // Prompt caching. Unlike the OpenAI-family endpoints — which cache implicitly, so an append-only
  // loop earns the discount for free — Anthropic caches NOTHING without an explicit breakpoint. A
  // tool loop re-sends its whole transcript every turn, so uncached that is quadratic spend at full
  // price. Mark in place, only when a later turn could actually read the write (see shouldCache).
  if (shouldCacheAnthropic(args.messages, args.tools)) {
    markAnthropicBreakpoints(messages, tools);
  }
  return {
    max_tokens: thinking?.maxTokens ?? baseMaxTokens,
    messages,
    ...(thinking !== undefined ? { thinking: thinking.thinking } : {}),
    ...(tools.length > 0 ? { tools } : {}),
  };
}

/**
 * Whether this request's cache WRITE could ever be read back. A write costs a ~25% premium, so a
 * genuine single-shot (no tools, no conversation yet) should not pay it — nothing will re-send this
 * prefix. Tools present ⇒ the leaf can take another turn that re-sends and reads this prefix; an
 * assistant turn present ⇒ a conversation is already accreting. Mirrors the managed lane's
 * `requestCanReuseCachedPrefix` so both lanes make the same call.
 */
function shouldCacheAnthropic(
  messages: readonly ChatMessage[],
  tools: readonly ToolSpec[],
): boolean {
  return tools.length > 0 || messages.some((m) => m.role === "assistant");
}

/** Attach an ephemeral cache breakpoint to an Anthropic content block, in place. */
function markCacheControl(block: unknown): void {
  if (typeof block === "object" && block !== null) {
    (block as Record<string, unknown>).cache_control = { type: "ephemeral" };
  }
}

/**
 * Place the cache breakpoints, IN PLACE. Anthropic caches the prefix up to and including each marked
 * block, and allows at most 4 breakpoints — it reads the LONGEST matching prefix among them, so the
 * useful shape is a couple of stable anchors plus one that rolls with the conversation:
 *
 *  1. the LAST tool definition — the tool schemas are big and byte-identical every turn;
 *  2. the LAST block of the FIRST message — the task + preamble, fixed for the leaf's lifetime;
 *  3. the LAST block of the LAST message — rolls forward each turn, so the growing transcript
 *     caches too. Without this the cached prefix would freeze at the task and every turn would
 *     re-read the whole transcript at full price — the bug this exists to avoid.
 *
 * Markers are placed fresh on each request (the body is rebuilt per turn), so a stale marker can
 * never pin a breakpoint to a frozen offset — the thing that has to be stripped when a caller mutates
 * a retained body instead.
 */
function markAnthropicBreakpoints(messages: unknown[], tools: Record<string, unknown>[]): void {
  const lastTool = tools[tools.length - 1];
  if (lastTool !== undefined) markCacheControl(lastTool);

  const anchors = [messages[0], messages[messages.length - 1]];
  for (const message of anchors) {
    if (typeof message !== "object" || message === null) continue;
    const content = (message as Record<string, unknown>).content;
    if (!Array.isArray(content) || content.length === 0) continue;
    markCacheControl(content[content.length - 1]);
  }
}

/** A file's MIME type → the modality an adapter renders it as. `image/*` is a native image block on
 *  both providers; anything else (PDFs, office docs) is a document block. */
function fileKind(mimeType: string): "image" | "document" {
  return mimeType.startsWith("image/") ? "image" : "document";
}

/** Anthropic content `source` for a file part: a base64 blob, or a URL the API fetches. Exactly one
 *  of `data`/`url` is set on the neutral `FileSource`; base64 wins if (defensively) both are. */
function anthropicSource(file: FileSource): Record<string, unknown> {
  return file.data !== undefined
    ? { type: "base64", media_type: file.mimeType, data: file.data }
    : { type: "url", url: file.url };
}

/** Neutral content → Anthropic content blocks. Files ride natively — an `image` block for `image/*`
 *  and a `document` block otherwise — valid in both a user message and a `tool_result` (Anthropic
 *  accepts image and document blocks inside tool results). A bare string is a single text block. */
function anthropicContentBlocks(content: string | readonly ContentPart[]): unknown[] {
  const parts = typeof content === "string" ? [{ type: "text" as const, text: content }] : content;
  return parts.map((part) => {
    if (part.type === "text") return { type: "text", text: part.text };
    const source = anthropicSource(part.file);
    if (fileKind(part.file.mimeType) === "image") return { type: "image", source };
    return {
      type: "document",
      source,
      ...(part.file.filename !== undefined ? { title: part.file.filename } : {}),
    };
  });
}

function anthropicMessages(messages: readonly ChatMessage[]): unknown[] {
  return messages.map((message) => {
    switch (message.role) {
      case "user":
        return { role: "user", content: anthropicContentBlocks(message.content) };
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
            content:
              typeof result.content === "string"
                ? result.content
                : anthropicContentBlocks(result.content),
            is_error: result.isError,
          })),
        };
    }
  });
}

const frameHeadSchema = z.looseObject({ type: z.string() });
/**
 * Anthropic splits the prompt across THREE counters: `input_tokens` counts only the UNCACHED
 * remainder, while cache-served and cache-written tokens are reported separately. So `input_tokens`
 * alone is not the context size — with caching on it collapses to the per-turn delta.
 *
 * That distinction is load-bearing, not cosmetic. The leaf calibrates its context estimate against
 * the input tokens a turn reports (leaf.ts), and it decides when to compact from that. Report only
 * `input_tokens` and the conversation looks tiny, compaction never fires, and the request grows past
 * the model's window — exactly the overflow the token budget exists to prevent, reintroduced by
 * turning caching on. The OpenAI-family `prompt_tokens` already INCLUDES its cached subset, so
 * summing here also makes the two protocols mean the same thing.
 */
const anthropicUsageSchema = z.looseObject({
  input_tokens: z.number().int().nonnegative().optional(),
  cache_read_input_tokens: z.number().int().nonnegative().optional(),
  cache_creation_input_tokens: z.number().int().nonnegative().optional(),
});

/** Total prompt tokens for a turn: the uncached remainder plus everything served from, or written
 *  to, the cache. Exported for unit testing + reuse by the Bedrock adapter (same wire schema). */
export function anthropicPromptTokens(usage: {
  input_tokens?: number | undefined;
  cache_read_input_tokens?: number | undefined;
  cache_creation_input_tokens?: number | undefined;
}): number | undefined {
  const parts = [
    usage.input_tokens,
    usage.cache_read_input_tokens,
    usage.cache_creation_input_tokens,
  ].filter((n): n is number => typeof n === "number");
  return parts.length === 0 ? undefined : parts.reduce((a, b) => a + b, 0);
}

const messageStartSchema = z.looseObject({
  message: z.looseObject({ usage: anthropicUsageSchema }),
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
        "anthropic-version": "2023-06-01",
        ...(args.apiKey !== null ? { "x-api-key": args.apiKey } : {}),
        // Custom headers win over computed auth (the point: non-standard auth schemes);
        // content-type comes last — the engine owns the body format.
        ...args.headers,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: args.model,
        stream: true,
        ...anthropicMessagesBody(args),
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
        if (frame.success) {
          inputTokens = anthropicPromptTokens(frame.data.message.usage) ?? inputTokens;
        }
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
// OpenAI-compatible chat completions (STREAMED — SSE chunks)
//
// We request `stream: true` so the provider sends tokens incrementally: text deltas drive
// io.onDelta live, and the connection keeps producing bytes throughout a long generation (so a
// hosted relay / idle-timeout can't sever a slow turn — e.g. heavy reasoning). Tool calls stream as
// indexed deltas (id+name first, arguments accreted); usage rides a final chunk requested via
// `stream_options.include_usage`.
// ----------------------------------------------------------------------------

/** The URL an OpenAI-compatible content item uses for a file: a passed-through remote/`data:` URL, or
 *  a base64 `data:` URI built from inline bytes. Exactly one of `data`/`url` is set; base64 wins. */
function openAiFileUrl(file: FileSource): string {
  return file.data !== undefined ? `data:${file.mimeType};base64,${file.data}` : (file.url ?? "");
}

/** Neutral content part → an OpenAI-compatible content item (for USER messages; `tool` messages are
 *  text-only and handled by the tool-result split below). `image/*` → an `image_url` item;
 *  everything else → a `file` item (OpenAI's document input, e.g. PDFs). */
function openAiContentItem(part: ContentPart): unknown {
  if (part.type === "text") return { type: "text", text: part.text };
  const url = openAiFileUrl(part.file);
  if (fileKind(part.file.mimeType) === "image") {
    return { type: "image_url", image_url: { url } };
  }
  return {
    type: "file",
    file: {
      file_data: url,
      ...(part.file.filename !== undefined ? { filename: part.file.filename } : {}),
    },
  };
}

function openAiMessages(messages: readonly ChatMessage[]): unknown[] {
  const out: unknown[] = [];
  for (const message of messages) {
    switch (message.role) {
      case "user":
        out.push({
          role: "user",
          content:
            typeof message.content === "string"
              ? message.content
              : message.content.map(openAiContentItem),
        });
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
      case "tool_results": {
        // Emit every tool message FIRST (each answers its tool_call_id), then any files (images and
        // documents) as one trailing user message. OpenAI-compatible `tool` messages are TEXT-ONLY (a
        // file on a tool message is rejected: "Image URLs are only allowed for messages with role
        // 'user'"), and the tool block must stay contiguous after the assistant's tool_calls — so
        // files can't be interleaved between tool messages. This keeps the tool_call ↔ tool_result
        // pairing intact while still delivering the bytes (the portable pattern).
        const files: ContentPart[] = [];
        for (const result of message.results) {
          if (typeof result.content === "string") {
            out.push({ role: "tool", tool_call_id: result.id, content: result.content });
            continue;
          }
          const text = result.content
            .filter((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text")
            .map((p) => p.text)
            .join("\n");
          files.push(...result.content.filter((p) => p.type === "file"));
          out.push({
            role: "tool",
            tool_call_id: result.id,
            content: text.length > 0 ? text : "[see file in the following message]",
          });
        }
        if (files.length > 0) {
          out.push({ role: "user", content: files.map(openAiContentItem) });
        }
        break;
      }
    }
  }
  return out;
}

/** The reasoning field(s) for an OpenAI-compatible body: the unified `reasoning` object on the
 *  managed lane, else OpenAI's `reasoning_effort` string. Empty when there is nothing to send. */
function openAiReasoningFields(
  reasoning: NormalizedReasoning | undefined,
  style: "unified" | "openai_effort" | undefined,
): Record<string, unknown> {
  if (reasoning === undefined) return {};
  if (style === "unified") {
    const unified = reasoningToUnified(reasoning);
    return unified !== undefined ? { reasoning: unified } : {};
  }
  const effort = reasoningToOpenAiEffort(reasoning);
  return effort !== undefined ? { reasoning_effort: effort } : {};
}

// One streamed chat-completion chunk: a `choices[].delta` (content + indexed tool_call fragments)
// and, on the final chunk (requested via stream_options.include_usage), a `usage` object.
const openAiStreamChunkSchema = z.looseObject({
  choices: z
    .array(
      z.looseObject({
        finish_reason: z.string().nullable().optional(),
        delta: z
          .looseObject({
            content: z.string().nullable().optional(),
            tool_calls: z
              .array(
                z.looseObject({
                  index: z.number().int().nonnegative(),
                  id: z.string().optional(),
                  function: z
                    .looseObject({
                      name: z.string().optional(),
                      arguments: z.string().optional(),
                    })
                    .optional(),
                }),
              )
              .optional(),
          })
          .optional(),
      }),
    )
    .optional(),
  usage: z
    .looseObject({
      prompt_tokens: z.number().int().nonnegative().optional(),
      completion_tokens: z.number().int().nonnegative().optional(),
    })
    .nullable()
    .optional(),
});

export async function chatOpenAi(args: ChatArgs, io: ProviderIo = {}): Promise<ChatTurn> {
  const doFetch = io.fetchImpl ?? fetch;
  const response = await withRetry(io, async () => {
    const res = await doFetch(`${args.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        ...(args.apiKey !== null ? { authorization: `Bearer ${args.apiKey}` } : {}),
        // Custom headers win over computed auth (the point: non-standard auth schemes);
        // content-type comes last — the engine owns the body format.
        ...args.headers,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: args.model,
        messages: openAiMessages(args.messages),
        // Stream so a long generation produces bytes continuously (no idle-timeout sever) and text
        // arrives live; `include_usage` asks for the terminal usage chunk.
        stream: true,
        stream_options: { include_usage: true },
        ...openAiReasoningFields(args.reasoning, args.reasoningStyle),
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

  let text = "";
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let finishReason: string | null = null;
  // Tool calls stream as indexed deltas: id + name arrive (usually in the first fragment for an
  // index), then `arguments` accrete across fragments. Assemble by index, in index order.
  const toolAcc = new Map<number, { id: string; name: string; args: string }>();

  for await (const data of sseDataLines(response)) {
    const parsed = openAiStreamChunkSchema.safeParse(safeJson(data));
    if (!parsed.success) continue; // unknown/non-JSON frames are forward-compat, not errors
    const choice = parsed.data.choices?.[0];
    if (choice !== undefined) {
      const chunk = choice.delta?.content;
      if (chunk !== undefined && chunk !== null && chunk.length > 0) {
        text += chunk;
        io.onDelta?.(chunk);
      }
      for (const tc of choice.delta?.tool_calls ?? []) {
        const cur = toolAcc.get(tc.index) ?? { id: "", name: "", args: "" };
        if (tc.id !== undefined) cur.id = tc.id;
        if (tc.function?.name !== undefined) cur.name = tc.function.name;
        if (tc.function?.arguments !== undefined) cur.args += tc.function.arguments;
        toolAcc.set(tc.index, cur);
      }
      if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
        finishReason = choice.finish_reason;
      }
    }
    if (parsed.data.usage !== undefined && parsed.data.usage !== null) {
      inputTokens = parsed.data.usage.prompt_tokens ?? inputTokens;
      outputTokens = parsed.data.usage.completion_tokens ?? outputTokens;
    }
  }

  const toolCalls: ToolCallRequest[] = [...toolAcc.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, tool]) => ({
      id: tool.id.length > 0 ? tool.id : `call-${String(index + 1)}`,
      name: tool.name,
      input: parseToolInput(tool.args, tool.name),
    }));

  return {
    text,
    toolCalls,
    usage: {
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
    },
    wantsTools: finishReason === "tool_calls" || toolCalls.length > 0,
  };
}

// ----------------------------------------------------------------------------
// Shared plumbing
// ----------------------------------------------------------------------------

/** Model-produced tool input is untrusted: parse, demand a JSON object. Shared with bedrock.ts. */
export function parseToolInput(raw: string, toolName: string): Record<string, unknown> {
  const value = raw.trim().length === 0 ? {} : safeJson(raw);
  if (isPlainObject(value) && isJsonValue(value)) {
    return value;
  }
  throw new EngineError(
    "PROVIDER_ERROR",
    `The model produced malformed input for tool "${toolName}" (not a JSON object).`,
  );
}

/** Retry transient failures (429/5xx/network) with exponential backoff + jitter. Shared with
 *  bedrock.ts so every adapter classifies + backs off identically. */
export async function withRetry<T>(io: ProviderIo, fn: () => Promise<T>): Promise<T> {
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

export function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

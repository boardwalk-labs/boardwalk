// SPDX-License-Identifier: Apache-2.0

// BYO Amazon Bedrock adapter for the agent() leaf — a third wire transport on top of the two
// protocols (SPEC §2.3). Bedrock speaks the ANTHROPIC Messages schema for Anthropic models, so the
// body is built by the shared `anthropicMessagesBody` (providers.ts): same messages/tools/system
// rendering as the direct Anthropic adapter. Two differences only — the model rides in the URL
// (not the body), and the body carries `anthropic_version: "bedrock-2023-05-31"`.
//
// Auth is AWS SigV4 (sigv4.ts), hand-rolled on node:crypto — Bedrock has no API-key shape, so the
// other adapters' bearer/x-api-key path doesn't apply. Credentials come from the engine
// environment (resolve.ts), never inline config, and are redacted like any provider key.
//
// v1 is NON-STREAMING: one `InvokeModel` POST, the full Anthropic JSON response parsed in one shot,
// the assistant text emitted via a single io.onDelta so the event stream still shows text.
// STREAMING (InvokeModelWithResponseStream) is DEFERRED — it speaks the AWS binary event-stream
// (vnd.amazon.eventstream) framing, a codec worth its own change; the loop's observable behavior
// is unaffected (text still arrives, just in one block).

import { z } from "zod";
import { EngineError } from "../errors.js";
import { isJsonValue, isPlainObject } from "../json_value.js";
import type { ChatTurn, ToolCallRequest } from "./conversation.js";
import {
  anthropicMessagesBody,
  parseToolInput,
  ProviderHttpError,
  withRetry,
  type ChatArgs,
  type ProviderIo,
} from "./providers.js";
import { signRequest, type AwsCredentials } from "./sigv4.js";

const BEDROCK_SERVICE = "bedrock";
// Bedrock requires the Anthropic schema version be pinned in the body (NOT the `anthropic-version`
// header the direct API uses); this is the value AWS documents for the Messages API on Bedrock.
const BEDROCK_ANTHROPIC_VERSION = "bedrock-2023-05-31";

// The non-streaming Anthropic Messages response InvokeModel returns: an array of content blocks
// (text + tool_use), a stop_reason, and token usage. A trust boundary like any provider response.
const bedrockResponseSchema = z.looseObject({
  content: z
    .array(
      z.looseObject({
        type: z.string(),
        text: z.string().optional(),
        id: z.string().optional(),
        name: z.string().optional(),
        input: z.unknown().optional(),
      }),
    )
    .optional(),
  stop_reason: z.string().nullable().optional(),
  usage: z
    .looseObject({
      input_tokens: z.number().int().nonnegative().optional(),
      output_tokens: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

/** One Bedrock model turn. `args.aws` carries the region + SigV4 credentials (required here). */
export async function chatBedrock(args: ChatArgs, io: ProviderIo = {}): Promise<ChatTurn> {
  const aws = args.aws;
  if (aws === undefined) {
    // The seam resolves bedrock providers WITH aws creds; reaching here without them is a bug,
    // not user input — fail with an engine code rather than signing an empty credential.
    throw new EngineError("INTERNAL", "Bedrock adapter invoked without AWS credentials.");
  }
  const doFetch = io.fetchImpl ?? fetch;
  const body = JSON.stringify({
    anthropic_version: BEDROCK_ANTHROPIC_VERSION,
    ...anthropicMessagesBody(args),
  });
  // The model id lives in the path; encode it so a colon/slash in the id can't break the URL.
  const url = `${args.baseUrl}/model/${encodeURIComponent(args.model)}/invoke`;

  const credentials: AwsCredentials = {
    accessKeyId: aws.accessKeyId,
    secretAccessKey: aws.secretAccessKey,
    ...(aws.sessionToken !== undefined ? { sessionToken: aws.sessionToken } : {}),
  };

  const response = await withRetry(io, async () => {
    // Re-sign on every attempt: the signature is bound to x-amz-date, so a retry minutes later
    // needs a fresh timestamp (AWS rejects a stale one). Custom headers go in before signing so
    // they're covered; the engine still owns content-type.
    const signed = signRequest(
      {
        method: "POST",
        url,
        headers: { ...args.headers, "content-type": "application/json" },
        body,
      },
      { region: aws.region, service: BEDROCK_SERVICE, credentials, date: new Date() },
    );
    const res = await doFetch(url, { method: "POST", headers: signed.headers, body });
    if (!res.ok) throw new ProviderHttpError(res.status, await res.text());
    return res;
  });

  const parsed = bedrockResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new EngineError("PROVIDER_ERROR", "Bedrock returned a malformed Anthropic response.");
  }

  let text = "";
  const toolCalls: ToolCallRequest[] = [];
  for (const block of parsed.data.content ?? []) {
    if (block.type === "text") {
      text += block.text ?? "";
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id ?? `call-${String(toolCalls.length + 1)}`,
        name: block.name ?? "",
        // Bedrock returns tool input as a parsed JSON object (not the streamed partial-json string
        // the direct API deltas); re-validate it's an object, reusing the shared guard.
        input: toolInput(block.input, block.name ?? ""),
      });
    }
  }
  // v1: emit the whole assistant text once so the stream still shows it (no per-token deltas).
  if (text.length > 0) io.onDelta?.(text);

  const usage = parsed.data.usage;
  return {
    text,
    toolCalls,
    usage: {
      ...(usage?.input_tokens !== undefined ? { inputTokens: usage.input_tokens } : {}),
      ...(usage?.output_tokens !== undefined ? { outputTokens: usage.output_tokens } : {}),
    },
    wantsTools: parsed.data.stop_reason === "tool_use" || toolCalls.length > 0,
  };
}

/** A tool_use block's `input` is already-parsed JSON here; demand an object, like parseToolInput. */
function toolInput(value: unknown, toolName: string): Record<string, unknown> {
  if (isPlainObject(value) && isJsonValue(value)) return value;
  // Fall back through the string path for the rare model that stringifies its input.
  if (typeof value === "string") return parseToolInput(value, toolName);
  throw new EngineError(
    "PROVIDER_ERROR",
    `The model produced malformed input for tool "${toolName}" (not a JSON object).`,
  );
}

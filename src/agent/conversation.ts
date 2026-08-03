// SPDX-License-Identifier: Apache-2.0

// The provider-neutral conversation model for the agent() loop. The leaf builds these;
// each protocol adapter maps them to its wire format. Keeping the loop neutral is what lets
// two adapters (Anthropic + OpenAI-compatible) cover every supported endpoint.

/** A tool the model may call, as advertised to the provider. */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** A tool invocation the model requested in an assistant turn. */
export interface ToolCallRequest {
  /** Provider-assigned call id — echoed back with the result. */
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * A single piece of user- or tool-result content. Files (images and documents) travel UP to the
 * model only (user prompts, attachments, and tool results); a model never EMITS a file, so assistant
 * content stays text-only.
 */
export type ContentPart = { type: "text"; text: string } | { type: "file"; file: FileSource };

/**
 * A binary asset the model can read — an image (`image/*`) or a document (`application/pdf`, …).
 * `mimeType` decides how each adapter renders it: `image/*` becomes a native image block, everything
 * else a document block. The bytes are carried one of two ways, and EXACTLY ONE is set:
 *  - `data`: inline base64 — provider-portable, the default form for locally-produced bytes.
 *  - `url`: a `data:` URI or a remote `https:` URL the provider fetches. Remote URLs keep the wire
 *    payload small but aren't accepted by every provider/modality (see the adapters).
 * `filename` is an optional display/label hint, meaningful mainly for documents.
 */
export interface FileSource {
  mimeType: string;
  data?: string;
  url?: string;
  filename?: string;
}

export type ChatMessage =
  | { role: "user"; content: string | readonly ContentPart[] }
  | { role: "assistant"; text: string; toolCalls: readonly ToolCallRequest[] }
  | { role: "tool_results"; results: readonly ToolResultMessage[] };

export interface ToolResultMessage {
  /** The ToolCallRequest id this answers. */
  id: string;
  /** Result content: a bare string (the common case — already stringified + redacted by the loop),
   *  or content parts when a tool returns image data alongside its text. A bare string is exactly
   *  one text part. */
  content: string | readonly ContentPart[];
  isError: boolean;
}

const IMAGE_PRUNED_TEXT =
  "[image removed from context to save space; take a new screenshot if needed]";

/**
 * Replace image parts in all but the newest `keep` image-bearing tool results with a text
 * placeholder — screenshots dominate a desktop leaf's context, and keep-last-N is the field
 * default. The one deliberate exception to the loop's append-only cache discipline: the token
 * savings dwarf the invalidated cache suffix.
 */
export function pruneStaleImages(messages: ChatMessage[], keep: number): void {
  const bearing: { msg: number; result: number }[] = [];
  messages.forEach((message, msgIdx) => {
    if (message.role !== "tool_results") return;
    message.results.forEach((result, resIdx) => {
      if (typeof result.content === "string") return;
      if (result.content.some(isImagePart)) bearing.push({ msg: msgIdx, result: resIdx });
    });
  });
  const stale = bearing.slice(0, Math.max(0, bearing.length - keep));
  if (stale.length === 0) return;
  const staleByMsg = new Map<number, Set<number>>();
  for (const { msg, result } of stale) {
    const set = staleByMsg.get(msg) ?? new Set<number>();
    set.add(result);
    staleByMsg.set(msg, set);
  }
  for (const [msgIdx, resultIdxs] of staleByMsg) {
    const message = messages[msgIdx];
    if (message === undefined || message.role !== "tool_results") continue;
    messages[msgIdx] = {
      role: "tool_results",
      results: message.results.map((result, resIdx) => {
        if (!resultIdxs.has(resIdx) || typeof result.content === "string") return result;
        return {
          ...result,
          content: result.content.map(
            (part): ContentPart =>
              isImagePart(part) ? { type: "text", text: IMAGE_PRUNED_TEXT } : part,
          ),
        };
      }),
    };
  }
}

function isImagePart(part: ContentPart): boolean {
  return part.type === "file" && part.file.mimeType.startsWith("image/");
}

/** One model turn: final text and/or tool-call requests, plus usage. */
export interface ChatTurn {
  text: string;
  toolCalls: ToolCallRequest[];
  usage: { inputTokens?: number | undefined; outputTokens?: number | undefined };
  /** True when the model stopped to call tools (the loop continues). */
  wantsTools: boolean;
}

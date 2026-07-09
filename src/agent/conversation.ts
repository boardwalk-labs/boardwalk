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
 * A single piece of user- or tool-result content. Images travel UP to the model only (user prompts
 * and tool results); a model never EMITS an image, so assistant content stays text-only. The neutral
 * form is inline base64 (`data`) + a MIME type — both provider adapters accept it, whereas a signed
 * URL would expire and isn't uniformly supported.
 */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; image: { data: string; mimeType: string } };

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

/** One model turn: final text and/or tool-call requests, plus usage. */
export interface ChatTurn {
  text: string;
  toolCalls: ToolCallRequest[];
  usage: { inputTokens?: number | undefined; outputTokens?: number | undefined };
  /** True when the model stopped to call tools (the loop continues). */
  wantsTools: boolean;
}

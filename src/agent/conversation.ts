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

export type ChatMessage =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; toolCalls: readonly ToolCallRequest[] }
  | { role: "tool_results"; results: readonly ToolResultMessage[] };

export interface ToolResultMessage {
  /** The ToolCallRequest id this answers. */
  id: string;
  /** Result content, already stringified (and redacted) by the loop. */
  content: string;
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

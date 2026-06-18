// SPDX-License-Identifier: Apache-2.0

// @boardwalk-labs/engine/core — the agent execution core, consumable on its own.
//
// The single-node engine (`@boardwalk-labs/engine`) wires this core to a scheduler, SQLite
// store, and HTTP server. A DIFFERENT runtime (e.g. a hosted platform with its own scheduling,
// storage, and credential broker) imports THIS entrypoint instead: it runs the exact same agent
// loop (`runAgentLeaf`) by supplying its own `LeafIo` implementation, so behavior is identical
// everywhere and there is only one agent loop to maintain. Nothing here imports the engine's
// scheduler/store/server — only the loop, the seam a host implements, and the model machinery a
// host (or its broker) calls.
//
// The only thing a host varies is the `LeafIo` seam: how the model call is made (directly with a
// key, or routed through a broker), how secrets resolve, where events go. The loop itself does not
// change. See docs in `src/agent/leaf.ts`.

// ---- The loop + the seam a host implements ----
export { runAgentLeaf } from "./agent/leaf.js";
export type {
  LeafIo,
  ModelTurnRequest,
  ModelTurnResult,
  LeafEventBody,
  AgentIdentity,
} from "./agent/leaf.js";

// ---- The provider-neutral conversation model (referenced by LeafIo / streamModel) ----
export type {
  ChatMessage,
  ChatTurn,
  ToolCallRequest,
  ToolSpec,
  ToolResultMessage,
} from "./agent/conversation.js";

// ---- Capability context + MCP token result (referenced by LeafIo) ----
export type { ToolSetContext, McpTokenResult } from "./agent/tools.js";

// ---- The host-backed-tool seam (webfetch/web_search/artifacts). A host (the single-node
//      engine in-process, or the platform's broker) implements ToolHost; absent hooks ⇒ absent
//      tools. Carried on ToolSetContext.host. ----
export type { ToolHost, WebSearchResult, FetchResult, ArtifactWriteResult } from "./agent/tools.js";

// ---- The engine-native LSP service backing the `diagnostics` built-in + diagnostics-after-edit.
//      Spawns a language server in the run's workspace (best-effort); carried on
//      ToolSetContext.lspService. A host that runs no language server simply omits it. ----
export { LspService } from "./agent/lsp/index.js";
export type { LspServiceOptions, FileDiagnostics, Diagnostic } from "./agent/lsp/index.js";

// ---- Secret redaction (the host shares one Redactor with the loop; whoever holds a key adds it) ----
export { Redactor } from "./agent/redact.js";

// ---- Provider adapters + request shape. A host's `streamModel` calls these to reach the model
//      (the single-node engine in-process; the hosted platform from its broker). ----
export { chatAnthropic, chatOpenAi } from "./agent/providers.js";
export { chatBedrock } from "./agent/bedrock.js";
export type { ChatArgs, ProviderIo } from "./agent/providers.js";

// ---- Reasoning-effort wire encoders. The neutral `AgentOptions.reasoning` (normalized by the SDK's
//      `normalizeReasoning`) → each provider's wire shape. Exported so the hosted platform's broker
//      encodes IDENTICALLY to the single-node engine's adapters above. ----
export {
  reasoningToAnthropicThinking,
  reasoningToOpenAiEffort,
  reasoningToUnified,
  type AnthropicThinking,
} from "./agent/reasoning.js";

// ---- Model + provider resolution ----
export { resolveModel, BOARDWALK_PROVIDER } from "./agent/resolve.js";
export type {
  ResolvedModel,
  InferenceConfig,
  ProviderConfig,
  AwsProviderConfig,
  ProviderProtocol,
  HeaderValue,
  ResolveArgs,
} from "./agent/resolve.js";

// ---- Errors ----
export { EngineError, isEngineErrorCode } from "./errors.js";
export type { EngineErrorCode } from "./errors.js";

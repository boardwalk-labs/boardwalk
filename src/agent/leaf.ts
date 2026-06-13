// The agent() leaf: a real agentic loop (SDK SPEC §2.1.1) — streamed model turns with tool
// use (program-defined ToolDefs + memory file tools + MCP server tools), skills loaded into
// context, schema output, secret redaction, and usage reporting. Runs IN THE PROGRAM PROCESS
// (tool `execute` must run in the trusted layer, and MCP connections live where their tools
// execute); model/provider/key resolution and MCP OAuth token state stay supervisor-side and
// arrive through `io.resolve` / `io.mcpToken`.

import { randomUUID } from "node:crypto";
import type { AgentOptions, TokenUsage, ToolReturn } from "@boardwalk-labs/workflow";
import { EngineError } from "../errors.js";
import type { ChatMessage, ChatTurn, ToolCallRequest } from "./conversation.js";
import { chatAnthropic, chatOpenAi, type ChatArgs, type ProviderIo } from "./providers.js";
import type { Redactor } from "./redact.js";
import type { ResolvedModel } from "./resolve.js";
import {
  assertUniqueToolNames,
  buildToolSet,
  connectMcpServers,
  type ExecutableTool,
  type McpTokenResult,
  type ToolSetContext,
} from "./tools.js";

/** Tool iterations per agent() call before the loop is declared runaway. */
const MAX_TOOL_ITERATIONS = 25;

/**
 * Identity of one `agent()` leaf, carried on its `turn_started`/`turn_ended` frames so a stream
 * consumer can tell concurrent agents apart. `agentId` is stable and run-unique (engine-assigned);
 * `agentName` is the author's `AgentOptions.name`, present only when they set one.
 */
export interface AgentIdentity {
  agentId: string;
  agentName?: string;
}

/**
 * A leaf event body, scoped to the leaf's turn. `turn_started` itself is emitted by the
 * supervisor when the turn opens (io.startTurn) — the leaf only emits what follows.
 */
export type LeafEventBody =
  | ({
      kind: "turn_ended";
      reason: "complete" | "error";
      usage?: TokenUsage;
      error?: { code: string; message: string };
    } & AgentIdentity)
  | { kind: "text_start"; blockId: string }
  | { kind: "text_delta"; blockId: string; text: string }
  | { kind: "text_end"; blockId: string }
  | { kind: "tool_call_start"; toolCallId: string; toolName: string }
  | { kind: "tool_call_input_complete"; toolCallId: string; input: Record<string, unknown> }
  | { kind: "tool_call_executing"; toolCallId: string }
  | { kind: "tool_call_result"; toolCallId: string; result: ToolReturn }
  | { kind: "tool_call_error"; toolCallId: string; error: { code: string; message: string } };

export interface LeafIo {
  /** This leaf's identity — stamped onto its turn_started (via startTurn) and turn_ended frames. */
  identity: AgentIdentity;
  /** Supervisor-side model resolution (config + key material never live in this process). */
  resolve(model: string | undefined, provider: string | undefined): Promise<ResolvedModel>;
  /** Open a new turn block; subsequent leaf events carry this turnId. */
  startTurn(turnId: string): void;
  emit(turnId: string, body: LeafEventBody): void;
  /** Usage flows to the supervisor — the budget authority — after EVERY model call, so a
   *  long tool loop can be terminated mid-flight. */
  reportUsage(modelRef: string, usage: TokenUsage): void;
  /** Tell the engine a memory dir is in use — it auto-persists it across runs. */
  memoryUsed(dir: string): void;
  /** Broker an MCP OAuth bearer token from the engine (token state never lives here). */
  mcpToken(serverUrl: string, invalidateToken?: string): Promise<McpTokenResult>;
  redactor: Redactor;
  /** Capability context: where the workspace and deployed skills live. */
  capabilities: ToolSetContext;
  provider?: ProviderIo;
}

/** Execute one agent() leaf call; resolves to final text, or the parsed object in schema mode. */
export async function runAgentLeaf(
  prompt: string,
  opts: AgentOptions | undefined,
  io: LeafIo,
): Promise<unknown> {
  const base = buildToolSet(opts, io.capabilities);
  if (base.memoryDir !== null) io.memoryUsed(base.memoryDir);

  // MCP connections open AFTER sync validation and BEFORE the first model call; a server the
  // call named must resolve or the leaf fails here, never silently degrading the tool set.
  const connected =
    base.mcp.length === 0
      ? null
      : await connectMcpServers(base.mcp, {
          mcpToken: (serverUrl, invalidateToken) => io.mcpToken(serverUrl, invalidateToken),
          redactor: io.redactor,
        });
  try {
    return await runLeafWithTools(
      prompt,
      opts,
      io,
      [...base.tools, ...(connected?.tools ?? [])],
      base.preamble,
    );
  } finally {
    // Disconnect on completion AND on error — stdio servers are real child processes.
    if (connected !== null) await connected.disconnect();
  }
}

async function runLeafWithTools(
  prompt: string,
  opts: AgentOptions | undefined,
  io: LeafIo,
  tools: readonly ExecutableTool[],
  preamble: readonly string[],
): Promise<unknown> {
  // Re-check across the MERGED set: a namespaced MCP tool can collide with a program tool.
  assertUniqueToolNames(tools);

  const resolved = await io.resolve(opts?.model, opts?.provider);
  // The provider key (and any env-sourced custom headers) are now known to this process —
  // make sure they can never reach the model.
  if (resolved.apiKey !== null) io.redactor.add(`api-key:${resolved.provider}`, resolved.apiKey);
  for (const name of resolved.secretHeaderNames) {
    const value = resolved.headers[name];
    if (value !== undefined) io.redactor.add(`header:${name}`, value);
  }

  const schemaInstruction =
    opts?.schema === undefined
      ? []
      : [
          `Respond with ONLY a JSON value matching this JSON Schema — no prose, no code fences:\n${JSON.stringify(opts.schema)}`,
        ];
  const firstMessage = [...preamble, prompt, ...schemaInstruction].join("\n\n");

  const turnId = `turn-${randomUUID()}`;
  io.startTurn(turnId);

  const totals: { inputTokens: number; outputTokens: number } = {
    inputTokens: 0,
    outputTokens: 0,
  };
  const messages: ChatMessage[] = [{ role: "user", text: io.redactor.redact(firstMessage) }];

  let finalText: string;
  try {
    finalText = await runToolLoop(messages, tools, resolved, io, turnId, totals);
  } catch (err) {
    // Redact like the tool path does: a misbehaving provider can echo request headers (the
    // API key) into an error body, and this message persists in run_events AND — via the
    // rethrow — in the run's failed row. The secrets invariant covers error paths too.
    const message = io.redactor.redact(err instanceof Error ? err.message : String(err));
    const code = err instanceof EngineError ? err.code : "PROVIDER_ERROR";
    io.emit(turnId, { kind: "turn_ended", ...io.identity, reason: "error", error: { code, message } });
    throw new EngineError(
      code,
      message,
      err instanceof EngineError && err.hint !== undefined
        ? io.redactor.redact(err.hint)
        : undefined,
    );
  }
  io.emit(turnId, {
    kind: "turn_ended",
    ...io.identity,
    reason: "complete",
    usage: { inputTokens: totals.inputTokens, outputTokens: totals.outputTokens },
  });

  return opts?.schema === undefined ? finalText : parseSchemaOutput(finalText);
}

async function runToolLoop(
  messages: ChatMessage[],
  tools: readonly ExecutableTool[],
  resolved: ResolvedModel,
  io: LeafIo,
  turnId: string,
  totals: { inputTokens: number; outputTokens: number },
): Promise<string> {
  for (let iteration = 1; iteration <= MAX_TOOL_ITERATIONS; iteration++) {
    const turn = await modelTurn(messages, tools, resolved, io, turnId, iteration);

    totals.inputTokens += turn.usage.inputTokens ?? 0;
    totals.outputTokens += turn.usage.outputTokens ?? 0;
    io.reportUsage(resolved.model, turn.usage);

    if (!turn.wantsTools || turn.toolCalls.length === 0) {
      return turn.text;
    }

    messages.push({ role: "assistant", text: turn.text, toolCalls: turn.toolCalls });
    const results = [];
    for (const call of turn.toolCalls) {
      results.push(await executeToolCall(call, tools, io, turnId));
    }
    messages.push({ role: "tool_results", results });
  }
  throw new EngineError(
    "PROGRAM_ERROR",
    `agent() exceeded ${String(MAX_TOOL_ITERATIONS)} tool iterations without a final answer.`,
    "The model is looping on tool calls. Tighten the prompt, or split the work across calls.",
  );
}

/** One model call with streamed text events (block ids are unique per iteration). */
async function modelTurn(
  messages: readonly ChatMessage[],
  tools: readonly ExecutableTool[],
  resolved: ResolvedModel,
  io: LeafIo,
  turnId: string,
  iteration: number,
): Promise<ChatTurn> {
  const blockId = `text-${String(iteration)}`;
  let blockOpen = false;
  const providerIo: ProviderIo = {
    ...io.provider,
    onDelta: (text) => {
      if (!blockOpen) {
        blockOpen = true;
        io.emit(turnId, { kind: "text_start", blockId });
      }
      io.emit(turnId, { kind: "text_delta", blockId, text: io.redactor.redact(text) });
    },
  };
  const args: ChatArgs = {
    baseUrl: resolved.baseUrl,
    apiKey: resolved.apiKey,
    headers: resolved.headers,
    model: resolved.model,
    messages,
    tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  };
  const turn =
    resolved.protocol === "anthropic"
      ? await chatAnthropic(args, providerIo)
      : await chatOpenAi(args, providerIo);
  if (blockOpen) io.emit(turnId, { kind: "text_end", blockId });
  return turn;
}

/** Run one tool call; failures return to the MODEL as error results, they don't fail the run. */
async function executeToolCall(
  call: ToolCallRequest,
  tools: readonly ExecutableTool[],
  io: LeafIo,
  turnId: string,
): Promise<{ id: string; content: string; isError: boolean }> {
  io.emit(turnId, { kind: "tool_call_start", toolCallId: call.id, toolName: call.name });
  io.emit(turnId, { kind: "tool_call_input_complete", toolCallId: call.id, input: call.input });

  const tool = tools.find((t) => t.name === call.name);
  if (tool === undefined) {
    // The model invented a tool name — its mistake to recover from, not a run failure.
    const message = `Unknown tool "${call.name}".`;
    io.emit(turnId, {
      kind: "tool_call_error",
      toolCallId: call.id,
      error: { code: "VALIDATION", message },
    });
    return { id: call.id, content: message, isError: true };
  }

  io.emit(turnId, { kind: "tool_call_executing", toolCallId: call.id });
  try {
    // Tool results enter model context → redact (MASTER_SPEC §6.2 covers tool results too).
    const content = io.redactor.redact(await tool.execute(call.input));
    io.emit(turnId, {
      kind: "tool_call_result",
      toolCallId: call.id,
      result: { humanSummary: summarize(content) },
    });
    return { id: call.id, content, isError: false };
  } catch (err) {
    const message = io.redactor.redact(err instanceof Error ? err.message : String(err));
    const code = err instanceof EngineError ? err.code : "PROGRAM_ERROR";
    io.emit(turnId, { kind: "tool_call_error", toolCallId: call.id, error: { code, message } });
    return { id: call.id, content: `Tool failed: ${message}`, isError: true };
  }
}

function summarize(content: string): string {
  const flat = content.replaceAll("\n", " ");
  return flat.length <= 120 ? flat : `${flat.slice(0, 117)}…`;
}

/**
 * Schema mode: parse the model's final text as JSON; a non-JSON answer fails the run (the
 * documented contract). Code fences are stripped first — models add them despite instructions.
 * v0 parity note: like the hosted platform today, the schema drives the PROMPT and the JSON
 * parse; structural validation against the schema itself is a later, cross-engine decision.
 */
function parseSchemaOutput(text: string): unknown {
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*\n?/i, "")
    .replace(/\n?```\s*$/, "");
  try {
    return JSON.parse(stripped);
  } catch {
    throw new EngineError(
      "VALIDATION",
      "agent() was called with a schema but the model's answer was not valid JSON.",
      `Answer started with: ${JSON.stringify(stripped.slice(0, 80))}`,
    );
  }
}

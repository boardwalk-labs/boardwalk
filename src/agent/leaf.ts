// The agent() leaf, v0: single-turn inference with streaming events, secret redaction, schema
// output, and usage reporting. Runs IN THE PROGRAM PROCESS (program-defined tools must execute
// there when the tool loop lands); model/provider/key resolution happens supervisor-side and
// arrives through `io.resolve`.
//
// Capability selections (tools/mcp/skills/memory) are NOT implemented yet — per the
// capability-presence rule (MASTER_SPEC §4) a program asking for them fails loudly here
// instead of silently degrading to bare inference.

import { randomUUID } from "node:crypto";
import type { AgentOptions } from "@boardwalk/workflow";
import type { TokenUsage } from "@boardwalk/workflow";
import { EngineError } from "../errors.js";
import { chatAnthropic, chatOpenAi, type ChatResult, type ProviderIo } from "./providers.js";
import type { Redactor } from "./redact.js";
import type { ResolvedModel } from "./resolve.js";

/**
 * A leaf event body, scoped to the leaf's turn. `turn_started` itself is emitted by the
 * supervisor when the turn opens (io.startTurn) — the leaf only emits what follows.
 */
export type LeafEventBody =
  | {
      kind: "turn_ended";
      reason: "complete" | "error";
      usage?: TokenUsage;
      error?: { code: string; message: string };
    }
  | { kind: "text_start"; blockId: string }
  | { kind: "text_delta"; blockId: string; text: string }
  | { kind: "text_end"; blockId: string };

export interface LeafIo {
  /** Supervisor-side model resolution (config + key material never live in this process). */
  resolve(model: string | undefined, provider: string | undefined): Promise<ResolvedModel>;
  /** Open a new turn block; subsequent leaf events carry this turnId. */
  startTurn(turnId: string): void;
  emit(turnId: string, body: LeafEventBody): void;
  /** Usage flows to the supervisor — the budget authority — as soon as it is known. */
  reportUsage(modelRef: string, usage: TokenUsage): void;
  redactor: Redactor;
  provider?: ProviderIo;
}

/** Execute one agent() leaf call; resolves to final text, or the parsed object in schema mode. */
export async function runAgentLeaf(
  prompt: string,
  opts: AgentOptions | undefined,
  io: LeafIo,
): Promise<unknown> {
  rejectUnimplementedCapabilities(opts);

  const resolved = await io.resolve(opts?.model, opts?.provider);
  // The provider key is now known to this process — make sure it can never reach the model.
  if (resolved.apiKey !== null) io.redactor.add(`api-key:${resolved.provider}`, resolved.apiKey);

  const fullPrompt =
    opts?.schema === undefined
      ? prompt
      : `${prompt}\n\nRespond with ONLY a JSON value matching this JSON Schema — no prose, no code fences:\n${JSON.stringify(opts.schema)}`;
  const redactedPrompt = io.redactor.redact(fullPrompt);

  const turnId = `turn-${randomUUID()}`;
  io.startTurn(turnId);

  const blockId = "text-1";
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

  let result: ChatResult;
  try {
    const args = {
      baseUrl: resolved.baseUrl,
      apiKey: resolved.apiKey,
      modelId: resolved.modelId,
      prompt: redactedPrompt,
    };
    result =
      resolved.protocol === "anthropic"
        ? await chatAnthropic(args, providerIo)
        : await chatOpenAi(args, providerIo);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = err instanceof EngineError ? err.code : "PROVIDER_ERROR";
    io.emit(turnId, { kind: "turn_ended", reason: "error", error: { code, message } });
    throw err;
  }
  if (blockOpen) io.emit(turnId, { kind: "text_end", blockId });
  io.emit(turnId, { kind: "turn_ended", reason: "complete", usage: result.usage });
  io.reportUsage(resolved.ref, result.usage);

  return opts?.schema === undefined ? result.text : parseSchemaOutput(result.text);
}

function rejectUnimplementedCapabilities(opts: AgentOptions | undefined): void {
  const wanted: string[] = [];
  if (opts?.tools !== undefined && opts.tools.length > 0) wanted.push("tools");
  if (opts?.mcp !== undefined && opts.mcp.length > 0) wanted.push("mcp");
  if (opts?.skills !== undefined && opts.skills.length > 0) wanted.push("skills");
  if (opts?.memory !== undefined) wanted.push("memory");
  if (wanted.length > 0) {
    throw new EngineError(
      "UNSUPPORTED",
      `agent() capability selection (${wanted.join(", ")}) is not implemented in this engine build yet.`,
      "The full capability set (tools, MCP, skills, memory) is on the engine roadmap; " +
        "plain agent(prompt) and agent(prompt, { schema }) work today.",
    );
  }
}

/**
 * Schema mode: parse the model's final text as JSON; a non-JSON answer fails the run (the
 * documented contract). Code fences are stripped first — models add them despite instructions.
 * v0 parity note: like Boardwalk Cloud today, the schema drives the PROMPT and the JSON parse;
 * structural validation against the schema itself is a later, cross-engine decision.
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

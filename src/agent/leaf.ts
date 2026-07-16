// SPDX-License-Identifier: Apache-2.0

// The agent() leaf: a real agentic loop (SDK SPEC §2.1.1) — streamed model turns with tool
// use (program-defined ToolDefs + memory file tools + MCP server tools), skills loaded into
// context, schema output, secret redaction, and usage reporting. Runs IN THE PROGRAM PROCESS
// (tool `execute` must run in the trusted layer, and MCP connections live where their tools
// execute); MCP OAuth token state stays supervisor-side and arrives through `io.mcpToken`.
//
// The model call ITSELF is behind the `io.streamModel` seam: the leaf hands over a neutral
// turn request and gets back a turn — it never resolves a model or touches a provider key.
// The local engine's seam impl resolves supervisor-side and calls the provider directly; the
// hosted platform's swaps in a broker that routes the call without the untrusted worker ever
// holding a credential. Same loop, same observable behavior, either way.

import { randomUUID } from "node:crypto";
import { normalizeReasoning } from "@boardwalk-labs/workflow";
import type {
  AgentOptions,
  NormalizedReasoning,
  TokenUsage,
  ToolReturn,
} from "@boardwalk-labs/workflow";
import {
  MIN_COMPACTION_RECLAIM_TOKENS,
  compactionBudget,
  dedupeFileReads,
  estimateConversationTokens,
  estimateTokens,
  planCompaction,
} from "./compaction.js";
import { EngineError, type EngineErrorCode } from "../errors.js";
import type {
  ChatMessage,
  ChatTurn,
  ToolCallRequest,
  ToolResultMessage,
  ToolSpec,
} from "./conversation.js";
import type { ProviderIo } from "./providers.js";
import type { Redactor } from "./redact.js";
import {
  assertUniqueToolNames,
  buildToolSet,
  connectMcpServers,
  leafCwd,
  type ExecutableTool,
  type McpTokenResult,
  type ToolOutputSink,
  type ToolSetContext,
} from "./tools.js";
import { subagentSelected } from "./tools/registry.js";
import { makeSubagentTool } from "./tools/subagent.js";

/**
 * A leaf runs UNBOUNDED by default (no fixed tool-iteration cap): the loop ends when the model stops
 * calling tools, and is otherwise bounded by the run budget (usage is reported after every call, so
 * the budget authority can terminate a long loop), the repetition guard below, and cancellation. An
 * author may set `AgentOptions.maxIterations` to cap a leaf whose scope they know — and a cap is a
 * SOFT landing, not a hard failure: the turn past the ceiling withholds tools so the model must give
 * a final answer from the work it has done. See {@link readMaxIterations} + {@link wrapUpHint}.
 */

/** When a cap is set, warn the model once when this many tool-calling turns remain before it. */
const CAP_WARN_AT = 3;
/** With no cap, remind the model to wrap up every this-many tool-calling turns. */
const TURN_HINT_INTERVAL = 20;

/**
 * Repetition guard. A model that re-issues the SAME tool call(s) is stuck (a loop the 25-iteration
 * cap would only catch after burning every iteration + its tokens). We count how many of the last
 * STALL_WINDOW turns issued the current turn's signature: at STALL_SOFT_NUDGE we inject a one-time
 * nudge to change approach (catches plain repeats AND A/B/A/B oscillation, since the window counts
 * occurrences, not just consecutive ones); at STALL_HARD_STOP we end the run before the next call.
 * A turn whose tool-call SET differs (any real progress) resets the count, so legitimate retries
 * with changed inputs never trip it.
 */
const STALL_WINDOW = 6;
const STALL_SOFT_NUDGE = 3;
const STALL_HARD_STOP = 5;
const STALL_NUDGE_TEXT =
  "[No progress: you have issued the same tool call(s) repeatedly with no new result. Change your " +
  "approach — use different inputs or a different tool — or produce your final answer now.]";

/**
 * Consecutive-error guard. A turn in which EVERY tool call failed makes no progress even when each
 * call differs (so the repetition guard, which keys on the tool-call signature, never fires). We
 * count consecutive all-error turns: at SOFT we nudge once to change approach; at HARD we end the
 * run rather than let it spin on failing calls until the budget. Any successful tool result in a
 * turn resets the count. Complements STALL_* (identical-call loops) — this catches error loops.
 */
const CONSECUTIVE_ERROR_SOFT = 3;
const CONSECUTIVE_ERROR_HARD = 5;
const CONSECUTIVE_ERROR_NUDGE_TEXT =
  "[Your last several tool calls have all failed. Step back and reconsider — try a different tool " +
  "or corrected inputs, re-read the current state to get your bearings, or produce your final " +
  "answer with what you have.]";

/**
 * Calibrates the conversation size estimate against ground truth. `estimateTokens` is a chars-based
 * guardrail with hand-measured densities; the PROVIDER, meanwhile, reports exactly how many input
 * tokens the request it just served actually cost. So after every turn we can compare what we
 * estimated against what it really was, and scale future estimates by the ratio.
 *
 * Why this and not a tokenizer: the engine takes no tokenizer dependency (it would be wrong for some
 * provider anyway), and — decisively — the loop cannot know its model. Resolution lives behind the
 * `streamModel` seam, and on the managed `auto` lane the routed model isn't even chosen until the
 * request lands. A feedback loop from the provider's own numbers needs none of that: it works on
 * every lane, corrects a bad constant, and absorbs the system + tool-schema overhead the message
 * estimate never counted (which is why the ratio typically settles above 1).
 *
 * Conservative by construction: we track a HIGH-water ratio (decaying slowly) rather than an average,
 * because under-estimating context is the dangerous direction — it is what lets a conversation sail
 * past the model's window before compaction ever fires. Over-estimating merely compacts a bit early.
 *
 * CAVEAT — cached tokens. On the managed lane `prompt_tokens` INCLUDES cache reads (they are a subset),
 * so it is the true context size. Anthropic-native `input_tokens` EXCLUDES `cache_read_input_tokens`;
 * that is safe today only because the BYO Anthropic path emits no `cache_control` and therefore
 * caches nothing, so its count is complete. **If `cache_control` is ever added to the Anthropic
 * adapter, this calibration silently under-counts and the adapter must report
 * `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` instead.**
 *
 * Exported for unit testing.
 */
export class ContextCalibrator {
  /** Multiplier applied to the raw estimate. Starts neutral until a real turn is observed. */
  private ratio = 1;

  /** Clamp the learned ratio: a wild provider number must not disable the guardrail or force
   *  constant compaction. 4x covers a badly-wrong density; 1.0 floors it at "trust the estimate". */
  private static readonly MIN_RATIO = 1;
  private static readonly MAX_RATIO = 4;
  /** Decay the high-water mark slightly each turn so one outlier turn doesn't pin it forever. */
  private static readonly DECAY = 0.98;

  /** Fold in one turn's ground truth. `estimated` is what we predicted for the messages we SENT;
   *  `actualInputTokens` is what the provider billed for that same request (undefined ⇒ ignore). */
  observe(estimated: number, actualInputTokens: number | undefined): void {
    if (actualInputTokens === undefined || actualInputTokens <= 0 || estimated <= 0) return;
    const observed = actualInputTokens / estimated;
    // High-water with slow decay: jump up immediately, drift down only as calmer turns accumulate.
    this.ratio = Math.max(observed, this.ratio * ContextCalibrator.DECAY);
    this.ratio = Math.min(
      ContextCalibrator.MAX_RATIO,
      Math.max(ContextCalibrator.MIN_RATIO, this.ratio),
    );
  }

  /** The current multiplier. Exposed so a caller working in RAW estimate terms (planCompaction) can
   *  convert a calibrated budget back down to the scale that function measures in. */
  scale(): number {
    return this.ratio;
  }

  /** The calibrated token estimate for a conversation. */
  estimate(messages: readonly ChatMessage[]): number {
    return estimateConversationTokens(messages) * this.ratio;
  }

  /** The calibrated estimate for a single message (used for the reclaim-worth check). */
  estimateOne(message: ChatMessage): number {
    return estimateTokens(message) * this.ratio;
  }
}

/** A canonical, order-independent signature of a turn's tool calls, for repetition detection. */
function turnSignature(toolCalls: readonly ToolCallRequest[]): string {
  return toolCalls
    .map((call) => `${call.name}:${JSON.stringify(call.input)}`)
    .sort()
    .join("|");
}

/**
 * The optional per-call tool-iteration ceiling. Read DEFENSIVELY (via Reflect, not a typed field):
 * the engine may run a program compiled against a newer SDK that surfaced this knob after the engine
 * pinned its `@boardwalk-labs/workflow`, so we never assume the option is present on the type. A
 * finite integer `>= 1` caps the loop; anything else (absent, non-number, `< 1`, non-finite) means
 * unbounded — matching the SDK contract that only a positive integer sets a cap.
 */
function readMaxIterations(opts: AgentOptions | undefined): number | undefined {
  if (opts === undefined) return undefined;
  const raw: unknown = Reflect.get(opts, "maxIterations");
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : undefined;
}

/**
 * A wrap-up nudge to append after a completed tool-calling turn, or null for no nudge this turn.
 * Capped: a concrete countdown as the ceiling nears (`CAP_WARN_AT` turns out). Unbounded: a periodic
 * reminder every `TURN_HINT_INTERVAL` turns so a long loop is prompted to conclude if it already
 * can. Append-only, so the cache-stable prefix is untouched (like the STALL nudge). It never forces
 * a stop — a capped run's hard backstop is the tools-withheld final turn; an uncapped run's is the
 * budget + repetition guard.
 */
function wrapUpHint(iteration: number, cap: number | undefined): string | null {
  if (cap !== undefined) {
    return cap - iteration === CAP_WARN_AT
      ? `[${String(CAP_WARN_AT)} more tool-calling turns before this agent() call must wrap up. ` +
          `Prioritize finishing now and be ready to give your final answer.]`
      : null;
  }
  return iteration % TURN_HINT_INTERVAL === 0
    ? `[You've now taken ${String(iteration)} tool-calling turns. If you already have what you ` +
        `need, stop calling tools and give your final answer; if you're still making real ` +
        `progress, continue.]`
    : null;
}

/**
 * Error codes that are RUN-FATAL even when they surface through a tool call: a budget breach or a
 * cancellation reported by a `subagent` leaf (via its forked io.reportUsage / aborted stream) must
 * END the run, not be handed back to the model as a recoverable tool result. Every other tool
 * failure stays a result the model can react to.
 */
const FATAL_TOOL_ERROR_CODES: ReadonlySet<EngineErrorCode> = new Set([
  "BUDGET_EXCEEDED",
  "CANCELLED",
]);

/** The built-in tool a leaf gets when `AgentOptions.humanInput` is set — lets the model pause the
 *  run mid-loop to ask a person. Its execution is handled in the loop (it needs the tool-call id +
 *  the answers map), not via a normal `execute`. */
export const HUMAN_INPUT_TOOL_NAME = "human_input";

/** A human-input request the model raised mid-leaf (carried out of the loop by {@link LeafParked}). */
export interface HumanInputRequest {
  /** The tool-call id — the STABLE key across park + resume (it lives in the checkpointed turn). */
  toolCallId: string;
  prompt: string;
  /** The response form the model asked for (`{ kind: "text" | "choice" | "multiselect", ... }`). */
  inputSpec: unknown;
}

/** Everything needed to resume a parked leaf where it left off, without re-running prior turns. */
export interface LeafCheckpoint {
  /** The transcript up to and including the assistant turn that called `human_input`. */
  messages: readonly ChatMessage[];
  /** The loop iteration of the parked turn — resume continues from the next one. */
  iteration: number;
  totals: { inputTokens: number; outputTokens: number };
}

/** Resume input for {@link runAgentLeaf}: the parked checkpoint + answers keyed by tool-call id. */
export interface LeafResume {
  checkpoint: LeafCheckpoint;
  answers: Readonly<Record<string, unknown>>;
}

/**
 * Thrown when the model calls `human_input` and no answer is available yet — it unwinds the leaf so
 * the host can suspend the run. The loop attaches `checkpoint` as it propagates (the seam that
 * threw only knows the request); the host stores both and re-invokes the leaf with a {@link LeafResume}
 * once the person responds.
 */
export class LeafParked extends Error {
  readonly request: HumanInputRequest;
  checkpoint: LeafCheckpoint | undefined;

  constructor(request: HumanInputRequest) {
    super("agent leaf parked for human input");
    this.name = "LeafParked";
    this.request = request;
  }
}

/** The `human_input` tool spec advertised to the model. Execution is intercepted in the loop. */
function humanInputToolSpec(): ExecutableTool {
  return {
    name: HUMAN_INPUT_TOOL_NAME,
    description:
      "Pause the run and ask a person, then continue with their answer. Use when a decision " +
      "genuinely needs a human (an approval, a choice between options, missing information only a " +
      "person has). Give a clear `prompt`; optionally an `input` form.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The question to show the person." },
        input: {
          type: "object",
          description:
            'Optional response form: { kind: "text" } | { kind: "choice", options: string[] } | ' +
            '{ kind: "multiselect", options: string[] }. Omit for free text.',
        },
      },
      required: ["prompt"],
    },
    execute: () => {
      throw new EngineError("INTERNAL", "human_input is handled by the loop, not execute()");
    },
  };
}

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
  | { kind: "tool_output_delta"; toolCallId: string; stream: "stdout" | "stderr"; text: string }
  | { kind: "tool_call_result"; toolCallId: string; result: ToolReturn }
  | { kind: "tool_call_error"; toolCallId: string; error: { code: string; message: string } };

/**
 * One model turn the leaf asks for, in neutral terms — no endpoint, no key. `model`/`provider`
 * are the agent() call's (both opaque, both optional); resolution to a concrete endpoint happens
 * behind the `streamModel` seam, never here.
 */
export interface ModelTurnRequest {
  model: string | undefined;
  provider: string | undefined;
  messages: readonly ChatMessage[];
  tools: readonly ToolSpec[];
  /** Normalized reasoning-effort control for this turn (the SDK `AgentOptions.reasoning`), or
   *  omitted to use the provider default. Resolution to a provider's wire format happens behind the
   *  `streamModel` seam, never here. */
  reasoning?: NormalizedReasoning;
}

/** The result of one model turn: the turn itself, plus the resolved model id usage is keyed by. */
export interface ModelTurnResult {
  turn: ChatTurn;
  /** The concrete model the call resolved to — `reportUsage` is keyed by it. */
  modelRef: string;
  /**
   * The resolved model's context window, when the seam knows it — the leaf never resolves a model,
   * so this is its only way to learn the window. See {@link compactionBudget}.
   *
   * Optional and may arrive LATE: a host with no catalog (`boardwalk dev`, BYO) omits it, and a
   * router lane isn't knowable until the first response. Learn-when-told, not a precondition.
   */
  contextTokens?: number;
}

export interface LeafIo {
  /** This leaf's identity — stamped onto its turn_started (via startTurn) and turn_ended frames. */
  identity: AgentIdentity;
  /** Run one model turn behind a seam: the local engine resolves + calls the provider directly;
   *  the hosted platform routes through a broker so the untrusted worker never holds a key. The
   *  leaf passes the streaming hooks (text deltas) in `providerIo`; resolution stays out of here. */
  streamModel(req: ModelTurnRequest, providerIo: ProviderIo): Promise<ModelTurnResult>;
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
  /** Derive a child leaf io for a `subagent` tool call: a fresh run-unique identity over the SAME
   *  sinks (model stream, usage/budget, event publisher, redactor, capabilities). OPTIONAL — an io
   *  that omits it simply doesn't offer the `subagent` tool (like an absent host backend). `name`
   *  is the child's optional display label. */
  forkLeaf?(opts: { name?: string }): LeafIo;
}

/** Execute one agent() leaf call; resolves to final text, or the parsed object in schema mode. */
export async function runAgentLeaf(
  prompt: string,
  opts: AgentOptions | undefined,
  io: LeafIo,
  resume?: LeafResume,
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
    const resolved = [...base.tools, ...(connected?.tools ?? [])];
    // `subagent` is assembled HERE (not in buildToolSet): it needs io.forkLeaf and the resolved
    // parent tool set as its subset ceiling. Added only when the io can fork a child AND the call's
    // builtins selection includes it (default-on under "all"; never for "none"/"read-only").
    const forkLeaf = io.forkLeaf?.bind(io);
    const withSubagent =
      forkLeaf !== undefined && subagentSelected(opts?.builtins)
        ? [
            ...resolved,
            makeSubagentTool({
              parentTools: resolved,
              parentInlineTools: opts?.tools ?? [],
              parentModel: opts?.model,
              parentProvider: opts?.provider,
              parentReasoning: normalizeReasoning(opts?.reasoning),
              parentCwd: leafCwd(opts),
              forkLeaf,
              run: runAgentLeaf,
            }),
          ]
        : resolved;
    // The human_input tool is opt-in per call. It is NOT forked into subagents (a subagent never
    // parks in v0), so only a top-level leaf with `humanInput: true` can pause for a person.
    const tools =
      opts?.humanInput === true ? [...withSubagent, humanInputToolSpec()] : withSubagent;
    return await runLeafWithTools(prompt, opts, io, tools, base.preamble, resume);
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
  resume: LeafResume | undefined,
): Promise<unknown> {
  // Re-check across the MERGED set: a namespaced MCP tool can collide with a program tool.
  assertUniqueToolNames(tools);

  // A resume runs under a FRESH turn block (its own turnId); the pre-park segment's frames stay in
  // the log under the old turn, sharing this leaf's agentId.
  const turnId = `turn-${randomUUID()}`;
  io.startTurn(turnId);

  const totals: { inputTokens: number; outputTokens: number } = { inputTokens: 0, outputTokens: 0 };
  let messages: ChatMessage[];
  let startIteration: number;

  if (resume !== undefined) {
    // Resume: rebuild the transcript and re-execute the parked turn's tools — `human_input` now
    // returns the person's answer (by tool-call id) instead of parking — then continue the loop.
    messages = [...resume.checkpoint.messages];
    totals.inputTokens = resume.checkpoint.totals.inputTokens;
    totals.outputTokens = resume.checkpoint.totals.outputTokens;
    startIteration = resume.checkpoint.iteration;
    const last = messages[messages.length - 1];
    if (last === undefined || last.role !== "assistant") {
      throw new EngineError("INTERNAL", "resume checkpoint did not end with an assistant turn.");
    }
    const results = await executeTurnTools(
      last.toolCalls,
      tools,
      io,
      turnId,
      resume.answers,
      messages,
      startIteration,
      totals,
    );
    messages.push({ role: "tool_results", results });
  } else {
    const schemaInstruction =
      opts?.schema === undefined
        ? []
        : [
            `Respond with ONLY a JSON value matching this JSON Schema — no prose, no code fences:\n${JSON.stringify(opts.schema)}`,
          ];
    const firstMessage = [...preamble, prompt, ...schemaInstruction].join("\n\n");
    const promptText = io.redactor.redact(firstMessage);
    // Attachments (images/documents from `agent({ attachments })`) ride the first user message as file
    // content parts alongside the prompt text; with none, `content` stays a bare string (the common
    // case, unchanged). Redaction covers the text; file bytes/URLs pass through (redactContent).
    const attachments = opts?.attachments ?? [];
    messages = [
      {
        role: "user",
        content:
          attachments.length === 0
            ? promptText
            : [
                { type: "text", text: promptText },
                ...attachments.map((a) => ({
                  type: "file" as const,
                  file: {
                    mimeType: a.mimeType,
                    ...(a.data !== undefined ? { data: a.data } : {}),
                    ...(a.url !== undefined ? { url: a.url } : {}),
                    ...(a.filename !== undefined ? { filename: a.filename } : {}),
                  },
                })),
              ],
      },
    ];
    startIteration = 0;
  }

  let finalText: string;
  try {
    finalText = await runToolLoop(
      messages,
      tools,
      opts,
      io,
      turnId,
      totals,
      resume?.answers ?? {},
      startIteration,
    );
  } catch (err) {
    // A park unwinds the leaf cleanly — propagate it for the host to suspend, without emitting a
    // turn_ended error (the turn is paused, not failed).
    if (err instanceof LeafParked) throw err;
    // Redact like the tool path does: a misbehaving provider can echo request headers (the
    // API key) into an error body, and this message persists in run_events AND — via the
    // rethrow — in the run's failed row. The secrets invariant covers error paths too.
    const message = io.redactor.redact(err instanceof Error ? err.message : String(err));
    const code = err instanceof EngineError ? err.code : "PROVIDER_ERROR";
    io.emit(turnId, {
      kind: "turn_ended",
      ...io.identity,
      reason: "error",
      error: { code, message },
    });
    throw new EngineError(
      code,
      message,
      err instanceof EngineError && err.hint !== undefined
        ? io.redactor.redact(err.hint)
        : undefined,
    );
  }
  // Schema resolution happens BEFORE turn_ended: a corrective retry is another (visible) model turn
  // whose usage must land in the totals the turn_ended event reports.
  const result =
    opts?.schema === undefined
      ? finalText
      : await resolveSchemaOutput(finalText, opts.schema, messages, opts, io, turnId, totals);

  io.emit(turnId, {
    kind: "turn_ended",
    ...io.identity,
    reason: "complete",
    usage: { inputTokens: totals.inputTokens, outputTokens: totals.outputTokens },
  });

  return result;
}

async function runToolLoop(
  messages: ChatMessage[],
  tools: readonly ExecutableTool[],
  opts: AgentOptions | undefined,
  io: LeafIo,
  turnId: string,
  totals: { inputTokens: number; outputTokens: number },
  answers: Readonly<Record<string, unknown>>,
  startIteration: number,
): Promise<string> {
  // Signatures of each tool-using turn, for the repetition guard (see turnSignature + STALL_*).
  const recentSignatures: string[] = [];
  // Consecutive turns whose every tool call errored (see CONSECUTIVE_ERROR_*). Reset by any success.
  let consecutiveErrorTurns = 0;
  // Learns how our size estimate compares to the provider's real input-token count (see the class).
  const calibrator = new ContextCalibrator();
  // The resolved model's context window, once the seam tells us (see ModelTurnResult.contextTokens).
  // Until then the budget falls back to a conservative absolute; a router lane learns it on turn 1.
  let contextTokens: number | undefined;
  // Optional per-call ceiling on tool-calling turns (undefined ⇒ unbounded; see readMaxIterations).
  const cap = readMaxIterations(opts);
  // Resume continues from the iteration AFTER the parked turn (whose tools the caller re-ran).
  // Unbounded when `cap` is undefined; otherwise one turn PAST the cap runs to force a conclusion.
  for (let iteration = startIteration + 1; cap === undefined || iteration <= cap + 1; iteration++) {
    // The single turn past the ceiling withholds tools so the model MUST give a final answer — a
    // soft landing instead of a hard "exceeded N iterations" failure that discards the work done.
    const forceFinal = cap !== undefined && iteration > cap;
    const turnTools = forceFinal ? [] : tools;

    // Bound the context BEFORE each model call: a long loop (or one fat tool result) grows
    // `messages` until the provider rejects it. Reclaim cheaply first (drop stale duplicate reads,
    // no model call), then — only if still over budget — summarize the oldest middle, reusing the
    // loop's prefix so the summary call reads the prompt cache. Task framing + recent tail stay
    // verbatim. Both passes run ONLY on overflow, so a normal run is untouched and cache-stable.
    await reduceContextIfNeeded(messages, turnTools, opts, io, calibrator, contextTokens);

    // Snapshot what we PREDICTED for exactly the messages this call sends, so the provider's reported
    // input-token count can be compared against it once the turn returns.
    const predicted = estimateConversationTokens(messages);
    const result = await modelTurn(messages, turnTools, opts, io, turnId, String(iteration));
    const { turn, modelRef } = result;
    if (result.contextTokens !== undefined) contextTokens = result.contextTokens;
    calibrator.observe(predicted, turn.usage.inputTokens);

    totals.inputTokens += turn.usage.inputTokens ?? 0;
    totals.outputTokens += turn.usage.outputTokens ?? 0;
    io.reportUsage(modelRef, turn.usage);

    // Tools withheld (forced conclusion) OR the model chose to stop ⇒ this text is the answer.
    if (forceFinal || !turn.wantsTools || turn.toolCalls.length === 0) {
      return turn.text;
    }

    // Repetition guard: count how many of the recent turns issued THIS turn's tool-call signature.
    // A sustained stall ends the run before it burns unbounded tokens; a first crossing only nudges.
    const signature = turnSignature(turn.toolCalls);
    recentSignatures.push(signature);
    const repeats = recentSignatures.slice(-STALL_WINDOW).filter((s) => s === signature).length;
    if (repeats >= STALL_HARD_STOP) {
      throw new EngineError(
        "PROGRAM_ERROR",
        "agent() is stuck repeating the same tool call(s) without making progress.",
        "Tighten the prompt, give the model a way to make progress, or split the work across calls.",
      );
    }

    messages.push({ role: "assistant", text: turn.text, toolCalls: turn.toolCalls });
    const results = await executeTurnTools(
      turn.toolCalls,
      tools,
      io,
      turnId,
      answers,
      messages,
      iteration,
      totals,
    );
    messages.push({ role: "tool_results", results });

    // Consecutive-error guard: a turn where EVERY tool call failed made no progress. Track the run
    // of such turns; end the run at the hard threshold (spinning on failures, distinct or not), nudge
    // once at the soft threshold. Any success resets it. An empty result set counts as no-error.
    const allErrored = results.length > 0 && results.every((r) => r.isError);
    consecutiveErrorTurns = allErrored ? consecutiveErrorTurns + 1 : 0;
    if (consecutiveErrorTurns >= CONSECUTIVE_ERROR_HARD) {
      throw new EngineError(
        "PROGRAM_ERROR",
        "agent() made several consecutive tool calls that all failed without recovering.",
        "Every recent tool call errored — check the tool inputs and permissions, or split the work.",
      );
    }

    // Nudge ONCE, when the stall first crosses the soft threshold (an appended message, so the
    // cache-stable prefix is untouched). If the model keeps repeating, `repeats` climbs to the hard
    // stop above on a later turn.
    if (repeats === STALL_SOFT_NUDGE) {
      messages.push({ role: "user", content: io.redactor.redact(STALL_NUDGE_TEXT) });
    }
    if (consecutiveErrorTurns === CONSECUTIVE_ERROR_SOFT) {
      messages.push({ role: "user", content: io.redactor.redact(CONSECUTIVE_ERROR_NUDGE_TEXT) });
    }

    // Wrap-up hint: as tool-calling turns pile up, remind the model to conclude (append-only, so the
    // cache-stable prefix is untouched). A cap gives a concrete countdown near the ceiling; an
    // unbounded loop gets a periodic reminder. Never forces a stop (see wrapUpHint).
    const hint = wrapUpHint(iteration, cap);
    if (hint !== null) {
      messages.push({ role: "user", content: io.redactor.redact(hint) });
    }
  }
  // Unreachable: an unbounded loop only exits via a return above, and a capped loop returns on its
  // forced-final turn. Kept as a defensive terminal for the type checker.
  throw new EngineError("INTERNAL", "agent() tool loop exited without producing an answer.");
}

/**
 * Keep the conversation within budget, cheaply first. Runs ONLY when over budget (a normal run is
 * untouched and stays append-only, which is what keeps the prompt cache warm). Two passes:
 *
 *  1. dedupeFileReads — a pure, no-model reclaim that drops stale duplicate `read` results. Often
 *     enough on its own to get back under budget, skipping the summary call entirely.
 *  2. summarizeForCompaction — only if still over. It replaces the oldest compressible middle
 *     (planCompaction's pure boundary math) with ONE model-written digest, preserving the task
 *     message + recent tail verbatim. Gated by a minimum-reclaim threshold (don't pay for a model
 *     call to free a little) and a shrink guard (discard a digest that isn't materially smaller).
 *
 * Loop safety: this runs at most once per iteration. If a single giant message still leaves the
 * result over budget, we proceed and let the provider speak (a too-large request surfaces as a
 * normal PROVIDER_ERROR); the next iteration gets a fresh shot once the loop adds new turns.
 */
async function reduceContextIfNeeded(
  messages: ChatMessage[],
  tools: readonly ExecutableTool[],
  opts: AgentOptions | undefined,
  io: LeafIo,
  calibrator: ContextCalibrator,
  contextTokens: number | undefined,
): Promise<void> {
  // Sized from the resolved model's window when the seam has reported one (compactionBudget).
  const budget = compactionBudget(contextTokens);
  if (calibrator.estimate(messages) <= budget) return;

  // Cheap pass: drop stale duplicate file reads (no model call). Re-check before summarizing.
  dedupeFileReads(messages);
  if (calibrator.estimate(messages) <= budget) return;

  // planCompaction re-checks the budget against the RAW estimate, so hand it the budget in raw terms
  // (i.e. undo the calibration) — otherwise a calibrated-up conversation would be judged in-budget by
  // the planner and return null even though we are over.
  const plan = planCompaction(messages, budget / calibrator.scale());
  if (plan === null) return;
  const rangeTokens = messages
    .slice(plan.start, plan.end + 1)
    .reduce((sum, message) => sum + calibrator.estimateOne(message), 0);
  if (rangeTokens < MIN_COMPACTION_RECLAIM_TOKENS) return; // not worth a model call

  const summary = await summarizeForCompaction(messages, tools, opts, io);
  // Shrink guard: a digest no smaller than what it replaces is churn (and covers a model that
  // ignored the instruction and echoed the transcript) — skip the splice. Compared in tokens, on the
  // same footing as the range it would replace (a `user` message, so prose density).
  const summaryTokens = calibrator.estimateOne({ role: "user", content: summary });
  if (summaryTokens >= rangeTokens) return;
  messages.splice(plan.start, plan.end - plan.start + 1, {
    role: "user",
    content: io.redactor.redact(summary),
  });
}

/** The instruction that turns the conversation so far into a forward-useful digest. */
const SUMMARIZATION_PROMPT =
  "Compact the conversation so far into a concise digest the agent can continue from with no loss " +
  "of momentum. The digest REPLACES the earlier turns (the most recent turns stay verbatim), so " +
  "preserve, in terse bullets: the goal/task; the plan or todo list with each item's status; " +
  "decisions made and why; facts, values, and identifiers learned; files touched (with exact " +
  "paths) and what changed in each; commands run and results that still matter; errors hit and " +
  "their fixes; what has been verified vs. still unverified; what you are doing RIGHT NOW; and the " +
  "next steps. Drop only redundancy — never drop a fact you would need to finish the task. Output " +
  "ONLY the digest text — no preamble — and do not call any tools.";

/**
 * Produce a compaction digest via the SAME model seam the loop uses (so it routes + meters like a
 * real turn). Crucially it REUSES the loop's prefix — the same `messages` + `tools` the loop just
 * sent — with the instruction appended as the final user message, so the call READS the prompt
 * cache the loop has been writing rather than reprocessing the transcript at full price. Tools are
 * advertised for cache parity but any tool call the model makes is ignored (we take the text).
 * Reasoning is deliberately omitted: this is overhead, not the author's work.
 */
async function summarizeForCompaction(
  messages: readonly ChatMessage[],
  tools: readonly ExecutableTool[],
  opts: AgentOptions | undefined,
  io: LeafIo,
): Promise<string> {
  const req: ModelTurnRequest = {
    model: opts?.model,
    provider: opts?.provider,
    messages: [...messages, { role: "user", content: io.redactor.redact(SUMMARIZATION_PROMPT) }],
    tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  };
  // No streaming hooks: digest deltas aren't this leaf's user-visible text. providerIo still
  // carries the loop's fetch/sleep impls so the call goes out exactly as a real turn does.
  const { turn, modelRef } = await io.streamModel(req, { ...io.provider });
  io.reportUsage(modelRef, turn.usage);
  return turn.text;
}

/** One model call with streamed text events (block ids are unique per iteration). */
async function modelTurn(
  messages: readonly ChatMessage[],
  tools: readonly ExecutableTool[],
  opts: AgentOptions | undefined,
  io: LeafIo,
  turnId: string,
  blockLabel: string,
): Promise<ModelTurnResult> {
  const blockId = `text-${blockLabel}`;
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
  // The author's reasoning-effort control (string sugar expanded, no-ops dropped) rides every real
  // turn. The internal compaction/summary call (summarizeRange) deliberately omits it — that's
  // overhead, not the author's work, and shouldn't burn extra reasoning tokens.
  const reasoning = normalizeReasoning(opts?.reasoning);
  const result = await io.streamModel(
    {
      model: opts?.model,
      provider: opts?.provider,
      messages,
      tools: tools.map(({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
      })),
      ...(reasoning !== undefined ? { reasoning } : {}),
    },
    providerIo,
  );
  if (blockOpen) io.emit(turnId, { kind: "text_end", blockId });
  return result;
}

/**
 * Run a turn's tool calls concurrently. On a {@link LeafParked} (the model called `human_input`
 * with no answer yet), attach the resume checkpoint as it unwinds — `messages` already includes the
 * assistant turn, and `iteration` is its loop index — so the host can store it and resume here.
 * Other run-fatal tool errors (budget/cancel) propagate as before.
 */
async function executeTurnTools(
  toolCalls: readonly ToolCallRequest[],
  tools: readonly ExecutableTool[],
  io: LeafIo,
  turnId: string,
  answers: Readonly<Record<string, unknown>>,
  messages: readonly ChatMessage[],
  iteration: number,
  totals: { inputTokens: number; outputTokens: number },
): Promise<ToolResultMessage[]> {
  try {
    return await Promise.all(
      toolCalls.map((call) => executeToolCall(call, tools, io, turnId, answers)),
    );
  } catch (err) {
    if (err instanceof LeafParked && err.checkpoint === undefined) {
      err.checkpoint = {
        messages: [...messages],
        iteration,
        totals: { inputTokens: totals.inputTokens, outputTokens: totals.outputTokens },
      };
    }
    throw err;
  }
}

/**
 * The `human_input` tool, intercepted in the loop (it needs the tool-call id + the answers map). On
 * resume the person's answer is keyed by the tool-call id → return it as the result; otherwise PARK
 * (throw {@link LeafParked}) so the run suspends until they respond.
 */
function executeHumanInput(
  call: ToolCallRequest,
  io: LeafIo,
  turnId: string,
  answers: Readonly<Record<string, unknown>>,
): { id: string; content: string; isError: boolean } {
  if (Object.hasOwn(answers, call.id)) {
    const content = io.redactor.redact(JSON.stringify(answers[call.id]));
    io.emit(turnId, {
      kind: "tool_call_result",
      toolCallId: call.id,
      result: { humanSummary: "human responded" },
    });
    return { id: call.id, content, isError: false };
  }
  const prompt = typeof call.input.prompt === "string" ? call.input.prompt : "Input needed";
  throw new LeafParked({ toolCallId: call.id, prompt, inputSpec: call.input.input });
}

/** Run one tool call; failures return to the MODEL as error results, they don't fail the run. */
async function executeToolCall(
  call: ToolCallRequest,
  tools: readonly ExecutableTool[],
  io: LeafIo,
  turnId: string,
  answers: Readonly<Record<string, unknown>>,
): Promise<ToolResultMessage> {
  io.emit(turnId, { kind: "tool_call_start", toolCallId: call.id, toolName: call.name });
  io.emit(turnId, { kind: "tool_call_input_complete", toolCallId: call.id, input: call.input });

  // human_input is intercepted here (it needs the tool-call id + the answers map), not via execute.
  if (call.name === HUMAN_INPUT_TOOL_NAME) {
    io.emit(turnId, { kind: "tool_call_executing", toolCallId: call.id });
    return executeHumanInput(call, io, turnId, answers);
  }

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
    // Stream a tool's live output as redacted tool_output_delta frames (chunk-level redaction; the
    // final result is redacted as a whole, so a secret split across chunks is still scrubbed there).
    const onOutput: ToolOutputSink = (stream, text) =>
      io.emit(turnId, {
        kind: "tool_output_delta",
        toolCallId: call.id,
        stream,
        text: io.redactor.redact(text),
      });
    const raw = await tool.execute(call.input, onOutput);
    // The model sees `llmText` (a plain-string return IS that text); observers get the structured
    // event. BOTH are redacted — model-bound content AND the observer payload (defense-in-depth: a
    // tool result that inadvertently carries a known secret must reach neither).
    const llmText = typeof raw === "string" ? raw : raw.llmText;
    const redactedText = io.redactor.redact(llmText);
    // A tool that returns structured `content` (e.g. `screenshot`) carries text + image parts through
    // to the model: text parts are redacted, image bytes pass through. Otherwise the model-bound text
    // IS the content.
    const content =
      typeof raw === "string" || raw.content === undefined
        ? redactedText
        : io.redactor.redactContent(raw.content);
    const result: ToolReturn =
      typeof raw === "string"
        ? { humanSummary: summarize(redactedText) }
        : redactToolReturn(io.redactor, raw.event);
    io.emit(turnId, { kind: "tool_call_result", toolCallId: call.id, result });
    return { id: call.id, content, isError: false };
  } catch (err) {
    const message = io.redactor.redact(err instanceof Error ? err.message : String(err));
    const code = err instanceof EngineError ? err.code : "PROGRAM_ERROR";
    io.emit(turnId, { kind: "tool_call_error", toolCallId: call.id, error: { code, message } });
    // Run-fatal failures (a subagent leaf tripping the budget cap, or cancellation) must propagate
    // and end the run — not be swallowed into a tool result the model would keep working past.
    if (err instanceof EngineError && FATAL_TOOL_ERROR_CODES.has(err.code)) throw err;
    return { id: call.id, content: `Tool failed: ${message}`, isError: true };
  }
}

function summarize(content: string): string {
  const flat = content.replaceAll("\n", " ");
  return flat.length <= 120 ? flat : `${flat.slice(0, 117)}…`;
}

/** Redact a structured tool result before it reaches observers: scrub the human summary and
 *  deep-scrub the tool-specific `data`. `kind` is a fixed discriminator literal, never user text. */
function redactToolReturn(redactor: Redactor, event: ToolReturn): ToolReturn {
  const out: ToolReturn = {};
  if (event.kind !== undefined) out.kind = event.kind;
  if (event.humanSummary !== undefined) out.humanSummary = redactor.redact(event.humanSummary);
  if (event.data !== undefined) out.data = redactor.redactData(event.data);
  return out;
}

/** Best-effort extract + parse; `{ ok: false }` rather than throwing, so a caller can retry. */
function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  const candidate = extractJsonCandidate(text);
  try {
    return { ok: true, value: JSON.parse(candidate) };
  } catch {
    return { ok: false };
  }
}

/**
 * Resolve an `agent({ schema })` call's output. First try the best-effort extract + parse, which
 * recovers the common "wrapped in prose or code fences" misses with no model round-trip. Only if
 * that fails spend ONE corrective turn — show the model its own answer, demand JSON only, withhold
 * tools — and re-parse before failing the run. This turns a transient formatting slip into a
 * success instead of discarding an entire run's work (the failure mode that motivated this: a leaf
 * answering in prose used to kill a long, expensive run outright).
 *
 * The corrective turn is a real, visible model turn: it streams under its own `text-schema-retry`
 * block and its tokens are metered into `totals`. Structural validation of the parsed value against
 * the schema stays a separate cross-engine decision (it would change the contract every engine
 * enforces); this recovers + parses, matching the prior behavior's guarantee.
 */
async function resolveSchemaOutput(
  finalText: string,
  schema: NonNullable<AgentOptions["schema"]>,
  messages: ChatMessage[],
  opts: AgentOptions,
  io: LeafIo,
  turnId: string,
  totals: { inputTokens: number; outputTokens: number },
): Promise<unknown> {
  const first = tryParseJson(finalText);
  if (first.ok) return first.value;

  // The stopped turn's text was never pushed to `messages` (the loop returns it directly), so add it
  // before the correction, giving the model its own answer to fix.
  messages.push({ role: "assistant", text: finalText, toolCalls: [] });
  messages.push({
    role: "user",
    content: io.redactor.redact(
      "Your previous answer was not valid JSON. Respond with ONLY a JSON value matching this JSON " +
        `Schema — no prose, no code fences, no explanation:\n${JSON.stringify(schema)}`,
    ),
  });

  const { turn, modelRef } = await modelTurn(messages, [], opts, io, turnId, "schema-retry");
  totals.inputTokens += turn.usage.inputTokens ?? 0;
  totals.outputTokens += turn.usage.outputTokens ?? 0;
  io.reportUsage(modelRef, turn.usage);

  const second = tryParseJson(turn.text);
  if (second.ok) return second.value;

  throw new EngineError(
    "VALIDATION",
    "agent() was called with a schema but the model's answer was not valid JSON (after a retry).",
    `Answer started with: ${JSON.stringify(extractJsonCandidate(turn.text).slice(0, 80))}`,
  );
}

/**
 * Best-effort extraction of the JSON payload from a model's final text: strip a surrounding markdown
 * code fence, and if the remainder isn't already a bare JSON value, carve out the first balanced
 * {...} or [...]. The returned candidate may still be invalid JSON — the caller does the parse.
 * Exported for unit testing.
 */
export function extractJsonCandidate(text: string): string {
  let s = text.trim();
  const fence = /^```(?:json|jsonc)?\s*\n?([\s\S]*?)\n?```$/i.exec(s);
  if (fence?.[1] !== undefined) s = fence[1].trim();
  if (s.startsWith("{") || s.startsWith("[")) return s;
  return carveFirstJsonValue(s) ?? s;
}

/** Scan for the first balanced object/array, honoring string literals + escapes; null if none. */
function carveFirstJsonValue(s: string): string | null {
  const startIdx = s.search(/[[{]/);
  if (startIdx === -1) return null;
  const open = s[startIdx];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = startIdx; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close && --depth === 0) return s.slice(startIdx, i + 1);
  }
  return null; // unbalanced — let the caller's parse surface a clear error
}

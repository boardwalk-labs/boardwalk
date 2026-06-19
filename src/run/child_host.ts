// SPDX-License-Identifier: Apache-2.0

// The WorkflowHost installed in the run process.
//
// Split of responsibilities (SPEC §2.3): anything that only needs the local process happens
// here (sleep — hold-and-pay is literally just holding this process; phase markers); anything
// that touches engine state (secrets, durable child runs, artifacts) is brokered to the
// supervisor over IPC. agent() runs its loop in THIS process too — program-defined tools and
// MCP connections must execute where the program lives (the trusted layer).

import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  AgentOptions,
  HumanInputOptions,
  HumanInputResult,
  PhaseOptions,
  SleepArg,
  TokenUsage,
} from "@boardwalk-labs/workflow";
import type { WorkflowHost } from "@boardwalk-labs/workflow/runtime";
import type { ArtifactBody, ArtifactRef, CallOptions } from "@boardwalk-labs/workflow";
import type { ChatMessage } from "../agent/conversation.js";
import {
  runAgentLeaf,
  type AgentIdentity,
  type LeafIo,
  type ModelTurnRequest,
} from "../agent/leaf.js";
import { chatBedrock } from "../agent/bedrock.js";
import { chatAnthropic, chatOpenAi, type ChatArgs, type ProviderIo } from "../agent/providers.js";
import { Redactor } from "../agent/redact.js";
import { BOARDWALK_PROVIDER, type ResolvedModel } from "../agent/resolve.js";
import type {
  ArtifactWriteResult,
  FetchResult,
  ToolHost,
  ToolSetContext,
  WebSearchResult,
} from "../agent/tools.js";
import { EngineError, isEngineErrorCode } from "../errors.js";
import {
  journalEntryResultSchema,
  mcpTokenResultSchema,
  readArtifactResultSchema,
  resolvedModelSchema,
  webSearchResultSchema,
  type IpcErrorShape,
  type HostMethod,
  type RunEventBody,
} from "./ipc.js";

/** Cap on a webfetch response body (the local backend's default); the model can ask for less. */
const DEFAULT_FETCH_MAX_BYTES = 256 * 1024;

/** What the child tells the supervisor when a seam suspends the run (releases the process). */
export interface SuspendSignal {
  reason: "human_input" | "sleep";
  seq: number;
  fingerprint: string;
  humanInput?: {
    key: string;
    prompt: string;
    inputSpec: unknown;
    assignees?: string[];
  };
  /** Relative wait (ms) for reason "sleep"; the supervisor computes the absolute wake time. */
  durationMs?: number;
}

export interface ChildHostIo {
  /** Broker a host call to the supervisor; resolves with its result. */
  request(method: HostMethod, args: Record<string, unknown>): Promise<unknown>;
  /** Signal a durable suspension; the supervisor records it and kills this process. */
  suspend(signal: SuspendSignal): void;
  /** Emit a run-event body (the supervisor stamps the envelope). turnId scopes leaf frames. */
  emit(body: RunEventBody, turnId?: string): void;
  /** Tell the supervisor to open a new turn block (it emits turn_started naming the leaf). */
  startTurn(turnId: string, identity: AgentIdentity): void;
  /** Report leaf usage to the supervisor — the budget authority. */
  reportUsage(modelRef: string, usage: TokenUsage): void;
  /** Tell the supervisor a memory dir is in use (auto-persisted at successful run end). */
  memoryUsed(dir: string): void;
}

/** Rebuild a typed EngineError from its IPC shape so program-visible errors keep code + hint. */
export function errorFromIpc(shape: IpcErrorShape): Error {
  const code = isEngineErrorCode(shape.code) ? shape.code : "INTERNAL";
  return new EngineError(code, shape.message, shape.hint);
}

export interface ChildHost {
  host: WorkflowHost;
  /** The run process's one redactor — the child entry scrubs failure reports with it too. */
  redactor: Redactor;
  /**
   * True while the program is REPLAYING journaled seams on a resume/restart (before the frontier).
   * The child entry uses it to drop console output that was already emitted last segment — so a
   * resumed run's stream isn't littered with duplicate pre-suspend logs.
   */
  isReplaying(): boolean;
}

/**
 * @param replayFrontier the highest journaled seq; 0 on a fresh run. While re-running seams up to
 * the frontier, the host is "replaying" and observability (console output, phase markers) is
 * suppressed — those lines were emitted in the prior segment.
 */
export function createChildHost(
  io: ChildHostIo,
  capabilities: ToolSetContext,
  replayFrontier = 0,
): ChildHost {
  let phaseCount = 0;
  // Replaying until a seam at/after the frontier is reached. A fresh run (frontier 0) is live
  // immediately; a resume starts suppressed and goes live as it crosses the suspending seam.
  let live = replayFrontier === 0;
  // One counter per run → a stable, run-unique id for each agent() call. The author's optional
  // name rides alongside as the display label; concurrent agents stay distinguishable either way.
  let agentCount = 0;
  // One redactor for the whole run process: every secret value revealed to the program (and
  // every provider key) is scrubbed from everything model-bound, across all agent() calls.
  const redactor = new Redactor();

  // Durable-seam sequence: a synchronous monotonic counter assigned at each journaled seam's
  // entry (agent / step). Because a program's synchronous call order is deterministic, the same
  // logical call gets the same seq on every execution — the journal key that lets a resumed run
  // return a memoized result instead of recomputing. A miss runs the seam and records it; a hit
  // returns the stored result (a fingerprint mismatch is a determinism error). The counter
  // resets per child process, so a re-executed run re-derives the identical keys from the top.
  let seamCount = 0;
  /** Advance the seam counter and, on a resume, go live once we reach the suspending seam (the
   *  frontier) — output after it is new; output before it was already emitted. */
  function nextSeam(): number {
    const seq = ++seamCount;
    if (seq >= replayFrontier) live = true;
    return seq;
  }
  async function journalGet(seq: number): Promise<JournalLookup> {
    return journalEntryResultSchema.parse(await io.request("journal_get", { seq }));
  }
  async function journalPut(entry: {
    seq: number;
    kind: "agent" | "step";
    fingerprint: string;
    label: string;
    result: unknown;
  }): Promise<void> {
    await io.request("journal_put", { ...entry, state: "resolved" });
  }

  // Resolution is supervisor-side (keys never live in config here); the result is cached per
  // (model, provider) so a tool loop's many turns resolve — and register their key/headers with
  // the redactor — exactly once. The cache key is the agent() call's opaque pair, before defaults.
  const resolvedCache = new Map<string, Promise<ResolvedModel>>();
  async function resolveAndRegister(
    model: string | undefined,
    provider: string | undefined,
  ): Promise<ResolvedModel> {
    const cacheKey = `${provider ?? ""}\0${model ?? ""}`;
    let pending = resolvedCache.get(cacheKey);
    if (pending === undefined) {
      pending = (async () => {
        const resolved = resolvedModelSchema.parse(
          await io.request("resolve_model", {
            ...(model !== undefined ? { model } : {}),
            ...(provider !== undefined ? { provider } : {}),
          }),
        );
        // The provider key (and any env-sourced custom headers) become known to this process the
        // instant they're resolved — register them with the redactor so they can never reach the
        // model. This is the secrets invariant for the local seam: keys stay here, redacted before
        // anything model-bound goes out.
        if (resolved.apiKey !== null) {
          redactor.add(`api-key:${resolved.provider}`, resolved.apiKey);
        }
        for (const name of resolved.secretHeaderNames) {
          const value = resolved.headers[name];
          if (value !== undefined) redactor.add(`header:${name}`, value);
        }
        // Bedrock's SigV4 credentials are secret values like any provider key — the secret access
        // key and session token must never reach the model. (The access key id and region are not
        // secret.) Register them so the seam's final scrub covers them too.
        if (resolved.aws !== undefined) {
          redactor.add(`aws-secret-key:${resolved.provider}`, resolved.aws.secretAccessKey);
          if (resolved.aws.sessionToken !== undefined) {
            redactor.add(`aws-session-token:${resolved.provider}`, resolved.aws.sessionToken);
          }
        }
        return resolved;
      })();
      resolvedCache.set(cacheKey, pending);
    }
    return pending;
  }

  // The LOCAL streamModel seam: resolve supervisor-side, then call the provider HTTP directly
  // (in-process). The hosted platform swaps this for a broker-routed call so its untrusted worker
  // never holds the key — the leaf loop above is identical either way.
  async function streamModel(req: ModelTurnRequest, providerIo: ProviderIo) {
    const resolved = await resolveAndRegister(req.model, req.provider);
    const args: ChatArgs = {
      baseUrl: resolved.baseUrl,
      apiKey: resolved.apiKey,
      headers: resolved.headers,
      model: resolved.model,
      // The key/headers are known only NOW (resolution is lazy behind the seam), so the final
      // scrub of model-bound text happens here, after registration — the first prompt could
      // otherwise carry a key the resolver just learned. Idempotent: already-redacted text is
      // untouched. Whoever holds the key (this seam locally; the broker on the platform) redacts.
      messages: redactMessages(req.messages, redactor),
      tools: req.tools,
      // Reasoning-effort control: pass the normalized request through, and tell the OpenAI adapter
      // which dialect to speak — the managed lane uses the unified `reasoning` object, every other
      // provider gets `reasoning_effort` / a `thinking` budget per its protocol.
      ...(req.reasoning !== undefined ? { reasoning: req.reasoning } : {}),
      reasoningStyle: resolved.provider === BOARDWALK_PROVIDER ? "unified" : "openai_effort",
      // Bedrock SigV4 credentials (present only for protocol "bedrock"); the adapter signs with them.
      ...(resolved.aws !== undefined ? { aws: resolved.aws } : {}),
    };
    const turn =
      resolved.protocol === "anthropic"
        ? await chatAnthropic(args, providerIo)
        : resolved.protocol === "bedrock"
          ? await chatBedrock(args, providerIo)
          : await chatOpenAi(args, providerIo);
    return { turn, modelRef: resolved.model };
  }

  // The DEFAULT local backend for the host-backed built-ins (webfetch/web_search/artifacts).
  // webfetch uses this process's fetch (honoring NODE_USE_ENV_PROXY when set); artifacts + search
  // broker to the supervisor (artifacts integrate with the store; search uses the engine's
  // configured provider, fail-closed if none). The `diagnostics` built-in is NOT here: LSP is
  // engine-native (the per-run LspService spawns a language server in the workspace), carried on
  // `capabilities.lspService`, not this host seam.
  const toolHost: ToolHost = {
    fetchUrl: (url, fetchOpts): Promise<FetchResult> => localFetch(url, fetchOpts?.maxBytes),
    webSearch: async (query, searchOpts): Promise<WebSearchResult[]> => {
      const result = webSearchResultSchema.parse(
        await io.request("web_search", {
          query,
          ...(searchOpts?.limit !== undefined ? { limit: searchOpts.limit } : {}),
        }),
      );
      return result.results.map((r) => ({
        title: r.title,
        url: r.url,
        ...(r.snippet !== undefined ? { snippet: r.snippet } : {}),
      }));
    },
    writeArtifact: async (name, contentType, body, metadata): Promise<ArtifactWriteResult> => {
      const value = await io.request("write_artifact", {
        name,
        contentType,
        bodyBase64: Buffer.from(body, "utf8").toString("base64"),
        ...(metadata !== undefined ? { metadata } : {}),
      });
      return artifactRefSchema.parse(value);
    },
    readArtifact: async (name): Promise<string> => {
      return readArtifactResultSchema.parse(await io.request("read_artifact", { name })).content;
    },
  };
  const capabilitiesWithHost: ToolSetContext = { ...capabilities, host: toolHost };

  // One LeafIo per agent() leaf, reusable for sub-agents: forkLeaf mints a fresh run-unique
  // identity over the SAME sinks (this process's one redactor + the supervisor's cursor authority),
  // so a `subagent` tool call runs another leaf that interleaves on the run's event stream under
  // its own agentId. Self-referential by design — forkLeaf runs after assignment, so the name is
  // in scope.
  const makeLeafIo = (identity: AgentIdentity): LeafIo => ({
    identity,
    streamModel,
    startTurn: (turnId) => io.startTurn(turnId, identity),
    emit: (turnId, body) => io.emit(body, turnId),
    reportUsage: (modelRef, usage) => io.reportUsage(modelRef, usage),
    memoryUsed: (dir) => io.memoryUsed(dir),
    // MCP OAuth tokens are engine state: brokered per use, validated like any other supervisor
    // response; refresh tokens and the store never enter this process.
    mcpToken: async (serverUrl, invalidateToken) =>
      mcpTokenResultSchema.parse(
        await io.request("mcp_token", {
          serverUrl,
          ...(invalidateToken !== undefined ? { invalidateToken } : {}),
        }),
      ),
    redactor,
    capabilities: capabilitiesWithHost,
    forkLeaf: ({ name }) => {
      agentCount += 1;
      const childIdentity: AgentIdentity = {
        agentId: `agent-${String(agentCount)}`,
        ...(name !== undefined ? { agentName: name } : {}),
      };
      return makeLeafIo(childIdentity);
    },
  });

  const host: WorkflowHost = {
    setPhase(name: string, opts: PhaseOptions | undefined): void {
      phaseCount += 1;
      // Suppressed during replay: the marker was already emitted in the prior segment.
      if (!live) return;
      io.emit({ kind: "phase", name, id: opts?.id ?? `phase-${String(phaseCount)}` });
    },

    async agent(prompt: string, opts: AgentOptions | undefined): Promise<unknown> {
      const seq = nextSeam();
      const fingerprint = seamFingerprint([
        "agent",
        opts?.provider ?? null,
        opts?.model ?? null,
        prompt,
        opts?.schema ?? null,
      ]);
      const existing = await journalGet(seq);
      if (existing !== null) {
        if (existing.fingerprint !== fingerprint)
          throw determinismError(seq, "agent", existing.kind);
        if (existing.state === "resolved") return existing.result;
        // A `pending` entry is a leaf parked on tool-level human_input; resuming it is handled by
        // the leaf-checkpoint path, not here. With no checkpoint yet, fall through to re-run.
      }
      agentCount += 1;
      const identity: AgentIdentity = {
        agentId: `agent-${String(agentCount)}`,
        ...(opts?.name !== undefined ? { agentName: opts.name } : {}),
      };
      const result = await runAgentLeaf(prompt, opts, makeLeafIo(identity));
      await journalPut({ seq, kind: "agent", fingerprint, label: prompt.slice(0, 120), result });
      return result;
    },

    async step(name: string, fn: () => unknown): Promise<unknown> {
      const seq = nextSeam();
      const fingerprint = seamFingerprint(["step", name]);
      const existing = await journalGet(seq);
      if (existing !== null) {
        if (existing.fingerprint !== fingerprint)
          throw determinismError(seq, "step", existing.kind);
        if (existing.state === "resolved") return existing.result;
      }
      const result = await fn();
      await journalPut({ seq, kind: "step", fingerprint, label: name, result });
      return result;
    },

    async humanInput(opts: HumanInputOptions): Promise<HumanInputResult> {
      const seq = nextSeam();
      const key = opts.key ?? `seam-${String(seq)}`;
      const fingerprint = seamFingerprint(["human_input", key, opts.prompt, opts.input]);
      const existing = await journalGet(seq);
      if (existing !== null) {
        if (existing.fingerprint !== fingerprint) {
          throw determinismError(seq, "human_input", existing.kind);
        }
        // The resolved result is the human's validated response; a still-`pending` entry means a
        // spurious wake without an answer, so fall through to re-suspend.
        if (existing.state === "resolved") return existing.result as HumanInputResult;
      }
      io.suspend({
        reason: "human_input",
        seq,
        fingerprint,
        humanInput: {
          key,
          prompt: opts.prompt,
          inputSpec: opts.input,
          ...(opts.assignees !== undefined ? { assignees: [...opts.assignees] } : {}),
        },
      });
      // Park: the run is now suspended and the supervisor will kill this process. Never resolves;
      // a fresh process resumes the run and this seam returns the journaled answer above.
      return new Promise<never>(() => {});
    },

    async callWorkflow(slug: string, input: unknown, opts: CallOptions | undefined) {
      return await io.request("call_workflow", {
        slug,
        input,
        ...(opts?.idempotencyKey !== undefined ? { idempotencyKey: opts.idempotencyKey } : {}),
      });
    },

    async runWorkflow(slug: string, input: unknown, opts: CallOptions | undefined) {
      const value = await io.request("run_workflow", {
        slug,
        input,
        ...(opts?.idempotencyKey !== undefined ? { idempotencyKey: opts.idempotencyKey } : {}),
      });
      return runIdSchema.parse(value);
    },

    async sleep(arg: SleepArg): Promise<void> {
      const seq = nextSeam();
      const fingerprint = seamFingerprint(["sleep"]);
      const existing = await journalGet(seq);
      if (existing !== null) {
        if (existing.fingerprint !== fingerprint)
          throw determinismError(seq, "sleep", existing.kind);
        // A journaled sleep already elapsed in a prior segment — the run only progresses past a
        // sleep once it is due, so on replay this returns immediately.
        return;
      }
      const durationMs = sleepMs(arg);
      if (durationMs <= 0) return;
      if (durationMs < SUSPEND_THRESHOLD_MS) {
        // Short wait: hold the process (cheaper than a release + replay round-trip). Chunked so a
        // multi-week sleep({ until }) doesn't overflow setTimeout's ~24.8-day cap.
        let remaining = durationMs;
        while (remaining > 0) {
          const slice = Math.min(remaining, MAX_TIMEOUT_MS);
          await new Promise<void>((resolve) => {
            setTimeout(resolve, slice);
          });
          remaining -= slice;
        }
        return;
      }
      // Long wait: suspend — release the process; a timer resumes the run when it is due.
      io.suspend({ reason: "sleep", seq, fingerprint, durationMs });
      return new Promise<never>(() => {});
    },

    async getSecret(name: string): Promise<string> {
      const value = secretValueSchema.parse(await io.request("get_secret", { name }));
      redactor.add(name, value);
      return value;
    },

    async writeArtifact(
      name: string,
      contentType: string,
      body: ArtifactBody,
      metadata: Record<string, unknown> | undefined,
    ): Promise<ArtifactRef> {
      const bytes = typeof body === "string" ? Buffer.from(body, "utf8") : Buffer.from(body);
      const value = await io.request("write_artifact", {
        name,
        contentType,
        bodyBase64: bytes.toString("base64"),
        ...(metadata !== undefined ? { metadata } : {}),
      });
      return artifactRefSchema.parse(value);
    },
  };
  return { host, redactor, isReplaying: () => !live };
}

/** setTimeout's max delay (2^31-1 ms ≈ 24.8 days); longer sleeps are chunked. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/** Sleeps at or above this hold-vs-release boundary SUSPEND (release the process + resume on a
 *  timer); shorter ones hold in-process, where a release + replay would cost more than it saves. */
const SUSPEND_THRESHOLD_MS = 30_000;

// Supervisor responses are validated like any other boundary input — the channel being ours
// doesn't exempt it.
const secretValueSchema = z.string();
const runIdSchema = z.string().min(1);
const artifactRefSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  url: z.string().min(1),
});

/** The supervisor's journal_get response: a memoized seam entry, or null on a miss. */
type JournalLookup = z.infer<typeof journalEntryResultSchema>;

/** A stable content hash of a seam's salient args — the determinism check on replay. */
function seamFingerprint(parts: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/** A seam reached on replay didn't match what the journal recorded at that seq. */
function determinismError(seq: number, got: string, recorded: string): EngineError {
  const detail =
    got === recorded
      ? `the same "${got}" seam but with different arguments (a changed prompt, model, or step name)`
      : `a "${recorded}" call, but this execution reached a "${got}" call`;
  return new EngineError(
    "PROGRAM_ERROR",
    `Nondeterministic replay at seam ${String(seq)}: the journal recorded ${detail}. A workflow's ` +
      `code on the path to a suspend/resume must be deterministic — route nondeterministic I/O ` +
      `through agent(), step.run(), or workflows.call so it is journaled.`,
  );
}

/** Scrub every known secret value out of model-bound message text — the seam's last word before
 *  anything reaches the provider. Pure + idempotent: returns redacted copies, mutates nothing. */
function redactMessages(
  messages: readonly ChatMessage[],
  redactor: Redactor,
): readonly ChatMessage[] {
  return messages.map((message) => {
    switch (message.role) {
      case "user":
        return { role: "user", text: redactor.redact(message.text) };
      case "assistant":
        return {
          role: "assistant",
          text: redactor.redact(message.text),
          toolCalls: message.toolCalls,
        };
      case "tool_results":
        return {
          role: "tool_results",
          results: message.results.map((result) => ({
            ...result,
            content: redactor.redact(result.content),
          })),
        };
    }
  });
}

/**
 * The local webfetch backend: a plain `fetch` of an http(s) URL, body capped. Runs in the run
 * process — Node honors NODE_USE_ENV_PROXY for fetch, so a configured egress proxy is respected
 * without any code here. A non-http(s) URL is refused (no file:// or data:); the model's URL is
 * untrusted input.
 */
async function localFetch(url: string, maxBytes: number | undefined): Promise<FetchResult> {
  if (!/^https?:\/\//i.test(url)) {
    throw new EngineError("VALIDATION", `webfetch only supports http(s) URLs (got "${url}").`);
  }
  const cap = maxBytes ?? DEFAULT_FETCH_MAX_BYTES;
  const response = await fetch(url, { redirect: "follow" });
  const full = Buffer.from(await response.arrayBuffer());
  const truncated = full.length > cap;
  const body = (truncated ? full.subarray(0, cap) : full).toString("utf8");
  return {
    status: response.status,
    contentType: response.headers.get("content-type") ?? undefined,
    body,
    truncated,
  };
}

function sleepMs(arg: SleepArg): number {
  if (typeof arg === "number") return arg;
  if ("durationMs" in arg) return arg.durationMs;
  const until = arg.until instanceof Date ? arg.until.getTime() : Date.parse(arg.until);
  if (Number.isNaN(until)) {
    throw new EngineError("VALIDATION", `sleep({ until }) got an unparseable date.`);
  }
  return until - Date.now();
}

// The WorkflowHost installed in the run process.
//
// Split of responsibilities (SPEC §2.3): anything that only needs the local process happens
// here (sleep — hold-and-pay is literally just holding this process; phase markers); anything
// that touches engine state (secrets, durable child runs, artifacts) is brokered to the
// supervisor over IPC. agent() runs its loop in THIS process too — program-defined tools and
// MCP connections must execute where the program lives (the trusted layer).

import { z } from "zod";
import type { AgentOptions, PhaseOptions, SleepArg, TokenUsage } from "@boardwalk-labs/workflow";
import type { WorkflowHost } from "@boardwalk-labs/workflow/runtime";
import type { ArtifactBody, ArtifactRef, CallOptions } from "@boardwalk-labs/workflow";
import { runAgentLeaf, type AgentIdentity } from "../agent/leaf.js";
import { Redactor } from "../agent/redact.js";
import type { ToolSetContext } from "../agent/tools.js";
import { EngineError, isEngineErrorCode } from "../errors.js";
import {
  mcpTokenResultSchema,
  resolvedModelSchema,
  type IpcErrorShape,
  type HostMethod,
  type RunEventBody,
} from "./ipc.js";

export interface ChildHostIo {
  /** Broker a host call to the supervisor; resolves with its result. */
  request(method: HostMethod, args: Record<string, unknown>): Promise<unknown>;
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
}

export function createChildHost(io: ChildHostIo, capabilities: ToolSetContext): ChildHost {
  let phaseCount = 0;
  // One counter per run → a stable, run-unique id for each agent() call. The author's optional
  // name rides alongside as the display label; concurrent agents stay distinguishable either way.
  let agentCount = 0;
  // One redactor for the whole run process: every secret value revealed to the program (and
  // every provider key) is scrubbed from everything model-bound, across all agent() calls.
  const redactor = new Redactor();

  const host: WorkflowHost = {
    setPhase(name: string, opts: PhaseOptions | undefined): void {
      phaseCount += 1;
      io.emit({ kind: "phase", name, id: opts?.id ?? `phase-${String(phaseCount)}` });
    },

    async agent(prompt: string, opts: AgentOptions | undefined): Promise<unknown> {
      agentCount += 1;
      const identity: AgentIdentity = {
        agentId: `agent-${String(agentCount)}`,
        ...(opts?.name !== undefined ? { agentName: opts.name } : {}),
      };
      return await runAgentLeaf(prompt, opts, {
        identity,
        resolve: async (model, provider) =>
          resolvedModelSchema.parse(
            await io.request("resolve_model", {
              ...(model !== undefined ? { model } : {}),
              ...(provider !== undefined ? { provider } : {}),
            }),
          ),
        startTurn: (turnId) => io.startTurn(turnId, identity),
        emit: (turnId, body) => io.emit(body, turnId),
        reportUsage: (modelRef, usage) => io.reportUsage(modelRef, usage),
        memoryUsed: (dir) => io.memoryUsed(dir),
        // MCP OAuth tokens are engine state: brokered per use, validated like any other
        // supervisor response; refresh tokens and the store never enter this process.
        mcpToken: async (serverUrl, invalidateToken) =>
          mcpTokenResultSchema.parse(
            await io.request("mcp_token", {
              serverUrl,
              ...(invalidateToken !== undefined ? { invalidateToken } : {}),
            }),
          ),
        redactor,
        capabilities,
      });
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
      // Hold-and-pay: the process just waits. Locals stay in memory; nothing is checkpointed.
      // Chunked so a multi-week sleep({ until }) doesn't overflow setTimeout's 2^31-1 ms cap
      // (~24.8 days), which would otherwise fire ~immediately — there is no hard duration cap.
      let remaining = sleepMs(arg);
      while (remaining > 0) {
        const slice = Math.min(remaining, MAX_TIMEOUT_MS);
        await new Promise<void>((resolve) => {
          setTimeout(resolve, slice);
        });
        remaining -= slice;
      }
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
  return { host, redactor };
}

/** setTimeout's max delay (2^31-1 ms ≈ 24.8 days); longer sleeps are chunked. */
const MAX_TIMEOUT_MS = 2_147_483_647;

// Supervisor responses are validated like any other boundary input — the channel being ours
// doesn't exempt it (CODE_QUALITY §2.1).
const secretValueSchema = z.string();
const runIdSchema = z.string().min(1);
const artifactRefSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  url: z.string().min(1),
});

function sleepMs(arg: SleepArg): number {
  if (typeof arg === "number") return arg;
  if ("durationMs" in arg) return arg.durationMs;
  const until = arg.until instanceof Date ? arg.until.getTime() : Date.parse(arg.until);
  if (Number.isNaN(until)) {
    throw new EngineError("VALIDATION", `sleep({ until }) got an unparseable date.`);
  }
  return until - Date.now();
}

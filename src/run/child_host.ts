// The WorkflowHost installed in the run process.
//
// Split of responsibilities (SPEC §2.3): anything that only needs the local process happens
// here (sleep — hold-and-pay is literally just holding this process; phase markers); anything
// that touches engine state (secrets, durable child runs, artifacts) is brokered to the
// supervisor over IPC. agent() will run its loop in THIS process too (program-defined tools
// must execute in the program process) — it lands with the inference milestone and fails
// clearly until then.

import { z } from "zod";
import type { AgentOptions, PhaseOptions, SleepArg, TokenUsage } from "@boardwalk/workflow";
import type { WorkflowHost } from "@boardwalk/workflow/runtime";
import type { ArtifactBody, ArtifactRef, CallOptions } from "@boardwalk/workflow";
import { runAgentLeaf } from "../agent/leaf.js";
import { Redactor } from "../agent/redact.js";
import type { ToolSetContext } from "../agent/tools.js";
import { EngineError, isEngineErrorCode } from "../errors.js";
import {
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
  /** Tell the supervisor to open a new turn block (it emits turn_started). */
  startTurn(turnId: string): void;
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

export function createChildHost(io: ChildHostIo, capabilities: ToolSetContext): WorkflowHost {
  let phaseCount = 0;
  // One redactor for the whole run process: every secret value revealed to the program (and
  // every provider key) is scrubbed from everything model-bound, across all agent() calls.
  const redactor = new Redactor();

  return {
    setPhase(name: string, opts: PhaseOptions | undefined): void {
      phaseCount += 1;
      io.emit({ kind: "phase", name, id: opts?.id ?? `phase-${String(phaseCount)}` });
    },

    async agent(prompt: string, opts: AgentOptions | undefined): Promise<unknown> {
      return await runAgentLeaf(prompt, opts, {
        resolve: async (model, provider) =>
          resolvedModelSchema.parse(
            await io.request("resolve_model", {
              ...(model !== undefined ? { model } : {}),
              ...(provider !== undefined ? { provider } : {}),
            }),
          ),
        startTurn: (turnId) => io.startTurn(turnId),
        emit: (turnId, body) => io.emit(body, turnId),
        reportUsage: (modelRef, usage) => io.reportUsage(modelRef, usage),
        memoryUsed: (dir) => io.memoryUsed(dir),
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
      const ms = sleepMs(arg);
      if (ms <= 0) return;
      // Hold-and-pay: the process just waits. Locals stay in memory; nothing is checkpointed.
      await new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      });
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
}

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

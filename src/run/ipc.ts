// SPDX-License-Identifier: Apache-2.0

// The supervisor ⇄ run-process IPC protocol.
//
// One run = one spawned Node process (SPEC §2.2). The child executes the user's program and
// brokers its SDK hook calls back to the supervisor over Node's built-in IPC channel. Every
// message is Zod-validated on receipt — the child runs user code, so everything it sends is a
// trust boundary.
//
// Envelope authority: the child sends event BODIES (no runId/turnId/seq/t); the supervisor is
// the single place envelopes are stamped and cursors allocated, so cursor monotonicity holds
// across crash-restarts without the child knowing about them.

import { z } from "zod";
import type { RunEvent, WorkflowManifest, JsonValue } from "@boardwalk-labs/workflow";

/** A run event minus its envelope — what the child emits, before the supervisor stamps it. */
export type RunEventBody = RunEvent extends infer E
  ? E extends RunEvent
    ? Omit<E, "runId" | "turnId" | "seq" | "t">
    : never
  : never;

const errorShapeSchema = z.strictObject({
  code: z.string(),
  message: z.string(),
  hint: z.string().optional(),
});
export type IpcErrorShape = z.infer<typeof errorShapeSchema>;

// ----------------------------------------------------------------------------
// parent → child
// ----------------------------------------------------------------------------

export interface InitMessage {
  type: "init";
  runId: string;
  /** Absolute path to the bundled program (ESM, `@boardwalk-labs/workflow` external). */
  programPath: string;
  /** The run's isolated working directory (the child chdirs here before importing the program). */
  workspaceDir: string;
  /** The deployed workflow PACKAGE root (program + skills/ + a bundled AGENTS.md), or null when this
   *  workflow has no package. AGENTS.md discovery reads its bundled tier before the workspace tier. */
  programDir: string | null;
  /** Where this workflow's deployed skills live, or null when none were deployed. */
  skillsDir: string | null;
  input: unknown;
  config: Record<string, JsonValue>;
  manifest: WorkflowManifest;
}

export interface HostResultMessage {
  type: "host_result";
  callId: number;
  result: { ok: true; value: unknown } | { ok: false; error: IpcErrorShape };
}

// The child validates only the discriminator + the fields it dereferences; the manifest was
// already validated by the store and `unknown` payloads are narrowed at their use sites.
export const parentToChildSchema = z.union([
  z.object({
    type: z.literal("init"),
    runId: z.string().min(1),
    programPath: z.string().min(1),
    workspaceDir: z.string().min(1),
    programDir: z.string().min(1).nullable(),
    skillsDir: z.string().min(1).nullable(),
    input: z.unknown(),
    config: z.record(z.string(), z.unknown()),
    manifest: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal("host_result"),
    callId: z.number().int().nonnegative(),
    result: z.union([
      z.object({ ok: z.literal(true), value: z.unknown() }),
      z.object({ ok: z.literal(false), error: errorShapeSchema }),
    ]),
  }),
]);

// ----------------------------------------------------------------------------
// child → parent
// ----------------------------------------------------------------------------

/** Host methods the child brokers to the supervisor (everything that touches engine state). */
export const HOST_METHODS = [
  "get_secret",
  "call_workflow",
  "run_workflow",
  "write_artifact",
  "read_artifact",
  "web_search",
  "resolve_model",
  "mcp_token",
  // Human-in-the-loop gate: the call HOLDS (the promise stays pending, the process stays alive)
  // until a person answers via the control surface; the supervisor resolves it with the
  // validated response. The run's crash model is restart-from-top, so nothing is memoized —
  // an answered gate survives a restart via its human_input_requests row, looked up by key.
  "human_input",
] as const;
export type HostMethod = (typeof HOST_METHODS)[number];

const tokenUsageShape = z.strictObject({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional(),
});

export const childToParentSchema = z.union([
  z.object({
    type: z.literal("host_call"),
    callId: z.number().int().nonnegative(),
    method: z.enum(HOST_METHODS),
    args: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal("emit"),
    // Stamped + fully validated against runEventSchema by the supervisor; here we only
    // require an event-body shape with a kind. `turnId` scopes agent-leaf frames to their
    // turn; absent means a run-level frame (turnId = runId).
    body: z.looseObject({ kind: z.string().min(1) }),
    turnId: z.string().min(1).optional(),
  }),
  z.object({
    // Opens a new turn block: the supervisor bumps its cursor stride and emits turn_started.
    // Carries the leaf's identity so the stamped turn_started names which agent is starting.
    type: z.literal("turn_started"),
    turnId: z.string().min(1),
    agentId: z.string().min(1),
    agentName: z.string().min(1).optional(),
  }),
  z.object({
    // Leaf usage report — the supervisor's budget authority consumes this (tokens + max_usd).
    type: z.literal("report_usage"),
    modelRef: z.string().min(1),
    usage: tokenUsageShape,
  }),
  z.object({
    // An agent() call is using a memory dir — the supervisor auto-persists it at success.
    type: z.literal("memory_used"),
    dir: z.string().min(1),
  }),
  z.object({
    type: z.literal("done"),
    output: z.unknown(),
    outputDeclared: z.boolean(),
  }),
  z.object({
    type: z.literal("failed"),
    error: errorShapeSchema,
    // Output declared (output()) BEFORE the program threw still counts — a watch/check often
    // output()s its verdict and then throws to mark the run failed. Mirrors `done`.
    output: z.unknown(),
    outputDeclared: z.boolean(),
  }),
]);
export type ChildToParent = z.infer<typeof childToParentSchema>;

// Host-call argument schemas, validated supervisor-side before acting.
export const getSecretArgsSchema = z.strictObject({ name: z.string().min(1) });
/** call_workflow / run_workflow args. call_workflow HOLDS until the child run is terminal (the
 *  child's run row is the durable memo — a restarted parent re-attaches via the idempotency key
 *  instead of spawning a second child); run_workflow is the fire-and-forget sibling. */
export const callWorkflowArgsSchema = z.strictObject({
  slug: z.string().min(1),
  input: z.unknown(),
  idempotencyKey: z.string().min(1).optional(),
});
/** The supervisor's call_workflow reply: the completed child's output. A failed/cancelled child
 *  surfaces as an IPC error, not a reply. Re-validated child-side. */
export const callWorkflowReplySchema = z.strictObject({ output: z.unknown() });
/** human_input: open (or re-attach to) a gate and HOLD until a person answers. */
export const humanInputArgsSchema = z.strictObject({
  key: z.string().min(1),
  prompt: z.string(),
  /** The input form (text | choice | multiselect); validated when a response is submitted. */
  inputSpec: z.unknown(),
  assignees: z.array(z.string()).optional(),
});
/** The supervisor's human_input reply: the person's validated response. Re-validated child-side
 *  only for shape — the supervisor already validated it against the gate's input spec. */
export const humanInputReplySchema = z.strictObject({ response: z.unknown() });
export const writeArtifactArgsSchema = z.strictObject({
  name: z.string().min(1),
  contentType: z.string().min(1),
  /** Body crosses IPC as base64 — Uint8Array does not survive JSON serialization. */
  bodyBase64: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
/** read_artifact: the built-in `artifacts` tool reads a previously written artifact by name. */
export const readArtifactArgsSchema = z.strictObject({ name: z.string().min(1) });
/** The supervisor's read_artifact response (UTF-8 text). Re-validated child-side before use. */
export const readArtifactResultSchema = z.strictObject({ content: z.string() });
/** web_search: the built-in `web_search` tool brokers a query to the engine's configured provider. */
export const webSearchArgsSchema = z.strictObject({
  query: z.string().min(1),
  limit: z.number().int().positive().optional(),
});
/** The supervisor's web_search response — ranked results. Re-validated child-side before use. */
export const webSearchResultSchema = z.strictObject({
  results: z.array(
    z.strictObject({
      title: z.string(),
      url: z.string(),
      snippet: z.string().optional(),
    }),
  ),
});
export const resolveModelArgsSchema = z.strictObject({
  model: z.string().min(1).optional(),
  provider: z.string().min(1).optional(),
});
/** The supervisor's resolve_model response, re-validated child-side before use. */
export const resolvedModelSchema = z.strictObject({
  provider: z.string().min(1),
  /** Opaque — passed verbatim to the provider; never parsed. */
  model: z.string().min(1),
  protocol: z.enum(["anthropic", "openai", "bedrock"]),
  baseUrl: z.string().min(1),
  apiKey: z.string().nullable(),
  /** Extra request headers, resolved supervisor-side. */
  headers: z.record(z.string(), z.string()),
  /** Header names whose values are env-sourced — the leaf redacts them like the API key. */
  secretHeaderNames: z.array(z.string()),
  /** AWS region + SigV4 credentials — present only for protocol "bedrock". The secret values
   *  (secretAccessKey/sessionToken) are registered with the redactor child-side, like the key. */
  aws: z
    .strictObject({
      region: z.string().min(1),
      accessKeyId: z.string().min(1),
      secretAccessKey: z.string().min(1),
      sessionToken: z.string().min(1).optional(),
    })
    .optional(),
});
/**
 * mcp_token: the child asks the engine for an OAuth bearer token for an MCP server (token
 * state is PARENT-owned — the run process never sees refresh tokens or the store).
 * `invalidateToken` names a token the server just rejected, so the supervisor refreshes
 * instead of handing the same dead value back.
 */
export const mcpTokenArgsSchema = z.strictObject({
  serverUrl: z.string().min(1),
  invalidateToken: z.string().min(1).optional(),
});

/** The supervisor's mcp_token response. null accessToken ⇒ interaction would be required —
 *  the hint names the `engine.authorizeMcpServer(...)` call that fixes it. */
export const mcpTokenResultSchema = z.strictObject({
  accessToken: z.string().nullable(),
  hint: z.string().optional(),
});

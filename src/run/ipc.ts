// The supervisor ⇄ run-process IPC protocol.
//
// One run = one spawned Node process (SPEC §2.2). The child executes the user's program and
// brokers its SDK hook calls back to the supervisor over Node's built-in IPC channel. Every
// message is Zod-validated on receipt — the child runs user code, so everything it sends is a
// trust boundary (CODE_QUALITY §2.1).
//
// Envelope authority: the child sends event BODIES (no runId/turnId/seq/t); the supervisor is
// the single place envelopes are stamped and cursors allocated, so cursor monotonicity holds
// across crash-restarts without the child knowing about them.

import { z } from "zod";
import type { RunEvent, WorkflowManifest, JsonValue } from "@boardwalk/workflow";

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
  /** Absolute path to the bundled program (ESM, `@boardwalk/workflow` external). */
  programPath: string;
  /** The run's isolated working directory (the child chdirs here before importing the program). */
  workspaceDir: string;
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

export type ParentToChild = InitMessage | HostResultMessage;

// The child validates only the discriminator + the fields it dereferences; the manifest was
// already validated by the store and `unknown` payloads are narrowed at their use sites.
export const parentToChildSchema = z.union([
  z.object({
    type: z.literal("init"),
    runId: z.string().min(1),
    programPath: z.string().min(1),
    workspaceDir: z.string().min(1),
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
  "resolve_model",
  "mcp_token",
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
    type: z.literal("turn_started"),
    turnId: z.string().min(1),
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
  }),
]);
export type ChildToParent = z.infer<typeof childToParentSchema>;

// Host-call argument schemas, validated supervisor-side before acting.
export const getSecretArgsSchema = z.strictObject({ name: z.string().min(1) });
export const callWorkflowArgsSchema = z.strictObject({
  slug: z.string().min(1),
  input: z.unknown(),
  idempotencyKey: z.string().min(1).optional(),
});
export const writeArtifactArgsSchema = z.strictObject({
  name: z.string().min(1),
  contentType: z.string().min(1),
  /** Body crosses IPC as base64 — Uint8Array does not survive JSON serialization. */
  bodyBase64: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
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
  protocol: z.enum(["anthropic", "openai"]),
  baseUrl: z.string().min(1),
  apiKey: z.string().nullable(),
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

// SPDX-License-Identifier: Apache-2.0

// The program↔host protocol server — the ENGINE side of the SDK's host protocol
// (`@boardwalk-labs/workflow` protocol.ts): JSON-RPC 2.0 over a local stream socket (a Unix
// domain socket, or a named pipe on win32), framed as newline-delimited JSON. The run process
// serves this socket and the SDK connects to it (`BOARDWALK_HOST_SOCK`), so a workflow program
// speaks EXACTLY the contract it speaks on every other Boardwalk engine — one wire, no local
// dialect. Params are validated with the SDK's own method schemas (`clientToHostRequests`), so
// this server can never drift from what the published client sends.
//
// The protocol is FULL-DUPLEX:
//   - client → host requests: `bootstrap` / `report_return` (loader-only) + one method per
//     author capability, dispatched onto the injected {@link HostCapabilities} seam.
//   - host → client requests: `tool_invoke` — how an inline `agent()` tool declared in the
//     program runs. The leaf loop stays host-side; the wire carries DECLARATIONS only, and
//     this server turns each declaration into an engine `ToolDef` whose `execute()`
//     round-trips the call to the program. A handler error becomes an ordinary thrown Error
//     from `execute()` — a tool-error result for the model, NEVER run-fatal.
//   - host → client notification: `cancel` — the SDK aborts `context.signal`.
//
// Divergences from the hosted runner's reference server, all deliberate (engine scale):
//   - `report_return` does NO output-schema validation: this engine derives no I/O schemas
//     (the untyped floor — `input_schema`/`output_schema` are always null here), so there is
//     nothing to validate against and no Ajv dependency to carry.
//   - There is no browser backend, so `computer.openBrowser` fails closed through the
//     capability seam and every `computer.browser.*` call reports the missing session.

import * as net from "node:net";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import {
  clientToHostRequests,
  clientToHostNotifications,
  rpcFrameSchema,
  type AgentWireOptions,
  type ContextData,
  type HostMethod,
  type HostMethodParams,
  type HostMethodResult,
  type JsonValue,
  type RpcId,
  type ShellResult,
  type UsageSnapshot,
  type AgentOptions,
  type ArtifactBody,
  type ArtifactRef,
  type CallOptions,
  type HumanInputOptions,
  type HumanInputResult,
  type PhaseOptions,
  type ScheduleOptions,
  type SleepArg,
  type ToolDef,
} from "@boardwalk-labs/workflow/runtime";
import type { ShellOptions } from "@boardwalk-labs/workflow";
import { EngineError } from "../errors.js";

/** What `workflows.call` resolves at the capability seam: the child's output plus the callee's
 *  declared output schema. This engine stores no derived schemas, so it is honestly `null`
 *  (the SDK then passes the JSON through un-revived). */
export interface CapabilityCallResult {
  output: unknown;
  outputSchema: Record<string, unknown> | null;
}

/**
 * The typed seam the protocol server dispatches onto — the engine's local implementations,
 * one member per capability. Mirrors the SDK client's `HostInterface` (minus `signal`, which
 * is a client-side synthesis) so the two ends of the wire stay symmetric. `agent` receives
 * NATIVE `AgentOptions`: this server has already turned wire tool declarations into
 * executable `ToolDef`s that round-trip `tool_invoke`.
 *
 * A capability this engine cannot provide throws `EngineError("UNSUPPORTED", …)` with a
 * clear message — fail-closed, never a silent stub.
 */
export interface HostCapabilities {
  agent(prompt: string, opts: AgentOptions | undefined): Promise<unknown>;
  callWorkflow(
    slug: string,
    input: unknown,
    opts: CallOptions | undefined,
  ): Promise<CapabilityCallResult>;
  runWorkflow(slug: string, input: unknown, opts: CallOptions | undefined): Promise<string>;
  scheduleWorkflow(slug: string, input: unknown, opts: ScheduleOptions): Promise<string>;
  sleep(arg: SleepArg): Promise<void>;
  humanInput(opts: HumanInputOptions): Promise<HumanInputResult>;
  getSecret(name: string): Promise<string>;
  writeArtifact(
    name: string,
    contentType: string,
    body: ArtifactBody,
    metadata: Record<string, unknown> | undefined,
  ): Promise<ArtifactRef>;
  shell(cmd: string, opts: ShellOptions | undefined): Promise<ShellResult>;
  phase(name: string, opts: PhaseOptions | undefined): void;
  idToken(audience: string): Promise<string>;
  apiToken(): Promise<string>;
  usage(): Promise<UsageSnapshot>;
}

/** The `bootstrap` payload: the raw JSON input (this engine derives no input schema, so
 *  `input_schema` is always null on the wire) + the context DATA (never `signal`). */
export interface BootstrapData {
  input: JsonValue;
  context: ContextData;
}

export interface HostServerOptions {
  capabilities: HostCapabilities;
  bootstrap: BootstrapData;
  /** Directory the Unix socket file is created in. Default `os.tmpdir()` — deliberately short
   *  (`sun_path` caps a socket path at ~104 bytes on darwin). Ignored on win32 (named pipe). */
  sockDir?: string | undefined;
}

interface PendingInvoke {
  resolve: (value: { output: JsonValue }) => void;
  reject: (reason: Error) => void;
}

/** One connected protocol client (the program; the loader and its imports share one). */
class HostConnection {
  private buffer = "";
  /** Ids of OUR outbound (host → client) requests awaiting a response. */
  readonly pendingInvokes = new Map<number, PendingInvoke>();

  constructor(
    readonly socket: net.Socket,
    private readonly onFrame: (conn: HostConnection, frame: unknown) => void,
  ) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.buffer += chunk;
      let newline = this.buffer.indexOf("\n");
      while (newline !== -1) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (line !== "") this.onLine(line);
        newline = this.buffer.indexOf("\n");
      }
    });
  }

  private onLine(line: string): void {
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      return; // not JSON — nothing to even respond to; drop the line
    }
    this.onFrame(this, value);
  }

  send(frame: unknown): void {
    if (this.socket.destroyed) return;
    this.socket.write(JSON.stringify(frame) + "\n");
  }
}

/**
 * The protocol server for ONE run. `listen()` binds the socket (the run process then exports
 * the path as `BOARDWALK_HOST_SOCK`); `close()` tears everything down. The return the program
 * reported is read via {@link reportedReturn} after the loader completes.
 */
export class WorkflowHostServer {
  private readonly server: net.Server;
  private readonly connections = new Set<HostConnection>();
  private nextInvokeId = 1;
  private sockPath: string | null = null;
  private returned: { value: JsonValue } | null = null;
  private cancelled = false;

  constructor(private readonly opts: HostServerOptions) {
    this.server = net.createServer((socket) => {
      const conn = new HostConnection(socket, (c, frame) => {
        this.onFrame(c, frame);
      });
      this.connections.add(conn);
      socket.on("close", () => {
        this.connections.delete(conn);
        const closed = new Error("the program connection closed before the tool responded");
        for (const pending of conn.pendingInvokes.values()) pending.reject(closed);
        conn.pendingInvokes.clear();
      });
      socket.on("error", () => {
        socket.destroy();
      });
      // A client connecting after the cancel still learns of it (the notification is a level,
      // not an edge, from the program's point of view).
      if (this.cancelled) conn.send(cancelFrame());
    });
  }

  /** Bind the socket and resolve its path (a Unix socket path; a named pipe on win32). */
  async listen(): Promise<string> {
    const suffix = randomBytes(6).toString("hex");
    const path =
      process.platform === "win32"
        ? `\\\\.\\pipe\\bw-host-${suffix}`
        : join(this.opts.sockDir ?? tmpdir(), `bw-host-${suffix}.sock`);
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(path, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    this.sockPath = path;
    return path;
  }

  /** The value the program's loader reported via `report_return`, or null when no return was
   *  reported (the program never finished, or returned void ⇒ the client sent null). */
  reportedReturn(): JsonValue | null {
    return this.returned?.value ?? null;
  }

  /** Push the `cancel` notification to every connected client (idempotent). */
  notifyCancel(reason?: string): void {
    if (this.cancelled) return;
    this.cancelled = true;
    for (const conn of this.connections) conn.send(cancelFrame(reason));
  }

  /** Tear the server down: reject in-flight tool invokes, destroy connections, unlink the
   *  socket. Synchronous teardown of connections; the listener close is awaited. */
  async close(): Promise<void> {
    // Drain first: a fire-and-forget `phase` notification sent moments before a program throw
    // may be in flight on the loopback socket — give the event loop a couple of full turns so
    // already-sent frames dispatch before teardown.
    for (let i = 0; i < 2; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    for (const conn of this.connections) {
      const closed = new Error("the host server is shutting down");
      for (const pending of conn.pendingInvokes.values()) pending.reject(closed);
      conn.pendingInvokes.clear();
      conn.socket.destroy();
    }
    this.connections.clear();
    await new Promise<void>((resolve) => {
      this.server.close(() => {
        resolve();
      });
    });
    if (this.sockPath !== null && process.platform !== "win32") {
      try {
        rmSync(this.sockPath, { force: true });
      } catch {
        // Best-effort unlink — a leftover socket file in tmpdir is harmless.
      }
    }
  }

  // -- frame routing ---------------------------------------------------------

  private onFrame(conn: HostConnection, raw: unknown): void {
    const parsed = rpcFrameSchema.safeParse(raw);
    if (!parsed.success) {
      // Malformed frame: answer with a null-id error when we can't even read an id (JSON-RPC 2.0).
      conn.send({
        jsonrpc: "2.0",
        id: null,
        error: { code: "PROTOCOL_ERROR", message: "malformed JSON-RPC frame" },
      });
      return;
    }
    const frame = parsed.data;
    if ("method" in frame) {
      if ("id" in frame) {
        // Deliberately not awaited: requests dispatch CONCURRENTLY (a held humanInput must not
        // block a sibling agent call; parallel() multiplexes by JSON-RPC id).
        void this.handleRequest(conn, frame.id, frame.method, frame.params);
      } else {
        this.handleNotification(frame.method, frame.params);
      }
      return;
    }
    // A response frame — settle the matching outbound tool_invoke; unknown/late ids discarded.
    if ("error" in frame) {
      if (frame.id !== null) {
        this.settleInvoke(conn, frame.id, (pending) => {
          pending.reject(new Error(frame.error.message));
        });
      }
      return;
    }
    this.settleInvoke(conn, frame.id, (pending) => {
      // The client's tool result is `{output}` per the wire contract; tolerate a malformed one
      // by surfacing it as a tool error rather than crashing the leaf.
      const result = frame.result as { output?: JsonValue } | null | undefined;
      if (result === null || result === undefined || !("output" in result)) {
        pending.reject(new Error("tool_invoke response carried no output"));
        return;
      }
      pending.resolve({ output: result.output ?? null });
    });
  }

  private settleInvoke(
    conn: HostConnection,
    id: RpcId,
    apply: (pending: PendingInvoke) => void,
  ): void {
    if (typeof id !== "number") return;
    const pending = conn.pendingInvokes.get(id);
    if (pending === undefined) return; // late response to an abandoned invocation — discarded
    conn.pendingInvokes.delete(id);
    apply(pending);
  }

  private handleNotification(method: string, params: unknown): void {
    if (method !== "phase") return; // unknown notifications are ignored (additive forward-compat)
    const parsed = clientToHostNotifications.phase.params.safeParse(params);
    if (!parsed.success) return;
    // Fire-and-forget contract: a phase failure must never surface to the program.
    try {
      this.opts.capabilities.phase(
        parsed.data.name,
        pruneUndefined<PhaseOptions>(parsed.data.opts),
      );
    } catch (err) {
      console.error(
        `phase("${parsed.data.name}") failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async handleRequest(
    conn: HostConnection,
    id: RpcId,
    method: string,
    params: unknown,
  ): Promise<void> {
    if (!isHostMethod(method)) {
      conn.send({
        jsonrpc: "2.0",
        id,
        error: { code: "METHOD_NOT_FOUND", message: `unknown method "${method}"` },
      });
      return;
    }
    const parsed = clientToHostRequests[method].params.safeParse(params);
    if (!parsed.success) {
      conn.send({
        jsonrpc: "2.0",
        id,
        error: {
          code: "INVALID_PARAMS",
          message: `malformed ${method} params: ${parsed.error.message}`,
        },
      });
      return;
    }
    try {
      // The schema that ran IS clientToHostRequests[method].params, so the per-case narrowing
      // inside dispatch is exact.
      const result = await this.dispatch(conn, id, method, parsed.data);
      conn.send({ jsonrpc: "2.0", id, result });
    } catch (err) {
      conn.send({ jsonrpc: "2.0", id, error: protocolErrorOf(err) });
    }
  }

  // -- method dispatch -------------------------------------------------------

  private async dispatch<M extends HostMethod>(
    conn: HostConnection,
    id: RpcId,
    method: M,
    params: HostMethodParams<M>,
  ): Promise<HostMethodResult<HostMethod>> {
    const caps = this.opts.capabilities;
    switch (method) {
      case "bootstrap": {
        const b = this.opts.bootstrap;
        // This engine derives no I/O schemas (untyped floor): input_schema is honestly null,
        // so the SDK passes the raw JSON straight to run().
        return { input: b.input, input_schema: null, context: b.context };
      }
      case "report_return": {
        const { value } = params as HostMethodParams<"report_return">;
        // No output-schema validation on this engine (no derived schemas) — capture verbatim.
        this.returned = { value };
        return {};
      }
      case "agent": {
        const p = params as HostMethodParams<"agent">;
        const opts = this.toAgentOptions(conn, id, p.opts);
        const output = await caps.agent(p.prompt, opts);
        return { output: asJsonValue(output) };
      }
      case "workflows.call": {
        const p = params as HostMethodParams<"workflows.call">;
        const result = await caps.callWorkflow(
          p.slug,
          p.input,
          pruneUndefined<CallOptions>(p.opts),
        );
        return { output: asJsonValue(result.output), output_schema: result.outputSchema };
      }
      case "workflows.run": {
        const p = params as HostMethodParams<"workflows.run">;
        return {
          runId: await caps.runWorkflow(p.slug, p.input, pruneUndefined<CallOptions>(p.opts)),
        };
      }
      case "workflows.schedule": {
        const p = params as HostMethodParams<"workflows.schedule">;
        return {
          scheduleId: await caps.scheduleWorkflow(
            p.slug,
            p.input,
            pruneUndefined<ScheduleOptions>(p.opts),
          ),
        };
      }
      case "sleep": {
        const p = params as HostMethodParams<"sleep">;
        await caps.sleep(p.arg);
        return {};
      }
      case "humanInput": {
        const p = params as HostMethodParams<"humanInput">;
        // The wire schema mirrors HumanInputOptions field-for-field; pruning the zod
        // explicit-undefined optionals makes the shapes exact.
        return { result: await caps.humanInput(pruneUndefined<HumanInputOptions>(p.opts)) };
      }
      case "secrets.get": {
        const p = params as HostMethodParams<"secrets.get">;
        return { value: await caps.getSecret(p.name) };
      }
      case "artifacts.write": {
        const p = params as HostMethodParams<"artifacts.write">;
        const body: ArtifactBody =
          p.body.encoding === "utf8"
            ? p.body.data
            : new Uint8Array(Buffer.from(p.body.data, "base64"));
        const ref = await caps.writeArtifact(p.name, p.contentType, body, p.metadata);
        return { ref: { id: ref.id, name: ref.name, url: ref.url } };
      }
      case "computer.openBrowser":
        // No browser backend on this engine — fail closed with the actionable message.
        throw browserUnsupported();
      case "computer.browser.navigate":
      case "computer.browser.url":
      case "computer.browser.title":
      case "computer.browser.screenshot":
      case "computer.browser.console":
      case "computer.browser.network":
      case "computer.browser.eval":
      case "computer.browser.close":
        // Unreachable in practice (openBrowser above never hands out a session id), but a
        // hand-crafted call still gets the same clear refusal.
        throw browserUnsupported();
      case "shell": {
        const p = params as HostMethodParams<"shell">;
        return await caps.shell(p.cmd, pruneUndefined<ShellOptions>(p.opts));
      }
      case "auth.idToken": {
        const p = params as HostMethodParams<"auth.idToken">;
        return { token: await caps.idToken(p.audience) };
      }
      case "auth.apiToken":
        return { token: await caps.apiToken() };
      case "usage.get":
        return await caps.usage();
      default:
        return unreachable(method);
    }
  }

  // -- inline agent() tools (the tool_invoke callback lane) ------------------

  /** Wire tool declarations → engine `ToolDef`s whose `execute()` round-trips `tool_invoke` to
   *  the program, correlated by `call_id` = the originating agent request's own id (stringified). */
  private toAgentOptions(
    conn: HostConnection,
    agentRequestId: RpcId,
    wire: AgentWireOptions | undefined,
  ): AgentOptions | undefined {
    if (wire === undefined) return undefined;
    const { tools, sessionId, ...rest } = wire;
    if (sessionId !== undefined) {
      // agent({ session }) needs a live browser session, which this engine cannot open.
      throw browserUnsupported();
    }
    const callId = String(agentRequestId);
    return {
      ...(pruneUndefined<Omit<AgentOptions, "tools" | "session">>(rest) ?? {}),
      ...(tools !== undefined && tools.length > 0
        ? {
            tools: tools.map(
              (t): ToolDef => ({
                name: t.name,
                description: t.description,
                inputSchema: t.input_schema,
                execute: async (input: unknown) =>
                  (await this.invokeTool(conn, callId, t.name, asJsonValue(input))).output,
              }),
            ),
          }
        : {}),
    };
  }

  /** One host → client `tool_invoke` round-trip. Concurrent invocations multiplex by this
   *  request's own JSON-RPC id. No host-side timeout — parity with the engine leaf, which
   *  awaits an inline tool's `execute()` unbounded. */
  private invokeTool(
    conn: HostConnection,
    callId: string,
    tool: string,
    input: JsonValue,
  ): Promise<{ output: JsonValue }> {
    const id = this.nextInvokeId++;
    return new Promise<{ output: JsonValue }>((resolve, reject) => {
      conn.pendingInvokes.set(id, { resolve, reject });
      conn.send({
        jsonrpc: "2.0",
        id,
        method: "tool_invoke",
        params: { call_id: callId, tool, input },
      });
    });
  }
}

// -- helpers -----------------------------------------------------------------

function cancelFrame(reason?: string): unknown {
  return {
    jsonrpc: "2.0",
    method: "cancel",
    params: reason !== undefined ? { reason } : {},
  };
}

function isHostMethod(method: string): method is HostMethod {
  return Object.prototype.hasOwnProperty.call(clientToHostRequests, method);
}

function browserUnsupported(): EngineError {
  return new EngineError(
    "UNSUPPORTED",
    "computer.openBrowser is not available on this engine (no browser backend).",
    "Run this workflow on an engine with computer use (the hosted platform), or drop the browser session.",
  );
}

/**
 * Drop explicit-undefined optionals from a zod-parsed options object so it satisfies the SDK's
 * exact-optional native types. Zod types an `.optional()` field as `T | undefined`, which
 * `exactOptionalPropertyTypes` rejects; on the wire an absent optional is simply absent, so
 * pruning the (at most theoretical) explicit-undefined entries makes the cast exact.
 */
function pruneUndefined<T>(value: object): T;
function pruneUndefined<T>(value: object | undefined): T | undefined;
function pruneUndefined<T>(value: object | undefined): T | undefined {
  if (value === undefined) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = v;
  return out as T;
}

/** Boundary cast: capability results originate as JSON (IPC replies, model text, parsed model
 *  JSON), so they are wire-safe by construction; the type system just can't see it. */
function asJsonValue(value: unknown): JsonValue {
  return (value ?? null) as JsonValue;
}

const ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

/** Map a thrown value to the wire's `{code, message, data?}` (string code, engine taxonomy).
 *  An `EngineError.hint` (the one-line "what to do") rides `data.hint` so it SURVIVES the wire —
 *  the SDK surfaces it on `HostError.data.hint` and the loader's failure curation reads it back. */
export function protocolErrorOf(err: unknown): { code: string; message: string; data?: unknown } {
  const message = err instanceof Error ? err.message : String(err);
  const rawCode: unknown =
    typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
  const code =
    typeof rawCode === "string" && ERROR_CODE_RE.test(rawCode)
      ? rawCode
      : err instanceof Error && err.name !== ""
        ? err.name
        : "INTERNAL";
  const rawHint: unknown =
    typeof err === "object" && err !== null ? (err as { hint?: unknown }).hint : undefined;
  return {
    code,
    message,
    ...(typeof rawHint === "string" && rawHint !== "" ? { data: { hint: rawHint } } : {}),
  };
}

function unreachable(value: never): never {
  throw new Error(`unhandled host method: ${String(value)}`);
}

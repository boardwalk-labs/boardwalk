// SPDX-License-Identifier: Apache-2.0

// The run-process entry point. Spawned by the supervisor with an IPC channel; never run
// directly. Protocol: wait for `init`, then drive the run the way every Boardwalk engine
// does — the LOADER flow of the SDK host protocol:
//
//   1. Start the protocol server (host_server.ts) over the engine's local capability
//      implementations (child_host.ts) and export its socket as BOARDWALK_HOST_SOCK.
//   2. Connect the SDK's protocol client (the SAME `@boardwalk-labs/workflow` instance the
//      program will import — the run dir's node_modules symlink guarantees it), and
//      `bootstrap()` → { input, context }.
//   3. Import the program entry and call its DEFAULT-EXPORT `run(input, context)` —
//      positional, Lambda-style; a run() declaring fewer params is fine. Importing only
//      DEFINES `run`; execution is the explicit call (the module-body model is gone).
//   4. Report the return via `reportReturn` (`void` ⇒ null) and send `done` over IPC.
//
// A thrown error anywhere is reported over IPC when possible — the supervisor treats an exit
// without a report as a crash (which triggers restart-from-the-top, the documented
// semantics). SIGTERM is the cooperative-cancellation edge: it pushes the protocol `cancel`
// notification (aborting `context.signal`) and unwinds local holds; the supervisor's
// SIGKILL-after-grace remains the backstop.

import { pathToFileURL } from "node:url";
import type { JsonValue } from "@boardwalk-labs/workflow";
import {
  connectHost,
  HOST_SOCK_ENV,
  type ContextData,
  type HostClient,
} from "@boardwalk-labs/workflow/runtime";
import type { AgentIdentity } from "../agent/leaf.js";
import { LspService } from "../agent/lsp/index.js";
import type { Redactor } from "../agent/redact.js";
import { EngineError } from "../errors.js";
import { createChildHost, errorFromIpc } from "./child_host.js";
import { WorkflowHostServer } from "./host_server.js";
import { parentToChildSchema, type ChildToParent, type RunEventBody } from "./ipc.js";

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

function send(message: ChildToParent | { type: string; [k: string]: unknown }): void {
  // Why the guard: process.send disappears if the IPC channel closed (supervisor died);
  // at that point the orphan exits via the disconnect handler below — nothing to report to.
  process.send?.(message);
}

const pending = new Map<number, PendingCall>();
let nextCallId = 1;
let initialized = false;

process.on("disconnect", () => {
  // Orphaned by an engine crash. Exit so the boot recovery sweep owns the restart; holding on
  // with no supervisor would duplicate work when the engine comes back.
  process.exit(1);
});

process.on("message", (raw: unknown) => {
  const parsed = parentToChildSchema.safeParse(raw);
  if (!parsed.success) return; // Not ours; the supervisor only sends protocol messages.
  const msg = parsed.data;

  if (msg.type === "host_result") {
    const call = pending.get(msg.callId);
    if (call === undefined) return;
    pending.delete(msg.callId);
    if (msg.result.ok) call.resolve(msg.result.value);
    else call.reject(errorFromIpc(msg.result.error));
    return;
  }

  if (initialized) return; // A second init is a protocol violation; ignore.
  initialized = true;
  void runProgram(msg);
});

interface InitData {
  programPath: string;
  workspaceDir: string;
  programDir: string | null;
  skillsDir: string | null;
  input: unknown;
  context: ContextData;
}

async function runProgram(init: InitData): Promise<void> {
  let redactor: Redactor | undefined;
  // Per-run, engine-native LSP: spawns a language server in the workspace on first relevant edit,
  // reused across the run, shut down in the finally so no language-server child outlives the run.
  const lspService = new LspService({ workspaceDir: init.workspaceDir });
  // Cancellation plumbing: SIGTERM → abort local holds + push the protocol `cancel`
  // notification so `context.signal` fires in the program.
  const cancelController = new AbortController();
  let server: WorkflowHostServer | null = null;
  let client: HostClient | null = null;
  process.on("SIGTERM", () => {
    cancelController.abort();
    server?.notifyCancel();
  });
  try {
    process.chdir(init.workspaceDir);
    const childHost = createChildHost(
      {
        request(method, args) {
          return new Promise((resolve, reject) => {
            const callId = nextCallId++;
            pending.set(callId, { resolve, reject });
            send({ type: "host_call", callId, method, args });
          });
        },
        emit(body: RunEventBody, turnId?: string) {
          send({ type: "emit", body, ...(turnId !== undefined ? { turnId } : {}) });
        },
        startTurn(turnId: string, identity: AgentIdentity) {
          send({ type: "turn_started", turnId, ...identity });
        },
        reportUsage(modelRef, usage) {
          send({ type: "report_usage", modelRef, usage });
        },
        memoryUsed(dir) {
          send({ type: "memory_used", dir });
        },
      },
      {
        workspaceDir: init.workspaceDir,
        skillsDir: init.skillsDir,
        lspService,
        ...(init.programDir !== null ? { programDir: init.programDir } : {}),
      },
      { cancelSignal: cancelController.signal },
    );
    redactor = childHost.redactor;

    // The protocol server: the program's capability imports reach these local implementations
    // over the same wire they'd speak on any other Boardwalk engine.
    server = new WorkflowHostServer({
      capabilities: childHost.capabilities,
      bootstrap: {
        // Boundary cast: the input arrived as JSON over IPC (the run row's trigger payload),
        // so it is wire-safe by construction.
        input: (init.input ?? null) as JsonValue,
        context: init.context,
      },
    });
    const sockPath = await server.listen();
    // The ONE platform-owned env key a program keeps: how its SDK (and any subprocess speaking
    // the protocol) finds the host — the documented discovery contract.
    process.env[HOST_SOCK_ENV] = sockPath;

    // Connect eagerly and install as the SDK's active host: the program's capability imports
    // (same module instance, via the run-dir symlink) share this client instead of lazily
    // opening a second connection.
    client = await connectHost({ sockPath });
    const { input, context } = await client.bootstrap();

    const programModule: unknown = await import(pathToFileURL(init.programPath).href);
    const runFn = (programModule as { default?: unknown }).default;
    if (typeof runFn !== "function") {
      throw new EngineError(
        "VALIDATION",
        "The workflow entry has no `run` function default export.",
        "Export the entry as `export default async function run(input, context) { … }`.",
      );
    }
    // Positional, Lambda-style: input = param 0, context = param 1; a run() declaring fewer
    // params simply ignores the rest.
    const value: unknown = await (runFn as (input: unknown, context: unknown) => unknown)(
      input,
      context,
    );
    // The SDK canonically encodes the value (Date → ISO, …) and the server captures it; read
    // the captured wire form back so IPC carries exactly what any engine would persist.
    await client.reportReturn(value);
    send({ type: "done", output: server.reportedReturn() });
  } catch (err) {
    // Program errors can carry secret values the program legitimately read (secrets.get) —
    // this report persists in the run row and event stream, so it gets the same redaction
    // as everything model-bound. `redactor` may be unset if the failure preceded host setup;
    // nothing secret can have been revealed before that point.
    const scrub = (text: string): string => redactor?.redact(text) ?? text;
    const { code, message, hint } = curateFailure(err);
    send({
      type: "failed",
      error: {
        code: scrub(code),
        message: scrub(message),
        ...(hint !== undefined ? { hint: scrub(hint) } : {}),
      },
    });
  } finally {
    // Shut every language server down before exiting so no child outlives the run (close() is
    // best-effort + bounded: shutdown → exit → kill). The run's outcome was already reported above,
    // so a slow teardown only delays the process exit, it never changes the result.
    await lspService.close();
    client?.close();
    await server?.close();
    // Why disconnect-then-exit: process.send is async under the hood; disconnecting flushes
    // the channel so the final message is never lost to an immediate exit.
    process.disconnect();
    process.exit(0);
  }
}

/** A machine-readable error code shaped like one: SCREAMING_SNAKE, as an `EngineError.code`
 *  (`VALIDATION`, `BUDGET_EXCEEDED`, …), a HostError code off the protocol, and a Node syscall
 *  error (`ENOENT`) all are. */
const ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * Curate a thrown value into the run's `{ code, message, hint }` failure shape. Duck-typed on
 * purpose: the throw may be an `EngineError` (hint on `.hint`), a protocol `HostError` (the
 * capability's hint rides `.data.hint` across the wire — see host_server's protocolErrorOf),
 * or any author error. Message = what's wrong; hint = what to do.
 */
function curateFailure(err: unknown): { code: string; message: string; hint?: string } {
  const message = err instanceof Error ? err.message : String(err);
  const rawCode: unknown =
    typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
  const code =
    typeof rawCode === "string" && ERROR_CODE_RE.test(rawCode) ? rawCode : "PROGRAM_ERROR";
  const hint = errorHint(err);
  return { code, message, ...(hint !== undefined ? { hint } : {}) };
}

function errorHint(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const hint: unknown = (err as { hint?: unknown }).hint;
  if (typeof hint === "string" && hint !== "") return hint;
  const data: unknown = (err as { data?: unknown }).data;
  if (typeof data === "object" && data !== null) {
    const dataHint: unknown = (data as { hint?: unknown }).hint;
    if (typeof dataHint === "string" && dataHint !== "") return dataHint;
  }
  return undefined;
}

// The run-process entry point. Spawned by the supervisor with an IPC channel; never run
// directly. Protocol: wait for `init`, install the SDK host + run inputs, then IMPORT the
// program bundle — the module body is the program, so importing the file IS running it
// (MASTER_SPEC §2.1; no entrypoint convention). Report `done`/`failed`, exit. A thrown error
// anywhere is reported over IPC when possible — the supervisor treats an exit without a
// report as a crash (which triggers restart-from-the-top, the documented semantics).

import { pathToFileURL } from "node:url";
import {
  installConfig,
  installHost,
  installInput,
  takeDeclaredOutput,
} from "@boardwalk/workflow/runtime";
import type { JsonValue } from "@boardwalk/workflow";
import { EngineError, toErrorShape } from "../errors.js";
import { asJsonValue } from "../json_value.js";
import { createChildHost, errorFromIpc } from "./child_host.js";
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
  void runProgram(msg.programPath, msg.workspaceDir, msg.input, msg.config);
});

async function runProgram(
  programPath: string,
  workspaceDir: string,
  input: unknown,
  config: Record<string, unknown>,
): Promise<void> {
  try {
    process.chdir(workspaceDir);
    installHost(
      createChildHost({
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
        startTurn(turnId: string) {
          send({ type: "turn_started", turnId });
        },
        reportUsage(modelRef, usage) {
          send({ type: "report_usage", modelRef, usage });
        },
      }),
    );
    installInput(input);
    installConfig(narrowConfig(config));

    // Importing IS running: the module body is the program; top-level await is the norm; the
    // run completes when evaluation finishes and fails when the body throws.
    const programModule: unknown = await import(pathToFileURL(programPath).href);
    warnOnLegacyDefaultExport(programModule);

    const declared = takeDeclaredOutput();
    send({
      type: "done",
      output: declared === null ? null : declared.value,
      outputDeclared: declared !== null,
    });
  } catch (err) {
    const shape = toErrorShape(err);
    const hint = err instanceof EngineError ? err.hint : undefined;
    send({ type: "failed", error: { ...shape, ...(hint !== undefined ? { hint } : {}) } });
  } finally {
    // Why disconnect-then-exit: process.send is async under the hood; disconnecting flushes
    // the channel so the final message is never lost to an immediate exit.
    process.disconnect();
    process.exit(0);
  }
}

/** Per-key narrowing of the deploy-time config crossing IPC (no record-level cast). */
function narrowConfig(config: Record<string, unknown>): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(config)) {
    out[key] = asJsonValue(value, `config.${key}`);
  }
  return out;
}

/**
 * The rescinded draft convention wrapped the program in `export default async function run()`.
 * Such a function is NEVER called (the module body is the program) — warn so an author who
 * wrapped their logic learns why nothing happened. Stderr lands in the run log.
 */
function warnOnLegacyDefaultExport(programModule: unknown): void {
  if (typeof programModule !== "object" || programModule === null) return;
  const candidate: unknown = Reflect.get(programModule, "default");
  if (typeof candidate === "function") {
    console.error(
      "warning: this workflow exports a default function, which Boardwalk does not call — " +
        "the module body IS the program. Move the function's body to the top level " +
        "(top-level await is supported).",
    );
  }
}

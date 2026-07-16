// SPDX-License-Identifier: Apache-2.0

// The `run_code` tool: programmatic tool calling (PTC). The leaf writes a JavaScript snippet that
// orchestrates its OTHER tools in code — loops, filters, aggregations — and only what the code
// `console.log`s or `return`s comes back into model context. The individual tool results the code
// consumes NEVER enter context.
//
// This is the one intervention that improves accuracy AND cost together: a fat leaf that would make
// dozens of tool calls (each result re-sent every append-only turn) collapses into a single turn whose
// only context cost is the code's final, filtered output. See docs/AGENT_EFFICIENCY.md P6.
//
// Model-agnostic by construction: it is an ordinary Boardwalk tool, so it works on the managed `auto`
// lane and every BYO provider — unlike Anthropic's server-side PTC beta, which our routing can't reach.
//
// Execution model: the snippet runs in a WORKER THREAD (worker_threads), NOT in the leaf's own event
// loop. This grants no capability the leaf doesn't already have — `bash` is default-on and already
// runs arbitrary code, and the run's isolation boundary is the per-run microVM/container, not the JS
// realm — but it makes the snippet hard-bounded: the parent enforces the wall-clock timeout by
// `terminate()`-ing the worker, which kills a runaway synchronous loop (`while (true) {}`) that an
// in-process async timer could never interrupt (a blocked event loop can't fire its own timeout).
//
// The worker can't hold the leaf's tool closures (they capture MCP connections, the workspace, the
// host), so tools are BRIDGED: the snippet's `tools.<name>(args)` posts a call to the parent, which
// executes the real tool where its closure lives and posts the text result back. The parent sees the
// raw result (trusted layer); only what the snippet logs/returns crosses back, and the loop redacts
// that like any tool result, so secrets can't reach the model. Output is capped on both sides (the
// worker stops posting past the cap so a runaway log can't flood the bridge; the parent is the
// truncation authority).

import { Worker } from "node:worker_threads";
import type {
  ExecutableTool,
  RichToolResult,
  ToolExecuteResult,
  ToolOutputSink,
} from "../tools.js";
import { EngineError } from "../../errors.js";

/** The tools `run_code` never exposes to the snippet: itself (added after this set is built, so it is
 *  excluded by construction) plus the meta-tools whose semantics don't compose inside a code call. */
export const RUN_CODE_EXCLUDED_TOOLS: ReadonlySet<string> = new Set([
  "subagent",
  "human_input",
  "find_tools",
]);

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
/** Cap on combined logged + returned output. The point of PTC is that the model filters in code and
 *  returns a summary; this only stops a runaway log from blowing the window. */
const MAX_OUTPUT_CHARS = 60_000;
/** The worker stops posting log output a little past the parent's cap — enough that the parent (the
 *  truncation authority) sees the overflow and flags it, while the bridge never carries a 10 MB log. */
const WORKER_LOG_CAP = MAX_OUTPUT_CHARS + 512;

/** Messages the worker sends the parent. Trusted (our own bootstrap emits them). */
type WorkerToParent =
  | { type: "call"; id: number; name: string; args: Record<string, unknown> }
  | { type: "log"; text: string }
  | { type: "done"; returnValue: string }
  | { type: "throw"; message: string };
/** Messages the parent sends the worker in reply to a `call`. */
type ParentToWorker =
  | { type: "result"; id: number; text: string }
  | { type: "callError"; id: number; message: string };

/**
 * Build the `run_code` tool over the leaf's callable tool set. Constructed by the leaf layer once the
 * full tool set is resolved (like `subagent`), passing every tool EXCEPT the excluded meta-tools; the
 * snippet reaches them as `await tools.<name>(input)`.
 */
export function runCodeTool(callable: readonly ExecutableTool[]): ExecutableTool {
  const byName = new Map(callable.map((t) => [t.name, t]));
  const names = [...byName.keys()];

  return {
    name: "run_code",
    description: buildDescription(names),
    inputSchema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description:
            "An async JavaScript function body. Call your other tools with `await tools.<name>(input)` " +
            "(each returns its text result). Only what you console.log or `return` comes back to you; " +
            "everything else stays out of context. Filter/aggregate here and return just the summary.",
        },
        timeoutMs: {
          type: "number",
          description: `Optional wall-clock limit in ms (default ${String(DEFAULT_TIMEOUT_MS)}, max ${String(MAX_TIMEOUT_MS)}).`,
        },
      },
      required: ["code"],
      additionalProperties: false,
    },
    execute: (input, onOutput) => runCode(input, byName, onOutput),
  };
}

async function runCode(
  input: Record<string, unknown>,
  byName: ReadonlyMap<string, ExecutableTool>,
  onOutput?: ToolOutputSink,
): Promise<RichToolResult> {
  const code = input.code;
  if (typeof code !== "string" || code.trim() === "") {
    throw new EngineError("VALIDATION", "run_code `code` must be a non-empty JavaScript string.");
  }
  const timeoutMs = readTimeout(input.timeoutMs);
  const output = new BoundedOutput(MAX_OUTPUT_CHARS);
  let toolCallCount = 0;

  let worker: Worker;
  try {
    worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(WORKER_SOURCE)}`), {
      workerData: { code, logCap: WORKER_LOG_CAP },
    });
  } catch (err) {
    // Failing to even start the worker is ours, not the model's — surface it as an error result.
    return errorResult(err instanceof Error ? err.message : String(err), output);
  }

  return await new Promise<RichToolResult>((resolve) => {
    let settled = false;
    const settle = (result: RichToolResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(result);
    };
    // The decisive bound: because the snippet runs in another THREAD, a synchronous loop there does
    // not block THIS event loop, so this timer still fires and terminates the worker.
    const timer = setTimeout(() => {
      settle(errorResult(`exceeded ${String(timeoutMs)}ms (terminated)`, output));
    }, timeoutMs);

    const post = (msg: ParentToWorker): void => {
      if (settled) return;
      try {
        worker.postMessage(msg);
      } catch {
        // The worker is gone (terminated) — nothing to reply to.
      }
    };

    const handle = async (msg: WorkerToParent): Promise<void> => {
      switch (msg.type) {
        case "call": {
          toolCallCount += 1;
          // Live-view TRACE of each inner call (redacted by the loop like any stream); it goes only to
          // the stream, never into `output`, so the model's result stays the code's own summary.
          onOutput?.("stdout", `» ${msg.name}(${argsPreview(msg.args)})\n`);
          const tool = byName.get(msg.name);
          if (tool === undefined) {
            post({
              type: "callError",
              id: msg.id,
              message: `run_code: no tool named "${msg.name}". Available: ${[...byName.keys()].join(", ")}.`,
            });
            return;
          }
          try {
            const text = toText(await tool.execute(msg.args));
            post({ type: "result", id: msg.id, text });
          } catch (err) {
            post({
              type: "callError",
              id: msg.id,
              message: err instanceof Error ? err.message : String(err),
            });
          }
          return;
        }
        case "log":
          output.push(msg.text);
          onOutput?.("stdout", msg.text);
          return;
        case "done":
          settle(successResult(output, msg.returnValue, toolCallCount));
          return;
        case "throw":
          settle(errorResult(msg.message, output));
          return;
      }
    };

    worker.on("message", (msg: WorkerToParent) => void handle(msg));
    worker.on("error", (err: Error) => settle(errorResult(err.message, output)));
    worker.on("exit", (exitCode: number) => {
      if (!settled) {
        settle(
          errorResult(`run_code worker exited unexpectedly (code ${String(exitCode)})`, output),
        );
      }
    });
  });
}

/** The success result: the code's logged output plus its serialized return value, capped. */
function successResult(
  output: BoundedOutput,
  returnValue: string,
  toolCallCount: number,
): RichToolResult {
  const logged = output.text();
  const body =
    logged !== "" && returnValue !== ""
      ? `${logged}\nreturn: ${returnValue}`
      : logged !== ""
        ? logged
        : returnValue !== ""
          ? `return: ${returnValue}`
          : "(no output; the code neither logged nor returned a value)";
  const clipped = clip(body, MAX_OUTPUT_CHARS);
  const truncated = output.wasTruncated() || clipped.truncated;
  return {
    llmText: clipped.text + (truncated ? "\n… (output truncated)" : ""),
    event: {
      kind: "code_execution",
      humanSummary: `ran code: ${String(toolCallCount)} tool call(s), ${String(clipped.text.length)} chars out`,
    },
  };
}

/** An error result the model can recover from (a throw, a timeout, a worker crash) — the message plus
 *  any output the code produced first. Never fails the run. */
function errorResult(message: string, output: BoundedOutput): RichToolResult {
  const logged = output.text();
  const text = logged !== "" ? `${logged}\nError: ${message}` : `Error: ${message}`;
  return {
    llmText: clip(text, MAX_OUTPUT_CHARS).text,
    event: { kind: "code_execution", humanSummary: `run_code error: ${firstLine(message)}` },
  };
}

/** A tool result as the string the snippet receives: a plain string as-is, else the RichToolResult's
 *  model-facing text. Mirrors how an inline ToolDef's return is stringified. */
function toText(result: ToolExecuteResult): string {
  if (typeof result === "string") return result;
  return result.llmText;
}

function readTimeout(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.floor(raw), MAX_TIMEOUT_MS);
}

/** A compact, capped preview of a tool call's arguments for the live-view trace line. */
function argsPreview(args: Record<string, unknown>): string {
  let s: string;
  try {
    s = JSON.stringify(args) ?? "";
  } catch {
    s = "";
  }
  return s.length > 120 ? s.slice(0, 120) + "…" : s;
}

function firstLine(text: string): string {
  const line = text.split("\n")[0] ?? "";
  return line.length > 200 ? line.slice(0, 200) + "…" : line;
}

function clip(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max), truncated: true };
}

/** A cheap char-bounded sink for the snippet's console output — stops accumulating once full. */
class BoundedOutput {
  private buf = "";
  private truncated = false;
  constructor(private readonly max: number) {}
  push(text: string): void {
    if (this.truncated) return;
    const room = this.max - this.buf.length;
    if (text.length <= room) {
      this.buf += text;
    } else {
      this.buf += text.slice(0, room);
      this.truncated = true;
    }
  }
  text(): string {
    return this.buf;
  }
  wasTruncated(): boolean {
    return this.truncated;
  }
}

/** Cap the tool names listed in the description so a large (deferred) MCP set doesn't reinflate this
 *  tool's own schema — the point P7 exists to avoid. Names are cheap; full schemas are not, and any
 *  tool is still callable by name whether or not it's listed here. */
const MAX_NAMES_IN_DESCRIPTION = 40;

function buildDescription(names: readonly string[]): string {
  const shown = names.slice(0, MAX_NAMES_IN_DESCRIPTION);
  const more = names.length - shown.length;
  const list =
    names.length === 0
      ? "(no other tools)"
      : shown.join(", ") + (more > 0 ? `, and ${String(more)} more (call any by name)` : "");
  return (
    "Run JavaScript to orchestrate your other tools in code, so their intermediate results stay OUT " +
    "of your context — only what you console.log or `return` comes back. Use this instead of many " +
    "separate tool calls whenever you'd fetch/read/query repeatedly and only need a summary: loop, " +
    "filter, and aggregate in code, then return the small result. Call a tool with " +
    "`await tools.<name>(input)`; it resolves to that tool's text result. The `code` is an async " +
    `function body. Available tools: ${list}. Example: ` +
    "`const hits = []; for (const f of files) { const c = await tools.read({ path: f }); " +
    'if (c.includes("TODO")) hits.push(f); } return hits;`'
  );
}

// The worker bootstrap (an ES module, delivered as a data: URL). Plain JS — NOT typechecked by the
// engine's tsc — deliberately using string concatenation, no template literals, so it embeds cleanly
// in the template literal below. It sets up the tool bridge, a console shim, and runs the snippet as
// an async function, reporting everything back over the message port.
const WORKER_SOURCE = `
import { parentPort, workerData } from "node:worker_threads";
const port = parentPort;
const code = workerData.code;
const LOG_CAP = workerData.logCap;

let nextId = 0;
const pending = new Map();
port.on("message", (msg) => {
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  if (msg.type === "result") p.resolve(msg.text);
  else p.reject(new Error(msg.message));
});

function invoke(name, args) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    try {
      port.postMessage({ type: "call", id: id, name: name, args: args === undefined || args === null ? {} : args });
    } catch (e) {
      pending.delete(id);
      reject(new Error("run_code: argument to " + name + "() is not structured-cloneable" + (e && e.message ? ": " + e.message : "")));
    }
  });
}

const tools = new Proxy({ call: invoke }, {
  get(target, prop) {
    if (prop === "call") return invoke;
    if (typeof prop === "string") return (args) => invoke(prop, args);
    return undefined;
  },
});

function ser(v) {
  if (v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
  try { const j = JSON.stringify(v); if (j !== undefined) return j; } catch (e) {}
  return "[unserializable value]";
}
function fmt(a) { return a.map((x) => (typeof x === "string" ? x : ser(x))).join(" "); }

let logged = 0;
function emitLog(text) {
  if (logged >= LOG_CAP) return;
  const remaining = LOG_CAP - logged;
  const chunk = text.length <= remaining ? text : text.slice(0, remaining);
  logged += chunk.length;
  port.postMessage({ type: "log", text: chunk });
}
const consoleShim = {
  log: (...a) => emitLog(fmt(a) + "\\n"),
  error: (...a) => emitLog(fmt(a) + "\\n"),
  warn: (...a) => emitLog(fmt(a) + "\\n"),
  info: (...a) => emitLog(fmt(a) + "\\n"),
  debug: (...a) => emitLog(fmt(a) + "\\n"),
};

(async () => {
  try {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const fn = new AsyncFunction("tools", "console", code);
    const ret = await fn(tools, consoleShim);
    port.postMessage({ type: "done", returnValue: ser(ret) });
  } catch (e) {
    const name = e && e.name && e.name !== "Error" ? String(e.name) + ": " : "";
    const message = e && e.message ? String(e.message) : String(e);
    port.postMessage({ type: "throw", message: name + message });
  }
})();
`;

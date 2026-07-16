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
// Execution model: the snippet runs IN-PROCESS as an async function with the leaf's tools bound as
// async functions on a `tools` object. This grants NO capability the leaf doesn't already have — the
// built-in `bash` tool is default-on and already runs arbitrary code; the run's isolation boundary is
// the per-run microVM/container, not the JS realm (the run-isolation invariant). So `run_code` is
// exactly as privileged as `bash`, and no global sandboxing is attempted (it would be theater next to
// a shell). What the code returns is redacted by the loop like any tool result, so secrets can't leak
// to the model even though the trusted code layer sees raw tool output.
//
// Bounds: a wall-clock timeout races the async execution, and output is capped (the model is meant to
// summarize IN code, but a runaway log can't blow the window). A pathological *synchronous* infinite
// loop (no await) is bounded only by the run's duration budget, same class of exposure as a `bash`
// `while true`; a child-process bridge would harden this and is the v1 follow-up.

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

/** The AsyncFunction constructor, typed. Same class of primitive as `bash` spawning a shell — see the
 *  module header on why in-process execution grants nothing beyond the default-on `bash`. */
type AsyncFnCtor = new (...args: string[]) => (...args: unknown[]) => Promise<unknown>;

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

  const output = new BoundedOutput(MAX_OUTPUT_CHARS);
  const emit = (text: string): void => {
    output.push(text);
    onOutput?.("stdout", text);
  };
  const consoleShim = {
    log: (...args: unknown[]) => emit(formatArgs(args) + "\n"),
    error: (...args: unknown[]) => emit(formatArgs(args) + "\n"),
    warn: (...args: unknown[]) => emit(formatArgs(args) + "\n"),
    info: (...args: unknown[]) => emit(formatArgs(args) + "\n"),
  };

  let toolCallCount = 0;
  const invoke = async (name: string, args: unknown): Promise<string> => {
    const tool = byName.get(name);
    if (tool === undefined) {
      throw new EngineError(
        "VALIDATION",
        `run_code: no tool named "${name}". Available: ${[...byName.keys()].join(", ")}.`,
      );
    }
    toolCallCount += 1;
    const record = args !== undefined && args !== null ? (args as Record<string, unknown>) : {};
    // A live-view TRACE of each inner call (via onOutput, redacted by the loop like any stream), so a
    // viewer can see what the code is doing. It goes ONLY to the stream, never to `output` — the
    // model's result stays the code's own logged/returned summary, which is the point of PTC.
    onOutput?.("stdout", `» ${name}(${argsPreview(record)})\n`);
    return toText(await tool.execute(record));
  };
  // `tools.<name>(input)` for every callable tool, plus a `call(name, input)` escape hatch.
  const toolsObj: Record<string, unknown> = { call: invoke };
  for (const name of byName.keys()) {
    toolsObj[name] = (args: unknown): Promise<string> => invoke(name, args);
  }

  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as AsyncFnCtor;
  let compiled: (...args: unknown[]) => Promise<unknown>;
  try {
    compiled = new AsyncFunction("tools", "console", code);
  } catch (err) {
    // A syntax error is the model's to fix — return it as the tool result, don't fail the run.
    return errorResult(`SyntaxError: ${err instanceof Error ? err.message : String(err)}`, output);
  }

  const timeoutMs = readTimeout(input.timeoutMs);
  let returned: unknown;
  try {
    returned = await withTimeout(compiled(toolsObj, consoleShim), timeoutMs);
  } catch (err) {
    // A throw from the snippet (or a tool it called) is the model's to recover from — surface it as
    // the result text, keeping any output the code produced before it threw.
    const message = err instanceof Error ? err.message : String(err);
    return errorResult(message, output);
  }

  const logged = output.text();
  const returnText = serializeReturn(returned);
  const body =
    logged !== "" && returnText !== ""
      ? `${logged}\nreturn: ${returnText}`
      : logged !== ""
        ? logged
        : returnText !== ""
          ? `return: ${returnText}`
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

/** Race a promise against a wall-clock timeout (bounds async hangs; see the module header for the
 *  synchronous-loop caveat). */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new EngineError("PROGRAM_ERROR", `run_code exceeded ${String(ms)}ms.`)),
      ms,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

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

function serializeReturn(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  // Primitives with their own toString are safe; objects go through JSON (never default
  // "[object Object]" stringification).
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  try {
    const json = JSON.stringify(value);
    if (json !== undefined) return json;
  } catch {
    // A cyclic structure or a bigint inside — fall through to a stable placeholder.
  }
  return "[unserializable value]";
}

function formatArgs(args: readonly unknown[]): string {
  return args.map((a) => (typeof a === "string" ? a : serializeReturn(a))).join(" ");
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

// SPDX-License-Identifier: Apache-2.0

// The `todo` built-in: a task-list scratchpad for multi-step work. The model sends its COMPLETE
// list each call (replace semantics, like every leading agent's todo tool) and the tool renders it
// back. ENGINE-NATIVE, PURE, and STATELESS — the working state lives in the transcript (the tool
// call + its result), not in engine memory, so there is nothing to persist, race, or get stale, and
// a forked subagent leaf can't trip over shared state.
//
// Why a tool and not "just write a list in your reply": writing the plan down as a structured,
// re-rendered artifact keeps the model honest about progress on long jobs, and the result frame is
// something run observers (the web UI) can surface as a live checklist later.
//
// No side effects on the world (no workspace/network/storage write), so it joins the `"read-only"`
// set: a multi-step research/inspection agent benefits from planning too.

import { z } from "zod";
import { EngineError } from "../../errors.js";
import type { ExecutableTool } from "../tools.js";

const todoStatus = z.enum(["pending", "in_progress", "completed"]);
const todoInput = z.object({
  todos: z.array(z.object({ content: z.string().min(1), status: todoStatus })),
});

const MARK: Record<z.infer<typeof todoStatus>, string> = {
  completed: "[x]",
  in_progress: "[~]",
  pending: "[ ]",
};

/** Render the list the model just sent back to it, so the current plan is visible in context. */
function render(todos: z.infer<typeof todoInput>["todos"]): string {
  if (todos.length === 0) return "Todo list cleared (no tasks).";
  const done = todos.filter((t) => t.status === "completed").length;
  const lines = todos.map((t) => `${MARK[t.status]} ${t.content}`);
  return `Todo list (${String(done)}/${String(todos.length)} done):\n${lines.join("\n")}`;
}

export function todoTool(): ExecutableTool {
  return {
    name: "todo",
    description:
      "Track a multi-step task list. Send the COMPLETE list each time (it replaces the previous " +
      "one): keep one task `in_progress` while you work it and flip tasks to `completed` as you " +
      "finish. Use it to stay organized on complex jobs; skip it for trivial single-step tasks.",
    inputSchema: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          description: "The complete task list (replaces any previous list).",
          items: {
            type: "object",
            properties: {
              content: { type: "string", description: "What the task is." },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed"],
              },
            },
            required: ["content", "status"],
            additionalProperties: false,
          },
        },
      },
      required: ["todos"],
      additionalProperties: false,
    },
    execute: (input) => {
      const parsed = todoInput.safeParse(input);
      if (!parsed.success) {
        throw new EngineError(
          "VALIDATION",
          `todo: ${parsed.error.issues.map((i) => i.message).join("; ")}.`,
          'Each item is { content: string, status: "pending" | "in_progress" | "completed" }.',
        );
      }
      return Promise.resolve(render(parsed.data.todos));
    },
  };
}

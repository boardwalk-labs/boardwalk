// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { EngineError } from "../../errors.js";
import { todoTool } from "./todo.js";

const tool = todoTool();

describe("todo", () => {
  it("renders the list with status marks and a done count", async () => {
    const out = await tool.execute({
      todos: [
        { content: "Read the config", status: "completed" },
        { content: "Apply the migration", status: "in_progress" },
        { content: "Verify the output", status: "pending" },
      ],
    });
    expect(out).toBe(
      "Todo list (1/3 done):\n[x] Read the config\n[~] Apply the migration\n[ ] Verify the output",
    );
  });

  it("treats an empty list as a clear", async () => {
    expect(await tool.execute({ todos: [] })).toBe("Todo list cleared (no tasks).");
  });

  it("is stateless — each call renders exactly what it was given (replace semantics)", async () => {
    await tool.execute({ todos: [{ content: "first", status: "pending" }] });
    const second = await tool.execute({ todos: [{ content: "second", status: "completed" }] });
    expect(second).toBe("Todo list (1/1 done):\n[x] second");
    expect(second).not.toContain("first");
  });

  it("rejects an unknown status as a VALIDATION error", () => {
    expect(() => tool.execute({ todos: [{ content: "x", status: "blocked" }] })).toThrow(
      EngineError,
    );
    try {
      void tool.execute({ todos: [{ content: "x", status: "blocked" }] });
    } catch (err) {
      expect(err instanceof EngineError ? err.code : "").toBe("VALIDATION");
    }
  });

  it("rejects an empty task content", () => {
    expect(() => tool.execute({ todos: [{ content: "", status: "pending" }] })).toThrow(
      EngineError,
    );
  });

  it("rejects a malformed payload (todos not an array)", () => {
    expect(() => tool.execute({ todos: "nope" })).toThrow(EngineError);
  });
});

// SPDX-License-Identifier: Apache-2.0

// Conformance: per-agent capabilities (SPEC §3 + §2.3; SDK AgentOptions).
//
// Capabilities are PER-AGENT — each agent() call brings its own tools/skills/memory, the
// manifest declares none of them. The contract: everything a call names must RESOLVE (fail
// the run loudly — UNSUPPORTED or VALIDATION — never silently degrade), program-defined tools
// round-trip through the loop, memory auto-persists across runs with no declaration anywhere,
// and deployed skill markdown loads into model context.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createEngine,
  disposeEngines,
  localInference,
  startFakeProvider,
  toolCallResponse,
  type FakeProvider,
} from "./harness.js";

let provider: FakeProvider;
beforeAll(async () => {
  provider = await startFakeProvider();
});
afterAll(async () => {
  await provider.close();
});
afterEach(disposeEngines);

describe("conformance: agent() capabilities", () => {
  it("runs a program-defined tool round-trip: tool events emitted, result fed back to the model", async () => {
    const { engine } = createEngine({ inference: localInference(provider) });
    provider.queueResponses(
      toolCallResponse([{ id: "c1", name: "lookup", argsJson: '{"key":"answer"}' }], {
        in: 5,
        out: 5,
      }),
    );
    provider.respondWith("the looked-up answer", { in: 6, out: 4 });
    engine.deployWorkflow({
      program: `
        import { agent, output } from "@boardwalk-labs/workflow";
        export const meta = { slug: "tool-user", triggers: [{ kind: "manual" }] };
        const table = { answer: "tool-answer-9b1c" };
        output(await agent("look it up", {
          model: "test-model",
          tools: [
            {
              name: "lookup",
              description: "Look up a value by key",
              inputSchema: { type: "object", properties: { key: { type: "string" } } },
              execute: async (input) => table[input.key] ?? "missing",
            },
          ],
        }));
      `,
    });

    const requestsBefore = provider.requests.length;
    const done = await engine.waitForRun(engine.startRun("tool-user").id);

    expect(done.status).toBe("completed");
    expect(done.output).toBe("the looked-up answer");
    const kinds = engine.store.listEvents(done.id).map((row) => row.event.kind);
    expect(kinds).toContain("tool_call_start");
    expect(kinds).toContain("tool_call_result");
    // The executed result went back into model context for the follow-up turn.
    expect(provider.requests.slice(requestsBefore).at(-1)).toContain("tool-answer-9b1c");
  }, 30_000);

  it("memory written by run 1 is in run 2's turn-start index — auto-persisted, no declarations", async () => {
    const { engine } = createEngine({ inference: localInference(provider) });
    engine.deployWorkflow({
      program: `
        import { agent, output } from "@boardwalk-labs/workflow";
        export const meta = { slug: "memory-keeper", triggers: [{ kind: "manual" }] };
        output(await agent("take notes", { model: "test-model", memory: "mem/notes" }));
      `,
    });

    // Run 1: the model writes a memory file through the scoped tool.
    provider.queueResponses(
      toolCallResponse([
        {
          id: "m1",
          name: "memory_write",
          argsJson: '{"path":"learned.md","content":"the sky is blue"}',
        },
      ]),
    );
    provider.respondWith("noted", { in: 1, out: 1 });
    const first = await engine.waitForRun(engine.startRun("memory-keeper").id);
    expect(first.status).toBe("completed");

    // Run 2: a FRESH run's first model call already carries the persisted memory index.
    provider.respondWith("I remember", { in: 1, out: 1 });
    const second = await engine.waitForRun(engine.startRun("memory-keeper").id);
    expect(second.status).toBe("completed");
    expect(provider.requests.at(-1)).toContain("learned.md");
  }, 30_000);

  it("skill markdown deployed via deployWorkflow's skills map loads into model context", async () => {
    const { engine } = createEngine({ inference: localInference(provider) });
    provider.respondWith("checked", { in: 1, out: 1 });
    engine.deployWorkflow({
      program: `
        import { agent, output } from "@boardwalk-labs/workflow";
        export const meta = { slug: "skilled", triggers: [{ kind: "manual" }] };
        output(await agent("inspect the boat", {
          model: "test-model",
          skills: ["review-checklist"],
        }));
      `,
      skills: { "review-checklist": "Always check the bilge pump first." },
    });

    const done = await engine.waitForRun(engine.startRun("skilled").id);
    expect(done.status).toBe("completed");
    expect(provider.requests.at(-1)).toContain("Always check the bilge pump first.");
  }, 30_000);

  it("a malformed memory path fails the run loudly", async () => {
    const { engine } = createEngine({ inference: localInference(provider) });
    engine.deployWorkflow({
      program: `
        import { agent } from "@boardwalk-labs/workflow";
        export const meta = { slug: "memory-escape", triggers: [{ kind: "manual" }] };
        await agent("hi", { model: "test-model", memory: "../outside" });
      `,
    });
    const done = await engine.waitForRun(engine.startRun("memory-escape").id);
    expect(done.status).toBe("failed");
    expect(["UNSUPPORTED", "VALIDATION"]).toContain(done.error?.code);
    expect(done.error?.message).toContain("memory");
  }, 30_000);

  it("an explicit unknown built-in name fails the run loudly", async () => {
    const { engine } = createEngine({ inference: localInference(provider) });
    engine.deployWorkflow({
      program: `
        import { agent } from "@boardwalk-labs/workflow";
        export const meta = { slug: "wants-builtin", triggers: [{ kind: "manual" }] };
        await agent("search", { model: "test-model", builtins: ["definitely_not_a_tool"] });
      `,
    });
    const done = await engine.waitForRun(engine.startRun("wants-builtin").id);
    expect(done.status).toBe("failed");
    expect(["UNSUPPORTED", "VALIDATION"]).toContain(done.error?.code);
    expect(done.error?.message).toContain("definitely_not_a_tool");
  }, 30_000);

  it("the default toolset is on: an agent with NO tools/builtins reads + runs in its workspace", async () => {
    const { engine } = createEngine({ inference: localInference(provider) });
    engine.deployWorkflow({
      program: `
        import { agent, output } from "@boardwalk-labs/workflow";
        import { writeFileSync } from "node:fs";
        export const meta = { slug: "default-tools", triggers: [{ kind: "manual" }] };
        // Plant a file in the workspace (the run's cwd) the model will read via the built-in tool.
        writeFileSync("note.txt", "workspace-content-7c2e");
        output(await agent("read note.txt and tell me what it says"));
      `,
    });
    // Turn 1: the model uses the default-on \`read\` built-in; turn 2: it answers.
    provider.queueResponses(
      toolCallResponse([{ id: "r1", name: "read", argsJson: '{"path":"note.txt"}' }]),
    );
    provider.respondWith("the note says workspace-content-7c2e", { in: 2, out: 2 });

    const requestsBefore = provider.requests.length;
    const done = await engine.waitForRun(engine.startRun("default-tools").id);
    expect(done.status).toBe("completed");
    expect(done.output).toBe("the note says workspace-content-7c2e");
    const kinds = engine.store.listEvents(done.id).map((row) => row.event.kind);
    expect(kinds).toContain("tool_call_result");
    // The read built-in's content reached model context on the follow-up turn.
    expect(provider.requests.slice(requestsBefore).at(-1)).toContain("workspace-content-7c2e");
  }, 30_000);

  it('builtins: "read-only" allows read but the model cannot call write (it is not advertised)', async () => {
    const { engine } = createEngine({ inference: localInference(provider) });
    engine.deployWorkflow({
      program: `
        import { agent, output } from "@boardwalk-labs/workflow";
        import { writeFileSync } from "node:fs";
        export const meta = { slug: "read-only-tools", triggers: [{ kind: "manual" }] };
        writeFileSync("data.txt", "read-only-payload-44a");
        output(await agent("read data.txt", { builtins: "read-only" }));
      `,
    });
    provider.queueResponses(
      toolCallResponse([{ id: "r1", name: "read", argsJson: '{"path":"data.txt"}' }]),
    );
    provider.respondWith("read it", { in: 1, out: 1 });

    const requestsBefore = provider.requests.length;
    const done = await engine.waitForRun(engine.startRun("read-only-tools").id);
    expect(done.status).toBe("completed");
    // The advertised tools (in the FIRST request of this run) include read but not write/bash.
    const firstRequest = provider.requests.slice(requestsBefore)[0] ?? "";
    expect(firstRequest).toContain('"read"');
    expect(firstRequest).not.toContain('"write"');
    expect(firstRequest).not.toContain('"bash"');
  }, 30_000);

  it("a skill that was never deployed fails the run loudly", async () => {
    const { engine } = createEngine({ inference: localInference(provider) });
    engine.deployWorkflow({
      program: `
        import { agent } from "@boardwalk-labs/workflow";
        export const meta = { slug: "wants-skill", triggers: [{ kind: "manual" }] };
        await agent("go", { model: "test-model", skills: ["nonexistent"] });
      `,
    });
    const done = await engine.waitForRun(engine.startRun("wants-skill").id);
    expect(done.status).toBe("failed");
    expect(["UNSUPPORTED", "VALIDATION"]).toContain(done.error?.code);
    expect(done.error?.message).toContain("nonexistent");
  }, 30_000);

  it("an MCP server that cannot resolve fails the run loudly (capability-presence rule)", async () => {
    const { engine } = createEngine({ inference: localInference(provider) });
    engine.deployWorkflow({
      program: `
        import { agent } from "@boardwalk-labs/workflow";
        export const meta = { slug: "wants-mcp", triggers: [{ kind: "manual" }] };
        await agent("search", {
          model: "test-model",
          // Nothing listens here — the named server must resolve, never silently degrade.
          mcp: [{ name: "gh", transport: "http", url: "http://127.0.0.1:9/mcp" }],
        });
      `,
    });
    const done = await engine.waitForRun(engine.startRun("wants-mcp").id);
    expect(done.status).toBe("failed");
    expect(done.error?.message).toContain("gh");
  }, 30_000);

  it("a malformed MCP server ref fails the run loudly before anything connects", async () => {
    const { engine } = createEngine({ inference: localInference(provider) });
    engine.deployWorkflow({
      program: `
        import { agent } from "@boardwalk-labs/workflow";
        export const meta = { slug: "bad-mcp", triggers: [{ kind: "manual" }] };
        await agent("search", {
          model: "test-model",
          mcp: [{ name: "gh", transport: "http", url: "not a url" }],
        });
      `,
    });
    const done = await engine.waitForRun(engine.startRun("bad-mcp").id);
    expect(done.status).toBe("failed");
    expect(["UNSUPPORTED", "VALIDATION"]).toContain(done.error?.code);
    expect(done.error?.message).toContain("MCP");
  }, 30_000);
});

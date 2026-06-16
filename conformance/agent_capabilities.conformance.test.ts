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

  it("auto-loads an AGENTS.md in the workspace into the agent's context — no option named", async () => {
    // The widely-adopted convention: a coding agent auto-discovers AGENTS.md in its working
    // directory and reads it into context. Default-on — the program names no capability for it.
    const { engine } = createEngine({ inference: localInference(provider) });
    provider.respondWith("read the rules", { in: 1, out: 1 });
    engine.deployWorkflow({
      program: `
        import { agent, output } from "@boardwalk-labs/workflow";
        import { writeFileSync } from "node:fs";
        export const meta = { slug: "agents-md-auto", triggers: [{ kind: "manual" }] };
        // Plant AGENTS.md in the workspace (the run's cwd); a plain agent() must pick it up.
        writeFileSync("AGENTS.md", "PROJECT-CONVENTION-83fa: prefer tabs over spaces.");
        output(await agent("do the task"));
      `,
    });

    const requestsBefore = provider.requests.length;
    const done = await engine.waitForRun(engine.startRun("agents-md-auto").id);
    expect(done.status).toBe("completed");
    // The project context reached the FIRST model request, tagged as a labeled AGENTS.md block.
    const firstRequest = provider.requests.slice(requestsBefore)[0] ?? "";
    expect(firstRequest).toContain("PROJECT-CONVENTION-83fa: prefer tabs over spaces.");
    // Tagged as the workspace tier (the request is JSON, so quotes are backslash-escaped on the wire).
    expect(firstRequest).toContain('AGENTS.md source=\\"workspace\\"');
  }, 30_000);

  it("auto-loads a BUNDLED AGENTS.md (shipped in the workflow package) into the agent's context", async () => {
    // The author ships standing instructions IN THE PACKAGE (alongside the program + skills/), via
    // deployWorkflow's `agentsMd`. Every agent() in the workflow reads it — independent of what the
    // run cloned into /workspace. This is the tier that must work on the hosted platform too, where
    // the package dir and the (empty) workspace are SEPARATE directories.
    const { engine } = createEngine({ inference: localInference(provider) });
    provider.respondWith("read the bundled rules", { in: 1, out: 1 });
    engine.deployWorkflow({
      program: `
        import { agent, output } from "@boardwalk-labs/workflow";
        export const meta = { slug: "bundled-agents-md", triggers: [{ kind: "manual" }] };
        // A plain agent() with an EMPTY workspace must still pick up the bundled AGENTS.md.
        output(await agent("do the task"));
      `,
      agentsMd: "BUNDLED-CONVENTION-1f7a: always run the linter before committing.",
    });

    const requestsBefore = provider.requests.length;
    const done = await engine.waitForRun(engine.startRun("bundled-agents-md").id);
    expect(done.status).toBe("completed");
    const firstRequest = provider.requests.slice(requestsBefore)[0] ?? "";
    expect(firstRequest).toContain(
      "BUNDLED-CONVENTION-1f7a: always run the linter before committing.",
    );
    // Tagged as the bundled (workflow) tier — distinct from a workspace AGENTS.md. (The request is
    // JSON, so the rendered quotes are backslash-escaped on the wire.)
    expect(firstRequest).toContain('AGENTS.md source=\\"workflow\\"');
  }, 30_000);

  it("loads BUNDLED and WORKSPACE AGENTS.md together — both tiers coexist in one context", async () => {
    // The parity case: a bundled AGENTS.md (in the package) AND a workspace AGENTS.md (cloned/written
    // by the run) must BOTH reach the agent, tagged by their tier, in one model request.
    const { engine } = createEngine({ inference: localInference(provider) });
    provider.respondWith("read both", { in: 1, out: 1 });
    engine.deployWorkflow({
      program: `
        import { agent, output } from "@boardwalk-labs/workflow";
        import { writeFileSync } from "node:fs";
        export const meta = { slug: "both-agents-md", triggers: [{ kind: "manual" }] };
        // The run writes a WORKSPACE AGENTS.md (e.g. simulating a freshly-cloned codebase).
        writeFileSync("AGENTS.md", "WORKSPACE-RULE-c4d2: this repo uses 4-space indent.");
        output(await agent("do the task"));
      `,
      agentsMd: "BUNDLED-RULE-9e0b: standing instruction for every run.",
    });

    const requestsBefore = provider.requests.length;
    const done = await engine.waitForRun(engine.startRun("both-agents-md").id);
    expect(done.status).toBe("completed");
    const firstRequest = provider.requests.slice(requestsBefore)[0] ?? "";
    // Both tiers present in the SAME request, each labeled by its source.
    expect(firstRequest).toContain("BUNDLED-RULE-9e0b: standing instruction for every run.");
    expect(firstRequest).toContain("WORKSPACE-RULE-c4d2: this repo uses 4-space indent.");
    // The request is JSON, so the rendered quotes are backslash-escaped on the wire.
    expect(firstRequest).toContain('AGENTS.md source=\\"workflow\\"');
    expect(firstRequest).toContain('AGENTS.md source=\\"workspace\\"');
    // General → specific: the bundled tier precedes the workspace tier in the rendered context.
    expect(firstRequest.indexOf("BUNDLED-RULE-9e0b")).toBeLessThan(
      firstRequest.indexOf("WORKSPACE-RULE-c4d2"),
    );
  }, 30_000);

  it("a run with NO AGENTS.md is unaffected (the convention adds nothing)", async () => {
    const { engine } = createEngine({ inference: localInference(provider) });
    provider.respondWith("ok", { in: 1, out: 1 });
    engine.deployWorkflow({
      program: `
        import { agent, output } from "@boardwalk-labs/workflow";
        export const meta = { slug: "no-agents-md", triggers: [{ kind: "manual" }] };
        output(await agent("do the task"));
      `,
    });

    const requestsBefore = provider.requests.length;
    const done = await engine.waitForRun(engine.startRun("no-agents-md").id);
    expect(done.status).toBe("completed");
    expect(provider.requests.slice(requestsBefore)[0] ?? "").not.toContain("AGENTS.md");
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

  it("write-then-edit of a TS file works WITHOUT a language server (LSP diagnostics are best-effort)", async () => {
    // LSP diagnostics are engine-native + BEST-EFFORT: with no `typescript-language-server` on PATH
    // (CI has none), the write/edit built-ins must behave exactly as they always have — the run
    // completes, the file lands on disk, the tool result is the plain write summary. This keeps the
    // parity promise intact: behavior never depends on a real language server being installed.
    const { engine } = createEngine({ inference: localInference(provider) });
    engine.deployWorkflow({
      program: `
        import { agent, output } from "@boardwalk-labs/workflow";
        import { readFileSync } from "node:fs";
        export const meta = { slug: "lsp-best-effort", triggers: [{ kind: "manual" }] };
        // The model writes a .ts file via the default-on \`write\` built-in, then the program
        // confirms the file is on disk (the write must not fail or hang on absent diagnostics).
        await agent("create the module");
        output(readFileSync("mod.ts", "utf8"));
      `,
    });
    provider.queueResponses(
      toolCallResponse([
        {
          id: "w1",
          name: "write",
          argsJson: JSON.stringify({ path: "mod.ts", content: "export const answer = 42;\n" }),
        },
      ]),
    );
    provider.respondWith("done", { in: 1, out: 1 });

    const done = await engine.waitForRun(engine.startRun("lsp-best-effort").id);
    expect(done.status).toBe("completed");
    expect(done.output).toBe("export const answer = 42;\n");
    const kinds = engine.store.listEvents(done.id).map((row) => row.event.kind);
    expect(kinds).toContain("tool_call_result");
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

// SPDX-License-Identifier: Apache-2.0

// Unit tests for the engine's program↔host protocol server, exercised through the PUBLISHED
// SDK client (`HostClient`) over a real socket — the exact wire a workflow program speaks.

import { afterEach, describe, expect, it } from "vitest";
import { HostClient, HostError } from "@boardwalk-labs/workflow/runtime";
import type { ContextData } from "@boardwalk-labs/workflow/runtime";
import type { AgentOptions } from "@boardwalk-labs/workflow";
import { EngineError } from "../errors.js";
import { WorkflowHostServer, protocolErrorOf, type HostCapabilities } from "./host_server.js";

const CONTEXT: ContextData = {
  runId: "01HZZZZZZZZZZZZZZZZZZZZZZZ",
  workflowId: "01HYYYYYYYYYYYYYYYYYYYYYYY",
  workflowVersion: 3,
  orgId: "local",
  environment: null,
  actor: { type: "user", user_id: "local" },
  attempt: 1,
  trigger: { kind: "manual", firedAt: 1_750_000_000_000 },
  workspaceDir: "/tmp/workspace",
};

function unsupported(what: string): never {
  throw new EngineError("UNSUPPORTED", `${what} is not available in this test`);
}

/** Every member fails loudly unless the test overrides it. */
function makeCapabilities(overrides: Partial<HostCapabilities>): HostCapabilities {
  return {
    agent: () => unsupported("agent"),
    callWorkflow: () => unsupported("workflows.call"),
    runWorkflow: () => unsupported("workflows.run"),
    scheduleWorkflow: () => unsupported("workflows.schedule"),
    sleep: () => unsupported("sleep"),
    humanInput: () => unsupported("humanInput"),
    getSecret: () => unsupported("secrets.get"),
    writeArtifact: () => unsupported("artifacts.write"),
    shell: () => unsupported("shell"),
    phase: () => unsupported("phase"),
    idToken: () => unsupported("auth.idToken"),
    apiToken: () => unsupported("auth.apiToken"),
    usage: () => unsupported("usage.get"),
    ...overrides,
  };
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

async function harness(
  overrides: Partial<HostCapabilities>,
): Promise<{ server: WorkflowHostServer; client: HostClient }> {
  const server = new WorkflowHostServer({
    capabilities: makeCapabilities(overrides),
    bootstrap: { input: { n: 7 }, context: CONTEXT },
  });
  const sockPath = await server.listen();
  const client = await HostClient.connect(sockPath);
  cleanups.push(async () => {
    client.close();
    await server.close();
  });
  return { server, client };
}

describe("WorkflowHostServer", () => {
  it("bootstrap serves the raw input (no schema — untyped floor) and the frozen context", async () => {
    const { client } = await harness({});
    const { input, context } = await client.bootstrap();
    expect(input).toEqual({ n: 7 });
    expect(context.runId).toBe(CONTEXT.runId);
    expect(context.workflowVersion).toBe(3);
    expect(context.signal).toBeInstanceOf(AbortSignal);
    expect(Object.isFrozen(context)).toBe(true);
  });

  it("report_return captures the value verbatim; reportedReturn() reads it back", async () => {
    const { server, client } = await harness({});
    await client.reportReturn({ verdict: "ok", items: [1, 2] });
    expect(server.reportedReturn()).toEqual({ verdict: "ok", items: [1, 2] });
  });

  it("a void return reports null", async () => {
    const { server, client } = await harness({});
    await client.reportReturn(undefined);
    expect(server.reportedReturn()).toBeNull();
  });

  it("dispatches capability calls and returns their results (secrets.get)", async () => {
    const { client } = await harness({
      getSecret: (name) => Promise.resolve(`value-of-${name}`),
    });
    expect(await client.getSecret("GH_TOKEN")).toBe("value-of-GH_TOKEN");
  });

  it("an EngineError's code AND hint survive the wire (hint rides data.hint)", async () => {
    const { client } = await harness({
      getSecret: () =>
        Promise.reject(
          new EngineError("SECRET_MISSING", "no such secret", "Set it in the engine .env."),
        ),
    });
    const err = await client.getSecret("ABSENT").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostError);
    if (err instanceof HostError) {
      expect(err.code).toBe("SECRET_MISSING");
      expect(err.message).toBe("no such secret");
      expect((err.data as { hint?: string }).hint).toBe("Set it in the engine .env.");
    }
  });

  it("agent(): wire tool declarations become executable ToolDefs that round-trip tool_invoke", async () => {
    let seenOpts: AgentOptions | undefined;
    const { client } = await harness({
      agent: async (_prompt, opts) => {
        seenOpts = opts;
        // The engine leaf would call the tool mid-loop; simulate exactly that.
        const tool = opts?.tools?.[0];
        if (tool === undefined) throw new Error("no tool crossed the seam");
        const result = await tool.execute({ key: "answer" });
        return `tool said: ${String(result)}`;
      },
    });
    const table: Record<string, string> = { answer: "42" };
    const output = await client.agent("look it up", {
      model: "test-model",
      tools: [
        {
          name: "lookup",
          description: "Look up a value",
          inputSchema: { type: "object" },
          execute: (input) => Promise.resolve(table[(input as { key: string }).key] ?? "missing"),
        },
      ],
    });
    expect(output).toBe("tool said: 42");
    // The handler stayed program-side: the seam received a declaration-backed ToolDef.
    expect(seenOpts?.tools?.[0]?.name).toBe("lookup");
  });

  it("a tool handler throw surfaces as an ordinary execute() rejection — never run-fatal", async () => {
    const { client } = await harness({
      agent: async (_prompt, opts) => {
        const tool = opts?.tools?.[0];
        if (tool === undefined) throw new Error("no tool");
        // The leaf treats a tool error as a tool-result for the model; here we just prove the
        // rejection arrives as a plain Error the loop can feed back.
        const err = await tool.execute({}).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(Error);
        return `handled: ${(err as Error).message}`;
      },
    });
    const output = await client.agent("go", {
      tools: [
        {
          name: "flaky",
          description: "always throws",
          inputSchema: { type: "object" },
          execute: () => Promise.reject(new Error("handler exploded")),
        },
      ],
    });
    expect(output).toBe("handled: handler exploded");
  });

  it("phase is a fire-and-forget notification dispatched to the capability", async () => {
    const phases: string[] = [];
    const { client } = await harness({
      phase: (name) => {
        phases.push(name);
      },
    });
    client.phase("analyze", undefined);
    // Notification: give the loopback a beat to deliver.
    await new Promise((r) => setTimeout(r, 50));
    expect(phases).toEqual(["analyze"]);
  });

  it("artifacts.write decodes both utf8 and base64 wire bodies", async () => {
    const bodies: (string | Uint8Array)[] = [];
    const { client } = await harness({
      writeArtifact: (name, _contentType, body) => {
        bodies.push(body);
        return Promise.resolve({ id: "a1", name, url: "file:///tmp/a1" });
      },
    });
    await client.writeArtifact("report.txt", "text/plain", "plain text", undefined);
    await client.writeArtifact("data.bin", "application/octet-stream", new Uint8Array([1, 2, 3]), {
      note: "raw",
    });
    expect(bodies[0]).toBe("plain text");
    expect(bodies[1]).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("computer.openBrowser fails CLOSED with UNSUPPORTED naming the gap", async () => {
    const { client } = await harness({});
    const err = await client.openBrowser(undefined).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostError);
    if (err instanceof HostError) {
      expect(err.code).toBe("UNSUPPORTED");
      expect(err.message).toContain("no browser backend");
    }
  });

  it("notifyCancel aborts the client's context.signal — even for a late connector", async () => {
    const { server, client } = await harness({});
    const { context } = await client.bootstrap();
    expect(context.signal.aborted).toBe(false);
    server.notifyCancel("test cancel");
    await new Promise((r) => setTimeout(r, 50));
    expect(context.signal.aborted).toBe(true);
  });

  it("malformed params are rejected with INVALID_PARAMS before the capability runs", async () => {
    let capabilityRan = false;
    const { client } = await harness({
      getSecret: () => {
        capabilityRan = true;
        return Promise.resolve("never");
      },
    });
    // An empty name violates the wire schema (`name: min(1)`).
    const bad = await client.getSecret("").catch((e: unknown) => e);
    expect(bad).toBeInstanceOf(HostError);
    if (bad instanceof HostError) expect(bad.code).toBe("INVALID_PARAMS");
    expect(capabilityRan).toBe(false);
  });
});

describe("protocolErrorOf", () => {
  it("uses a SCREAMING_SNAKE code when the error carries one, else the class name", () => {
    expect(protocolErrorOf(new EngineError("CANCELLED", "stop")).code).toBe("CANCELLED");
    expect(protocolErrorOf(new RangeError("nope")).code).toBe("RangeError");
    expect(protocolErrorOf("just a string").code).toBe("INTERNAL");
  });

  it("carries a hint on data.hint only when present", () => {
    const withHint = protocolErrorOf(new EngineError("VALIDATION", "bad", "fix it"));
    expect(withHint.data).toEqual({ hint: "fix it" });
    const withoutHint = protocolErrorOf(new EngineError("VALIDATION", "bad"));
    expect(withoutHint.data).toBeUndefined();
  });
});

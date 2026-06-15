// SPDX-License-Identifier: Apache-2.0

// Conformance: agent() MCP client (SPEC §2.3; SDK AgentOptions.mcp).
//
// The contract: an inline http McpServerRef connects, its tools join the loop under
// `<server>__<tool>` names, results round-trip into model context — and the redaction
// invariant holds across the MCP boundary: a secrets.get value returned through an MCP tool
// result never reaches the model or the persisted event stream (SPEC §3 names MCP traffic as
// a redaction canary path). Public engine surface only.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createEngine,
  disposeEngines,
  localInference,
  startFakeMcpServer,
  startFakeProvider,
  toolCallResponse,
  type FakeMcpServer,
  type FakeProvider,
} from "./harness.js";

let provider: FakeProvider;
beforeAll(async () => {
  provider = await startFakeProvider();
});
afterAll(async () => {
  await provider.close();
});

const mcpServers: FakeMcpServer[] = [];
afterEach(async () => {
  disposeEngines();
  for (const server of mcpServers.splice(0)) await server.close();
});

async function mcpWithTool(
  handler: (args: Record<string, unknown>) => { text: string },
): Promise<FakeMcpServer> {
  const server = await startFakeMcpServer({
    tools: [{ name: "lookup", description: "Looks up a value", handler }],
  });
  mcpServers.push(server);
  return server;
}

function deployMcpUser(engine: ReturnType<typeof createEngine>["engine"], url: string): void {
  engine.deployWorkflow({
    program: `
      import { agent, output, secrets } from "@boardwalk-labs/workflow";
      export const meta = {
        slug: "mcp-user",
        triggers: [{ kind: "manual" }],
        permissions: { secrets: [{ name: "CANARY_TOKEN" }] },
      };
      // Reading the secret teaches the run's redactor its value — the canary path.
      await secrets.get("CANARY_TOKEN");
      output(await agent("look it up", {
        model: "test-model",
        mcp: [{ name: "kb", transport: "http", url: ${JSON.stringify(url)} }],
      }));
    `,
  });
}

describe("conformance: agent() MCP client", () => {
  it("an inline http MCP server's tool round-trips through the loop under its namespaced name", async () => {
    const mcp = await mcpWithTool((args) => ({ text: `kb says: ${String(args["key"])}-found` }));
    const { engine } = createEngine({
      env: { CANARY_TOKEN: "canary-not-used-here-1111" },
      inference: localInference(provider),
    });
    deployMcpUser(engine, mcp.url);
    provider.queueResponses(
      toolCallResponse([{ id: "c1", name: "kb__lookup", argsJson: '{"key":"answer"}' }]),
    );
    provider.respondWith("the kb answer", { in: 2, out: 2 });

    const requestsBefore = provider.requests.length;
    const done = await engine.waitForRun(engine.startRun("mcp-user").id);

    expect(done.status).toBe("completed");
    expect(done.output).toBe("the kb answer");
    // The namespaced tool was advertised and its result re-entered model context.
    expect(provider.requests[requestsBefore]).toContain("kb__lookup");
    expect(provider.requests.slice(requestsBefore).at(-1)).toContain("kb says: answer-found");
    // The MCP server really served the call (initialize → tools/list → tools/call).
    expect(mcp.requests.map((r) => r.rpcMethod)).toContain("tools/call");
    const kinds = engine.store.listEvents(done.id).map((row) => row.event.kind);
    expect(kinds).toContain("tool_call_start");
    expect(kinds).toContain("tool_call_result");
  }, 30_000);

  it("REDACTION CANARY: a secret flowing back through an MCP tool result never reaches the model or the event stream", async () => {
    const canary = "canary-secret-value-9d4e12";
    // The MCP server is an EXTERNAL system that happens to return the credential — exactly
    // the shape of a tool that echoes config or fetches a connection string.
    const mcp = await mcpWithTool(() => ({ text: `the credential is ${canary}` }));
    const { engine } = createEngine({
      env: { CANARY_TOKEN: canary },
      inference: localInference(provider),
    });
    deployMcpUser(engine, mcp.url);
    provider.queueResponses(toolCallResponse([{ id: "c1", name: "kb__lookup", argsJson: "{}" }]));
    provider.respondWith("done", { in: 1, out: 1 });

    const requestsBefore = provider.requests.length;
    const done = await engine.waitForRun(engine.startRun("mcp-user").id);
    expect(done.status).toBe("completed");

    const requests = provider.requests.slice(requestsBefore);
    expect(requests.length).toBeGreaterThanOrEqual(2);
    for (const request of requests) {
      expect(request).not.toContain(canary);
    }
    // Substitution, not deletion: the post-tool turn carries the labeled placeholder.
    expect(requests.at(-1)).toContain("[redacted:CANARY_TOKEN]");
    // And the persisted record never carries the value either.
    expect(JSON.stringify(engine.store.listEvents(done.id))).not.toContain(canary);
  }, 30_000);
});

// SPDX-License-Identifier: Apache-2.0

// Conformance: the SECRET REDACTION CANARY (SPEC §3).
//
// The invariant that makes the trust model work: a secrets.get value may live in program
// code, but it must NEVER reach a model or the persisted record. This case routes a canary
// value through BOTH model-bound paths — embedded in an agent() prompt AND returned through a
// program-defined tool result — and asserts it appears in no provider request and nowhere in
// the run's event stream.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createEngine,
  disposeEngines,
  localInference,
  startFakeProvider,
  toolCallResponse,
  type FakeProvider,
  descriptor,
} from "./harness.js";

let provider: FakeProvider;
beforeAll(async () => {
  provider = await startFakeProvider();
});
afterAll(async () => {
  await provider.close();
});
afterEach(disposeEngines);

describe("conformance: secret redaction canary", () => {
  it("a secrets.get value in the prompt AND in a tool result never reaches the provider or the event stream", async () => {
    const canary = "canary-secret-value-3f9d27";
    const { engine } = createEngine({
      env: { CANARY_TOKEN: canary },
      inference: localInference(provider),
    });
    // Model turn 1: call the tool (whose result carries the secret). Turn 2: finish.
    provider.queueResponses(
      toolCallResponse([{ id: "c1", name: "fetch_credential", argsJson: "{}" }]),
    );
    provider.respondWith("done", { in: 1, out: 1 });

    engine.deployWorkflow({
      descriptor: descriptor({
        slug: "leaky",
        triggers: [{ kind: "manual" }],
        permissions: { secrets: [{ name: "CANARY_TOKEN" }] },
      }),
      program: `
        import { agent, secrets } from "@boardwalk-labs/workflow";
        export default async function run(input, context) {
          const token = await secrets.get("CANARY_TOKEN");
          return (await agent("use the token " + token + " to fetch the data", {
            model: "test-model",
            tools: [
              {
                name: "fetch_credential",
                description: "Returns the credential",
                inputSchema: { type: "object", properties: {} },
                execute: async () => "the credential is " + token,
              },
            ],
          }));
        }
      `,
    });

    const requestsBefore = provider.requests.length;
    const done = await engine.waitForRun(engine.startRun("leaky").id);
    expect(done.status).toBe("completed");

    // Both model calls happened (prompt turn + post-tool turn) — the canary reached neither.
    const requests = provider.requests.slice(requestsBefore);
    expect(requests.length).toBeGreaterThanOrEqual(2);
    for (const request of requests) {
      expect(request).not.toContain(canary);
    }
    // The redaction is a substitution, not a deletion: the model sees a labeled placeholder
    // on both paths (prompt in the first request, tool result fed back in the second).
    expect(requests[0]).toContain("[redacted:CANARY_TOKEN]");
    expect(requests[1]).toContain("[redacted:CANARY_TOKEN]");

    // And the persisted record never carries the value either — anywhere, in any field.
    expect(JSON.stringify(engine.store.listEvents(done.id))).not.toContain(canary);
  }, 30_000);
});

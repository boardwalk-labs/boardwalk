// SPDX-License-Identifier: Apache-2.0

// Conformance: tool-level human-in-the-loop (the in-leaf `human_input` tool).
//
// A leaf opted into `humanInput` gets a `human_input` tool. When the model calls it, the leaf
// parks mid-loop and the run HOLDS its process in `awaiting_input` — the transcript stays in
// memory. A person answers; the tool returns the answer (keyed by tool-call id) and the loop
// continues from where it paused. The model is NOT re-run from the top.

import { afterEach, describe, expect, it } from "vitest";
import {
  createEngine,
  descriptor,
  disposeEngines,
  localInference,
  startFakeProvider,
  toolCallResponse,
  waitForStatus,
} from "./harness.js";

afterEach(disposeEngines);

const ASK = {
  descriptor: descriptor({ slug: "ask", triggers: [{ kind: "manual" }] }),
  program: `
  import { agent } from "@boardwalk-labs/workflow";
  export default async function run() {
    return await agent("Decide whether to ship.", { model: "test-model", humanInput: true });
  }
`,
};

describe("conformance: tool-level human_input", () => {
  it("the model's human_input tool holds the leaf mid-loop and continues with the answer", async () => {
    const provider = await startFakeProvider();
    // Turn 1: the model calls human_input. After the human answers and the run resumes, turn 2
    // (the steady reply) returns the final text — proving the loop continued past the gate.
    provider.queueResponses(
      toolCallResponse([
        {
          id: "call_1",
          name: "human_input",
          argsJson: JSON.stringify({
            prompt: "Ship it?",
            input: { kind: "choice", options: ["yes", "no"] },
          }),
        },
      ]),
    );
    provider.respondWith("shipped", { in: 1, out: 1 });
    try {
      const { engine } = createEngine({ inference: localInference(provider) });
      engine.deployWorkflow(ASK);

      const run = engine.startRun("ask");
      await waitForStatus(engine, run.id, "awaiting_input");

      // The model's question surfaced as a pending gate, keyed by the tool-call id.
      const pending = engine.listInputRequests({ runId: run.id, statuses: ["pending"] });
      expect(pending).toHaveLength(1);
      expect(pending[0]?.key).toBe("call_1");
      expect(pending[0]?.prompt).toBe("Ship it?");
      // Exactly one model call so far — the leaf is held at the tool call, it did not loop.
      expect(provider.requests).toHaveLength(1);

      // Answer it; the held leaf continues in place and the second model turn finishes it.
      engine.respondToInput(run.id, "call_1", { value: "yes", isOther: false });
      await waitForStatus(engine, run.id, "completed");

      expect(engine.store.getRun(run.id)?.output).toBe("shipped");
      // Two model calls total: the held turn + the continuation after the answer.
      expect(provider.requests).toHaveLength(2);
      const kinds = engine.store.listEvents(run.id).map((row) => row.event.kind);
      expect(kinds).toContain("human_input_requested");
      expect(kinds).toContain("human_input_resolved");
    } finally {
      await provider.close();
    }
  }, 30_000);

  it("validates the model's gate spec and rejects an out-of-options answer", async () => {
    const provider = await startFakeProvider();
    provider.queueResponses(
      toolCallResponse([
        {
          id: "call_x",
          name: "human_input",
          argsJson: JSON.stringify({
            prompt: "Pick",
            input: { kind: "choice", options: ["a", "b"] },
          }),
        },
      ]),
    );
    provider.respondWith("done", { in: 1, out: 1 });
    try {
      const { engine } = createEngine({ inference: localInference(provider) });
      engine.deployWorkflow(ASK);
      const run = engine.startRun("ask");
      await waitForStatus(engine, run.id, "awaiting_input");

      expect(() => engine.respondToInput(run.id, "call_x", { value: "c", isOther: false })).toThrow(
        /not one of the offered options/,
      );
      expect(engine.store.getRun(run.id)?.status).toBe("awaiting_input");

      engine.respondToInput(run.id, "call_x", { value: "a", isOther: false });
      await waitForStatus(engine, run.id, "completed");
      expect(engine.store.getRun(run.id)?.output).toBe("done");
    } finally {
      await provider.close();
    }
  }, 30_000);
});

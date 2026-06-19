// SPDX-License-Identifier: Apache-2.0

// Conformance: tool-level human-in-the-loop (the in-leaf `human_input` tool).
//
// A leaf opted into `humanInput` gets a `human_input` tool. When the model calls it, the leaf
// CHECKPOINTS its transcript and the run SUSPENDS — mid-loop, not at a clean program await. A
// person answers; the run resumes, the leaf is reconstructed from the checkpoint, the tool returns
// the answer (keyed by tool-call id), and the loop continues from where it paused. The model is
// NOT re-run from the top.

import { afterEach, describe, expect, it } from "vitest";
import {
  createEngine,
  disposeEngines,
  localInference,
  startFakeProvider,
  toolCallResponse,
  waitForStatus,
} from "./harness.js";

afterEach(disposeEngines);

const ASK_PROGRAM = `
  import { agent, output } from "@boardwalk-labs/workflow";
  export const meta = { slug: "ask", triggers: [{ kind: "manual" }] };
  const decision = await agent("Decide whether to ship.", { model: "test-model", humanInput: true });
  output(decision);
`;

describe("conformance: tool-level human_input", () => {
  it("the model's human_input tool checkpoints the leaf, suspends, and resumes with the answer", async () => {
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
      engine.deployWorkflow({ program: ASK_PROGRAM });

      const run = engine.startRun("ask");
      await waitForStatus(engine, run.id, "awaiting_input");

      // The model's question surfaced as a pending gate, keyed by the tool-call id.
      const pending = engine.listInputRequests({ runId: run.id, statuses: ["pending"] });
      expect(pending).toHaveLength(1);
      expect(pending[0]?.key).toBe("call_1");
      expect(pending[0]?.prompt).toBe("Ship it?");
      // Exactly one model call so far — the leaf parked at the tool call, it did not loop.
      expect(provider.requests).toHaveLength(1);

      // Answer it; the run resumes, the leaf continues, and the second model turn finishes it.
      engine.respondToInput(run.id, "call_1", { value: "yes", isOther: false });
      await waitForStatus(engine, run.id, "completed");

      expect(engine.store.getRun(run.id)?.output).toBe("shipped");
      // Two model calls total: the parked turn (pre-suspend) + the continuation (post-resume).
      expect(provider.requests).toHaveLength(2);
      const kinds = engine.store.listEvents(run.id).map((row) => row.event.kind);
      expect(kinds).toContain("suspended");
      expect(kinds).toContain("human_input_requested");
      expect(kinds).toContain("resumed");
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
      engine.deployWorkflow({ program: ASK_PROGRAM });
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

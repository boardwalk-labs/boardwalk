// Conformance: the run-event wire format (SPEC §3).
//
// One rich run (phases, stdout/stderr, an agent turn with a tool call, an output) exercises
// most of the wire format, then the contract is asserted with the SDK's own vocabulary:
// cursor resume returns exactly the suffix, every emitted kind maps to exactly one channel
// per the SDK map (so channel filtering partitions the stream), program stdout/stderr land on
// the log channel, and agent frames carry their own turnId distinct from the run's.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { CHANNELS, channelOf, matchesChannels, type Channel } from "@boardwalk-labs/workflow";
import type { Engine, EventRow } from "../src/index.js";
import {
  createEngine,
  disposeEngines,
  expectMonotonicCursors,
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

// The SDK's kind→channel map, restated independently: a drifting engine fails here even if
// it drifts in lockstep with a drifting helper.
const EXPECTED_CHANNEL: Record<string, Channel> = {
  run_status: "lifecycle",
  phase: "phase",
  output: "output",
  program_output: "log",
  turn_started: "agent",
  turn_ended: "agent",
  text_start: "agent",
  text_delta: "agent",
  text_end: "agent",
  tool_call_start: "agent",
  tool_call_input_delta: "agent",
  tool_call_input_complete: "agent",
  tool_call_executing: "agent",
  tool_call_result: "agent",
  tool_call_error: "agent",
  reasoning_delta: "agent",
};

/** One run whose stream spans all five channels. */
async function runRichWorkflow(engine: Engine): Promise<{ runId: string; events: EventRow[] }> {
  provider.queueResponses(toolCallResponse([{ id: "p1", name: "probe", argsJson: "{}" }]));
  provider.respondWith("final answer", { in: 2, out: 2 });
  engine.deployWorkflow({
    program: `
      import { Phase, agent, output } from "@boardwalk-labs/workflow";
      export const meta = { name: "rich", triggers: [{ kind: "manual" }] };
      Phase("gather");
      console.log("stdout line");
      console.error("stderr line");
      const reply = await agent("do the thing", {
        model: "test-model",
        tools: [
          {
            name: "probe",
            description: "Probe something",
            inputSchema: { type: "object", properties: {} },
            execute: async () => "probe-result",
          },
        ],
      });
      Phase("publish");
      output({ reply });
    `,
  });
  const done = await engine.waitForRun(engine.startRun("rich").id);
  expect(done.status).toBe("completed");
  return { runId: done.id, events: engine.store.listEvents(done.id) };
}

describe("conformance: event stream contract", () => {
  it("cursor resume: listEvents afterCursor returns exactly the suffix", async () => {
    const { engine } = createEngine({ inference: localInference(provider) });
    const { runId, events } = await runRichWorkflow(engine);

    expectMonotonicCursors(events);
    expect(engine.store.listEvents(runId, { afterCursor: 0 })).toEqual(events);
    for (const [i, row] of events.entries()) {
      expect(engine.store.listEvents(runId, { afterCursor: row.cursor })).toEqual(
        events.slice(i + 1),
      );
    }
  }, 30_000);

  it("every emitted kind maps to exactly one channel; channel filters partition the stream", async () => {
    const { engine } = createEngine({ inference: localInference(provider) });
    const { events } = await runRichWorkflow(engine);

    // The run exercises every channel — otherwise the partition assertion proves too little.
    const seenChannels = new Set(events.map((row) => channelOf(row.event)));
    expect([...seenChannels].sort()).toEqual([...CHANNELS].sort());

    for (const row of events) {
      expect(channelOf(row.event)).toBe(EXPECTED_CHANNEL[row.event.kind]);
      // Exactly one channel matches each event — the channels partition the stream.
      const matching = CHANNELS.filter((channel) => matchesChannels(row.event, [channel]));
      expect(matching).toEqual([channelOf(row.event)]);
    }
    const filteredTotal = CHANNELS.reduce(
      (n, channel) => n + events.filter((row) => matchesChannels(row.event, [channel])).length,
      0,
    );
    expect(filteredTotal).toBe(events.length);
  }, 30_000);

  it("program stdout and stderr land on the log channel", async () => {
    const { engine } = createEngine({ inference: localInference(provider) });
    const { events } = await runRichWorkflow(engine);

    const logs = events.map((row) => row.event).filter((event) => event.kind === "program_output");
    expect(logs.some((e) => e.stream === "stdout" && e.text.includes("stdout line"))).toBe(true);
    expect(logs.some((e) => e.stream === "stderr" && e.text.includes("stderr line"))).toBe(true);
    for (const event of logs) expect(channelOf(event)).toBe("log");
  }, 30_000);

  it("agent frames carry one shared turnId distinct from the runId; run-level frames reuse the runId", async () => {
    const { engine } = createEngine({ inference: localInference(provider) });
    const { runId, events } = await runRichWorkflow(engine);

    const agentFrames = events.filter((row) => channelOf(row.event) === "agent");
    expect(agentFrames.length).toBeGreaterThan(0);
    const turnIds = new Set(agentFrames.map((row) => row.event.turnId));
    expect(turnIds.size).toBe(1); // one agent() call → one turn
    expect(turnIds.has(runId)).toBe(false);

    for (const row of events) {
      if (channelOf(row.event) !== "agent") expect(row.event.turnId).toBe(runId);
      expect(row.event.runId).toBe(runId);
    }

    // The turn frames name the leaf: a stable, run-unique agentId shared by turn_started/turn_ended.
    const turnFrames = events
      .map((row) => row.event)
      .filter((event) => event.kind === "turn_started" || event.kind === "turn_ended");
    expect(turnFrames.length).toBeGreaterThanOrEqual(2);
    const agentIds = new Set(turnFrames.map((event) => ("agentId" in event ? event.agentId : "")));
    expect(agentIds.size).toBe(1);
    expect([...agentIds][0]).toBeTruthy();
  }, 30_000);
});

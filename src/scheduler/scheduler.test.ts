import { describe, expect, it } from "vitest";
import { workflowManifestSchema, type WorkflowManifest } from "@boardwalk-labs/workflow";
import type { Clock } from "../clock.js";
import { Store } from "../store/store.js";
import { Scheduler } from "./scheduler.js";

/** A controllable clock — scheduler tests drive tick() directly and never sleep. */
function fakeClock(startMs: number): Clock & { advance: (ms: number) => void } {
  let t = startMs;
  return {
    now: () => t,
    sleep: () => Promise.resolve(),
    advance: (ms: number) => {
      t += ms;
    },
  };
}

// A fixed, DST-free reference point: 2026-06-15T12:00:00Z (a Monday).
const T0 = Date.parse("2026-06-15T12:00:00Z");
const MINUTE = 60_000;

interface Fixture {
  store: Store;
  clock: ReturnType<typeof fakeClock>;
  scheduler: Scheduler;
  dispatched: string[];
  queuedEvents: string[];
  notices: string[];
  deploy: (
    name: string,
    meta?: Partial<WorkflowManifest>,
    config?: Record<string, string>,
  ) => string;
}

function fixture(startMs = T0): Fixture {
  const store = new Store(":memory:");
  const clock = fakeClock(startMs);
  const dispatched: string[] = [];
  const queuedEvents: string[] = [];
  const notices: string[] = [];
  const scheduler = new Scheduler({
    store,
    clock,
    dispatch: (id) => dispatched.push(id),
    emitQueued: (id) => queuedEvents.push(id),
    log: (line) => notices.push(line),
  });
  const deploy = (
    name: string,
    meta?: Partial<WorkflowManifest>,
    config?: Record<string, string>,
  ): string => {
    const manifest = workflowManifestSchema.parse({
      name,
      triggers: [{ kind: "cron", expr: "* * * * *" }],
      ...meta,
    });
    return store.upsertWorkflow({
      name,
      manifest,
      program: "export default async () => {};",
      ...(config !== undefined ? { config } : {}),
    }).id;
  };
  return { store, clock, scheduler, dispatched, queuedEvents, notices, deploy };
}

describe("Scheduler firing", () => {
  it("does not fire retroactively for a never-fired trigger; fires once when due", () => {
    const f = fixture();
    const workflowId = f.deploy("every-minute");

    f.scheduler.tick();
    expect(f.store.listRuns()).toHaveLength(0); // first sight anchors at now

    f.clock.advance(MINUTE);
    f.scheduler.tick();
    const runs = f.store.listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.workflowId).toBe(workflowId);
    expect(runs[0]?.triggerKind).toBe("cron");
    expect(f.queuedEvents).toEqual([runs[0]?.id]);
  });

  it("a due fire happens exactly once across repeated ticks", () => {
    const f = fixture();
    f.deploy("every-minute");
    f.scheduler.tick(); // first sight anchors at now
    f.clock.advance(MINUTE);
    f.scheduler.tick();
    f.scheduler.tick();
    f.scheduler.tick();
    expect(f.store.listRuns()).toHaveLength(1);
  });

  it("fires each elapsed due time when the engine kept running (slow tick, not a restart)", () => {
    const f = fixture();
    f.deploy("every-minute");
    f.scheduler.tick(); // anchor
    f.clock.advance(3 * MINUTE);
    f.scheduler.tick();
    expect(f.store.listRuns()).toHaveLength(3); // delayed, not missed — all were due
  });

  it("records the fire transactionally with the run", () => {
    const f = fixture();
    const workflowId = f.deploy("every-minute");
    f.scheduler.tick();
    f.clock.advance(MINUTE);
    f.scheduler.tick();
    const lastFire = f.store.lastCronFire(workflowId, 0);
    expect(lastFire).toBe(T0 + MINUTE);
  });
});

describe("Scheduler catch-up on restart", () => {
  function restartAfterGap(catchUp?: "once"): Fixture {
    // Session 1: fire once at T0+1min, then the engine "dies".
    const first = fixture();
    const config = catchUp === "once" ? { catch_up: "once" } : undefined;
    first.deploy("every-minute", undefined, config);
    first.scheduler.tick();
    first.clock.advance(MINUTE);
    first.scheduler.tick();
    expect(first.store.listRuns()).toHaveLength(1);

    // Session 2: a NEW scheduler over the same store, hours later.
    const clock = fakeClock(T0 + 121 * MINUTE);
    const dispatched: string[] = [];
    const queuedEvents: string[] = [];
    const notices: string[] = [];
    const scheduler = new Scheduler({
      store: first.store,
      clock,
      dispatch: (id) => dispatched.push(id),
      emitQueued: (id) => queuedEvents.push(id),
      log: (line) => notices.push(line),
    });
    return { ...first, clock, scheduler, dispatched, queuedEvents, notices };
  }

  it("default: skips missed fires with a logged notice, then resumes normally", () => {
    const f = restartAfterGap();
    f.scheduler.tick();
    expect(f.store.listRuns()).toHaveLength(1); // nothing fired for the 120 missed minutes
    expect(f.notices.some((n) => n.includes("skipped 120 missed cron fire(s)"))).toBe(true);

    f.clock.advance(MINUTE);
    f.scheduler.tick();
    expect(f.store.listRuns()).toHaveLength(2); // the next live fire happens normally
  });

  it('catch_up: "once" coalesces all missed fires into exactly one run', () => {
    const f = restartAfterGap("once");
    f.scheduler.tick();
    expect(f.store.listRuns()).toHaveLength(2); // the original + ONE catch-up run
    expect(f.notices.some((n) => n.includes("ran once"))).toBe(true);

    f.scheduler.tick();
    expect(f.store.listRuns()).toHaveLength(2); // idempotent
  });
});

describe("Scheduler dispatch + concurrency", () => {
  it("unlimited: dispatches every queued run", () => {
    const f = fixture();
    f.deploy("free-for-all");
    f.scheduler.tick();
    f.clock.advance(2 * MINUTE);
    f.scheduler.tick();
    expect(f.dispatched).toHaveLength(2);
  });

  it("serial: holds the next run until the active one is terminal", () => {
    const f = fixture();
    f.deploy("one-at-a-time", { concurrency: { mode: "serial" } });
    f.scheduler.tick();
    f.clock.advance(2 * MINUTE);
    f.scheduler.tick();

    expect(f.dispatched).toHaveLength(1);
    const [active] = f.dispatched;
    // Simulate the supervisor picking it up and running it.
    f.store.updateRunStatus(active ?? "", "running", { startedAt: f.clock.now() });
    f.scheduler.tick();
    expect(f.dispatched).toHaveLength(1); // still held

    f.store.updateRunStatus(active ?? "", "completed", { endedAt: f.clock.now() });
    f.scheduler.tick();
    expect(f.dispatched).toHaveLength(2); // released after terminal
  });

  it("serial_by_key gates like serial within the workflow (static key)", () => {
    const f = fixture();
    f.deploy("keyed", { concurrency: { mode: "serial_by_key", key: "tenant-a" } });
    f.scheduler.tick();
    f.clock.advance(2 * MINUTE);
    f.scheduler.tick();
    expect(f.dispatched).toHaveLength(1);
  });

  it("dispatches queued runs oldest-first", () => {
    const f = fixture();
    f.deploy("ordered");
    f.scheduler.tick();
    f.clock.advance(MINUTE);
    f.scheduler.tick();
    f.clock.advance(MINUTE);
    f.scheduler.tick();
    const runs = f.store.listRuns({ statuses: ["queued"] });
    // listRuns is newest-first; dispatch order must be the reverse.
    expect(f.dispatched).toEqual([...runs.map((r) => r.id)].reverse());
  });
});

// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { sleepMs } from "./child_host.js";

describe("sleepMs", () => {
  it("accepts every SleepArg form, including 0.3.9's duration strings", () => {
    expect(sleepMs(1500)).toBe(1500);
    expect(sleepMs({ durationMs: 250 })).toBe(250);
    expect(sleepMs("90s")).toBe(90_000);
    expect(sleepMs("1.5m")).toBe(90_000);
    expect(sleepMs("2h")).toBe(7_200_000);
  });

  it("rejects an unparseable duration string with the format hint", () => {
    expect(() => sleepMs("soon")).toThrow(/not a duration/);
    expect(() => sleepMs("15 minutes")).toThrow(/not a duration/);
  });

  it("resolves { until } relative to now", () => {
    const ms = sleepMs({ until: new Date(Date.now() + 5_000) });
    expect(ms).toBeGreaterThan(4_000);
    expect(ms).toBeLessThanOrEqual(5_000);
  });
});

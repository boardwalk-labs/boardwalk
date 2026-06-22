// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { buildEnvContext } from "./env_context.js";

const SUNDAY = new Date("2026-06-21T23:30:00.000Z");

describe("buildEnvContext", () => {
  it("renders a coarse UTC date with weekday, wrapped in an <env> block", () => {
    const out = buildEnvContext(SUNDAY, { hasClock: false });
    expect(out).toBe("<env>\nToday's date is Sunday, 2026-06-21 (UTC).\n</env>");
  });

  it("points at the clock tool only when it is present", () => {
    expect(buildEnvContext(SUNDAY, { hasClock: true })).toContain("use the `clock` tool");
    expect(buildEnvContext(SUNDAY, { hasClock: false })).not.toContain("clock");
  });

  it("uses the UTC calendar day even when the instant is late-night in other zones", () => {
    // 23:30Z is still the 21st in UTC (the 22nd in Tokyo) — the block reports the UTC day.
    expect(buildEnvContext(SUNDAY, { hasClock: false })).toContain("2026-06-21");
  });

  it("is a single content line (cheap, cache-stable) — no time-of-day", () => {
    const out = buildEnvContext(SUNDAY, { hasClock: true });
    // Exactly one line between the <env> tags, and no HH:MM (would imply false precision + churn).
    const inner = out.replace("<env>\n", "").replace("\n</env>", "");
    expect(inner.includes("\n")).toBe(false);
    expect(/\d\d:\d\d/.test(out)).toBe(false);
  });
});

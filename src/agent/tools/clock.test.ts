// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { EngineError } from "../../errors.js";
import { clockTool } from "./clock.js";

// A fixed instant so the rendered output is deterministic: 2026-06-21T18:42:03.000Z is a Sunday.
const FIXED = new Date("2026-06-21T18:42:03.000Z");
const tool = clockTool(() => FIXED);

describe("clock", () => {
  it("defaults to UTC and reports ISO 8601, the Unix epoch, and a human-readable line", async () => {
    const out = await tool.execute({});
    expect(out).toContain("2026-06-21T18:42:03.000Z (UTC, ISO 8601)");
    expect(out).toContain(`Unix epoch: ${String(Math.floor(FIXED.getTime() / 1000))} seconds`);
    // The local line names the zone and renders the full date (weekday included).
    expect(out).toContain("UTC: Sunday, June 21, 2026");
  });

  it("renders the local time in a requested IANA timezone", async () => {
    const out = await tool.execute({ timezone: "America/New_York" });
    // The UTC + epoch lines are zone-independent; only the local line shifts.
    expect(out).toContain("2026-06-21T18:42:03.000Z (UTC, ISO 8601)");
    // 18:42 UTC is 2:42 PM EDT, same calendar day.
    expect(out).toContain("America/New_York: Sunday, June 21, 2026");
    expect(out).toContain("2:42:03 PM");
  });

  it("crosses the day boundary in a far-east zone (epoch unchanged)", async () => {
    const out = await tool.execute({ timezone: "Asia/Tokyo" });
    // 18:42 UTC is 03:42 the NEXT day in Tokyo (UTC+9).
    expect(out).toContain("Asia/Tokyo: Monday, June 22, 2026");
    expect(out).toContain(`Unix epoch: ${String(Math.floor(FIXED.getTime() / 1000))} seconds`);
  });

  it("rejects an invalid timezone as a VALIDATION error with a hint", () => {
    // A pure tool throws synchronously on bad input (the loop awaits execute() inside its try).
    expect(() => tool.execute({ timezone: "Mars/Olympus_Mons" })).toThrow(EngineError);
    try {
      void tool.execute({ timezone: "not a zone" });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(EngineError);
      expect(err instanceof EngineError ? err.code : "").toBe("VALIDATION");
      expect(err instanceof EngineError ? (err.hint ?? "") : "").toContain("America/New_York");
    }
  });

  it("reads the wall clock fresh on each call (no captured timestamp)", async () => {
    let tick = 1000;
    const moving = clockTool(() => new Date(tick));
    const first = await moving.execute({});
    tick = 2000;
    const second = await moving.execute({});
    expect(first).not.toEqual(second);
    expect(first).toContain("Unix epoch: 1 seconds");
    expect(second).toContain("Unix epoch: 2 seconds");
  });

  it("advertises a no-required-field schema (a bare call is valid)", () => {
    expect(tool.inputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
    });
    expect((tool.inputSchema as { required?: string[] }).required).toBeUndefined();
  });
});

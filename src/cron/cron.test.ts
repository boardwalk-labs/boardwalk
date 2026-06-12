import { describe, expect, it } from "vitest";
import { EngineError } from "../errors.js";
import { nextFire, parseCron } from "./cron.js";

/** Fires of `expr` strictly after `afterMs`, chained — keeps assertions about sequences readable. */
function fires(expr: string, afterMs: number, count: number, timezone?: string): (number | null)[] {
  const schedule = parseCron(expr);
  const out: (number | null)[] = [];
  let cursor = afterMs;
  for (let i = 0; i < count; i++) {
    const next = nextFire(schedule, cursor, timezone);
    out.push(next);
    if (next === null) break;
    cursor = next;
  }
  return out;
}

function expectValidationError(fn: () => unknown, messagePart: string): void {
  let thrown: unknown;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  if (!(thrown instanceof EngineError)) {
    throw new Error(`expected an EngineError, got: ${String(thrown)}`);
  }
  expect(thrown.code).toBe("VALIDATION");
  expect(thrown.message).toContain(messagePart);
}

describe("parseCron — field syntax", () => {
  it("parses * in every field", () => {
    const s = parseCron("* * * * *");
    expect(s.seconds).toEqual([0]); // 5-field: implicit second 0
    expect(s.minutes).toHaveLength(60);
    expect(s.hours).toHaveLength(24);
    expect(s.daysOfMonth.size).toBe(31);
    expect(s.months.size).toBe(12);
    expect(s.daysOfWeek.size).toBe(7);
    expect(s.domIsStar).toBe(true);
    expect(s.dowIsStar).toBe(true);
  });

  it("parses single values", () => {
    const s = parseCron("30 9 15 6 3");
    expect(s.minutes).toEqual([30]);
    expect(s.hours).toEqual([9]);
    expect([...s.daysOfMonth]).toEqual([15]);
    expect([...s.months]).toEqual([6]);
    expect([...s.daysOfWeek]).toEqual([3]);
  });

  it("parses lists", () => {
    expect(parseCron("1,5,20 * * * *").minutes).toEqual([1, 5, 20]);
  });

  it("parses ranges", () => {
    expect(parseCron("* 9-12 * * *").hours).toEqual([9, 10, 11, 12]);
  });

  it("parses */step", () => {
    expect(parseCron("*/15 * * * *").minutes).toEqual([0, 15, 30, 45]);
  });

  it("parses range/step", () => {
    expect(parseCron("10-30/5 * * * *").minutes).toEqual([10, 15, 20, 25, 30]);
  });

  it("parses value/step as value-through-max (cronie extension)", () => {
    expect(parseCron("* 20/2 * * *").hours).toEqual([20, 22]);
  });

  it("parses mixed lists of ranges and steps", () => {
    expect(parseCron("1,10-12,*/30 * * * *").minutes).toEqual([0, 1, 10, 11, 12, 30]);
  });

  it("parses month names case-insensitively, including in ranges", () => {
    expect([...parseCron("0 0 1 JAN *").months]).toEqual([1]);
    expect([...parseCron("0 0 1 dec *").months]).toEqual([12]);
    expect([...parseCron("0 0 1 Oct-Dec *").months]).toEqual([10, 11, 12]);
  });

  it("parses day names case-insensitively, including in ranges", () => {
    expect([...parseCron("0 0 * * SUN").daysOfWeek]).toEqual([0]);
    expect([...parseCron("0 0 * * mon-fri").daysOfWeek]).toEqual([1, 2, 3, 4, 5]);
  });

  it("treats day-of-week 0 and 7 both as Sunday", () => {
    expect([...parseCron("0 0 * * 0").daysOfWeek]).toEqual([0]);
    expect([...parseCron("0 0 * * 7").daysOfWeek]).toEqual([0]);
    // A 5-7 range crosses the fold: SAT(6), SUN(7→0) alongside FRI(5).
    expect([...parseCron("0 0 * * 5-7").daysOfWeek].sort((a, b) => a - b)).toEqual([0, 5, 6]);
  });

  it("parses 6-field expressions with seconds", () => {
    const s = parseCron("*/20 5 12 * * *");
    expect(s.seconds).toEqual([0, 20, 40]);
    expect(s.minutes).toEqual([5]);
    expect(s.hours).toEqual([12]);
  });
});

describe("parseCron — invalid expressions name the offending field", () => {
  it("rejects wrong field counts", () => {
    expectValidationError(() => parseCron("* * * *"), "4 field(s)");
    expectValidationError(() => parseCron("* * * * * * *"), "7 field(s)");
    expectValidationError(() => parseCron(""), "1 field(s)");
  });

  it("rejects out-of-range values, naming the field", () => {
    expectValidationError(() => parseCron("60 * * * *"), "minute");
    expectValidationError(() => parseCron("* 24 * * *"), "hour");
    expectValidationError(() => parseCron("* * 0 * *"), "day-of-month");
    expectValidationError(() => parseCron("* * 32 * *"), "day-of-month");
    expectValidationError(() => parseCron("* * * 13 *"), "month");
    expectValidationError(() => parseCron("* * * * 8"), "day-of-week");
    expectValidationError(() => parseCron("60 * * * * *"), "second");
  });

  it("rejects bad names, naming the field", () => {
    expectValidationError(() => parseCron("0 0 1 FOO *"), "month");
    expectValidationError(() => parseCron("0 0 * * FUNDAY"), "day-of-week");
  });

  it("rejects bad steps, naming the field", () => {
    expectValidationError(() => parseCron("*/0 * * * *"), "minute");
    expectValidationError(() => parseCron("*/x * * * *"), "minute");
    expectValidationError(() => parseCron("* */ * * *"), "hour");
    expectValidationError(() => parseCron("* * 1/2/3 * *"), "day-of-month");
  });

  it("rejects malformed ranges and lists", () => {
    expectValidationError(() => parseCron("5-1 * * * *"), "reversed");
    expectValidationError(() => parseCron("1- * * * *"), "minute");
    expectValidationError(() => parseCron("-5 * * * *"), "minute");
    expectValidationError(() => parseCron("1-2-3 * * * *"), "minute");
    expectValidationError(() => parseCron("1,,2 * * * *"), "minute");
  });
});

describe("nextFire — basics (UTC)", () => {
  it("returns the next matching minute", () => {
    // After 2026-06-10T00:00:30Z, "*/15 * * * *" fires at 00:15:00.
    expect(nextFire(parseCron("*/15 * * * *"), Date.UTC(2026, 5, 10, 0, 0, 30))).toBe(
      Date.UTC(2026, 5, 10, 0, 15, 0),
    );
  });

  it("is STRICTLY after — a fire exactly at afterMs is not returned", () => {
    const midnight = Date.UTC(2026, 0, 1, 0, 0, 0); // an exact "0 0 * * *" fire
    expect(nextFire(parseCron("0 0 * * *"), midnight)).toBe(Date.UTC(2026, 0, 2, 0, 0, 0));
  });

  it("defaults to UTC", () => {
    const after = Date.UTC(2026, 5, 10, 0, 0, 0);
    expect(nextFire(parseCron("0 9 * * *"), after)).toBe(
      nextFire(parseCron("0 9 * * *"), after, "UTC"),
    );
  });

  it("honors 6-field seconds", () => {
    const after = Date.UTC(2026, 5, 10, 8, 0, 5);
    const s = parseCron("*/20 0 8 * * *"); // 08:00:00, :20, :40
    expect(nextFire(s, after)).toBe(Date.UTC(2026, 5, 10, 8, 0, 20));
    expect(nextFire(s, Date.UTC(2026, 5, 10, 8, 0, 40))).toBe(Date.UTC(2026, 5, 11, 8, 0, 0));
  });

  it("rolls over month and year boundaries", () => {
    expect(nextFire(parseCron("0 0 1 * *"), Date.UTC(2026, 11, 15))).toBe(Date.UTC(2027, 0, 1));
  });

  it("matches month and day names end-to-end", () => {
    // 2026-06-14 is a Sunday (pinned via Date.UTC weekday checks).
    expect(nextFire(parseCron("0 6 * JUN sun"), Date.UTC(2026, 5, 10))).toBe(
      Date.UTC(2026, 5, 14, 6, 0, 0),
    );
  });
});

describe("nextFire — dom/dow rule", () => {
  // June 2026 weekdays (pinned): Jun 5 = Fri, Jun 12 = Fri, Jun 13 = Sat.
  it("ORs dom and dow when BOTH are restricted (13th or any Friday)", () => {
    expect(fires("0 0 13 * 5", Date.UTC(2026, 5, 10), 2)).toEqual([
      Date.UTC(2026, 5, 12), // Friday the 12th (dow match)
      Date.UTC(2026, 5, 13), // Saturday the 13th (dom match)
    ]);
  });

  it("lets dom alone decide when dow is *", () => {
    // Jun 13 2026 is a Saturday; a restricted dom with dow=* must still fire on it.
    expect(nextFire(parseCron("0 0 13 * *"), Date.UTC(2026, 5, 10))).toBe(Date.UTC(2026, 5, 13));
  });

  it("lets dow alone decide when dom is *", () => {
    // Next Friday after Wed 2026-06-10 is Jun 12, skipping dom values along the way.
    expect(nextFire(parseCron("0 0 * * 5"), Date.UTC(2026, 5, 10))).toBe(Date.UTC(2026, 5, 12));
  });

  it("ANDs when one field is a star-step (Vixie's literal-* rule)", () => {
    // dom `*/2` starts with `*`, so Vixie requires BOTH to match: odd day AND Friday.
    // After Wed 2026-06-10: Fri Jun 12 is even (no), Fri Jun 19 is odd (yes).
    expect(nextFire(parseCron("0 0 */2 * 5"), Date.UTC(2026, 5, 10))).toBe(Date.UTC(2026, 5, 19));
  });

  it("treats dow 7 as Sunday when computing fires", () => {
    // Next Sunday after Wed 2026-06-10 is Jun 14.
    expect(nextFire(parseCron("0 0 * * 7"), Date.UTC(2026, 5, 10))).toBe(Date.UTC(2026, 5, 14));
  });
});

describe("nextFire — timezones", () => {
  it("interprets wall-clock times in the given IANA zone", () => {
    const after = Date.UTC(2026, 5, 10, 0, 0, 0);
    const nineAm = parseCron("0 9 * * *");
    // 09:00 in New York (EDT, UTC-4) = 13:00Z; pinned: 1781096400000 / 1781082000000.
    expect(nextFire(nineAm, after, "America/New_York")).toBe(1781096400000);
    expect(nextFire(nineAm, after, "UTC")).toBe(1781082000000);
    expect(Date.UTC(2026, 5, 10, 13)).toBe(1781096400000);
    expect(Date.UTC(2026, 5, 10, 9)).toBe(1781082000000);
  });

  it("throws VALIDATION on an invalid timezone", () => {
    expectValidationError(
      () => nextFire(parseCron("0 9 * * *"), 0, "Not/A_Zone"),
      'unknown timezone "Not/A_Zone"',
    );
  });

  it("skips a wall time erased by spring-forward", () => {
    // America/New_York jumps 02:00→03:00 on 2026-03-08, so 02:30 that day never occurs.
    // The next existing 03-08 02:30 is in 2027 (DST starts 2027-03-14): 02:30 EST = 07:30Z,
    // pinned to 1804491000000.
    const s = parseCron("30 2 8 3 *");
    expect(nextFire(s, Date.UTC(2026, 1, 1), "America/New_York")).toBe(1804491000000);
    expect(new Date(1804491000000).toISOString()).toBe("2027-03-08T07:30:00.000Z");
  });

  it("does not skip times outside the spring-forward gap", () => {
    // 03:30 on the same transition day exists (it's the first post-jump half-hour mark).
    expect(nextFire(parseCron("30 3 8 3 *"), Date.UTC(2026, 1, 1), "America/New_York")).toBe(
      Date.UTC(2026, 2, 8, 7, 30), // 03:30 EDT = 07:30Z
    );
  });

  it("fires a fall-back-repeated wall time ONCE, at its first UTC occurrence", () => {
    // America/New_York repeats 01:00–02:00 on 2026-11-01: 01:30 EDT = 05:30Z (1793511000000),
    // then 01:30 EST = 06:30Z (1793514600000).
    const s = parseCron("30 1 1 11 *");
    const fire = nextFire(s, Date.UTC(2026, 9, 1), "America/New_York");
    expect(fire).toBe(1793511000000);
    // Asking again after that fire must NOT yield the second occurrence (06:30Z) — the next
    // fire is a year out: 2027-11-01 01:30 EDT = 05:30Z (1825047000000; 2027 falls back Nov 7).
    expect(nextFire(s, 1793511000000, "America/New_York")).toBe(1825047000000);
    expect(nextFire(s, 1793511000000, "America/New_York")).not.toBe(1793514600000);
  });
});

describe("nextFire — horizon and performance", () => {
  it("finds sparse schedules across leap years quickly", () => {
    const s = parseCron("0 0 29 2 *"); // Feb 29 — next after mid-2026 is 2028.
    const startedAt = performance.now();
    const fire = nextFire(s, Date.UTC(2026, 5, 10));
    const elapsed = performance.now() - startedAt;
    expect(fire).toBe(1835395200000); // 2028-02-29T00:00:00Z, pinned
    expect(elapsed).toBeLessThan(50);
  });

  it("returns null for impossible schedules (Feb 30)", () => {
    const startedAt = performance.now();
    expect(nextFire(parseCron("0 0 30 2 *"), Date.UTC(2026, 0, 1))).toBeNull();
    expect(performance.now() - startedAt).toBeLessThan(50);
  });

  it("returns null for Feb 31 too (no month-31 special-casing hides it)", () => {
    expect(nextFire(parseCron("0 0 31 2 *"), Date.UTC(2026, 0, 1))).toBeNull();
  });
});

// Cron parsing + next-fire computation for the scheduler (SPEC §2.1).
//
// One-validator philosophy: the SDK manifest schema only checks a cron trigger shallowly
// (5 or 6 whitespace-separated fields; timezone = a non-empty string). This module is the
// deep validator of record — anything `parseCron`/`nextFire` reject must be rejected at
// deploy time, so a stored manifest can never contain a schedule the engine can't fire.
//
// Semantics are Vixie cron's where Vixie has an opinion:
// - dom/dow: when NEITHER field starts with `*`, a day matches if EITHER matches (the
//   classic OR rule); when at least one starts with `*`, both must match (the star field
//   matches everything, so effectively the other decides). Vixie keys this off the literal
//   leading `*` (its DOM_STAR/DOW_STAR flags), so `*/2` counts as a star field — we match.
// - dow 0 and 7 are both Sunday.
// Plus the modern (cronie/Quartz/AWS) extension `N/step` = `N-max/step`, because it is what
// authors coming from any contemporary cron expect and accepting it loses nothing.
//
// Timezones use Intl only — this package takes no runtime dependency for cron (CODE_QUALITY
// §10: every dependency is supply-chain surface). DST policy: a wall time erased by
// spring-forward is skipped (it never occurs, so it never fires); a wall time repeated by
// fall-back fires once, at its first (earlier-UTC) occurrence.

import { EngineError } from "../errors.js";

/**
 * A parsed, validated cron expression. Opaque to callers — the fields exist so `nextFire`
 * can enumerate matches without re-parsing; their layout may change without notice.
 */
export interface CronSchedule {
  /** Sorted ascending for in-day enumeration. 5-field expressions get `[0]`. */
  readonly seconds: readonly number[];
  readonly minutes: readonly number[];
  readonly hours: readonly number[];
  readonly daysOfMonth: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  /** 0–6, Sunday = 0 (a literal 7 is normalized at parse time). */
  readonly daysOfWeek: ReadonlySet<number>;
  /** Why track the literal `*` prefix: Vixie's dom/dow OR rule keys off it, not off set contents. */
  readonly domIsStar: boolean;
  readonly dowIsStar: boolean;
}

// ============================================================================
// Parsing
// ============================================================================

interface FieldSpec {
  /** Human name used in VALIDATION messages, e.g. `day-of-week`. */
  readonly label: string;
  readonly min: number;
  readonly max: number;
  /** Three-letter names (JAN/SUN style), matched case-insensitively. */
  readonly names?: Readonly<Record<string, number>>;
  /** Post-expansion normalization (dow folds 7 → 0 so Sunday has one representation). */
  readonly normalize?: (value: number) => number;
}

const SECOND: FieldSpec = { label: "second", min: 0, max: 59 };
const MINUTE: FieldSpec = { label: "minute", min: 0, max: 59 };
const HOUR: FieldSpec = { label: "hour", min: 0, max: 23 };
const DOM: FieldSpec = { label: "day-of-month", min: 1, max: 31 };
const MONTH: FieldSpec = {
  label: "month",
  min: 1,
  max: 12,
  names: {
    JAN: 1,
    FEB: 2,
    MAR: 3,
    APR: 4,
    MAY: 5,
    JUN: 6,
    JUL: 7,
    AUG: 8,
    SEP: 9,
    OCT: 10,
    NOV: 11,
    DEC: 12,
  },
};
const DOW: FieldSpec = {
  label: "day-of-week",
  min: 0,
  max: 7, // 7 accepted as Sunday, folded to 0 below
  names: { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 },
  normalize: (v) => (v === 7 ? 0 : v),
};

function fieldError(spec: FieldSpec, detail: string): EngineError {
  return new EngineError("VALIDATION", `cron: invalid ${spec.label} field: ${detail}`);
}

/** Resolve one endpoint of a range: a decimal number or a three-letter name. */
function parseValue(raw: string, spec: FieldSpec): number {
  if (/^\d+$/.test(raw)) {
    const value = Number.parseInt(raw, 10);
    if (value < spec.min || value > spec.max) {
      throw fieldError(
        spec,
        `value ${String(value)} out of range ${String(spec.min)}-${String(spec.max)}`,
      );
    }
    return value;
  }
  const named = spec.names?.[raw.toUpperCase()];
  if (named !== undefined) return named;
  throw fieldError(spec, `unrecognized value "${raw}"`);
}

/** Expand one comma-separated item (`*`, `N`, `A-B`, with optional `/step`) into values. */
function parseItem(item: string, spec: FieldSpec, into: Set<number>): void {
  const slashParts = item.split("/");
  if (slashParts.length > 2) throw fieldError(spec, `too many "/" in "${item}"`);
  const body = slashParts[0] ?? "";
  const stepRaw = slashParts[1];
  const hasStep = slashParts.length === 2;
  if (body === "") throw fieldError(spec, `empty value in "${item}"`);

  let step = 1;
  if (hasStep) {
    if (stepRaw === undefined || !/^\d+$/.test(stepRaw)) {
      throw fieldError(spec, `step in "${item}" must be a positive integer`);
    }
    step = Number.parseInt(stepRaw, 10);
    if (step === 0) throw fieldError(spec, `step in "${item}" must be at least 1`);
  }

  let lo: number;
  let hi: number;
  if (body === "*") {
    lo = spec.min;
    hi = spec.max;
  } else {
    const dashParts = body.split("-");
    if (dashParts.length > 2) throw fieldError(spec, `too many "-" in "${item}"`);
    const loRaw = dashParts[0] ?? "";
    const hiRaw = dashParts.length === 2 ? (dashParts[1] ?? "") : undefined;
    if (loRaw === "" || hiRaw === "") throw fieldError(spec, `malformed range "${item}"`);
    lo = parseValue(loRaw, spec);
    if (hiRaw !== undefined) {
      hi = parseValue(hiRaw, spec);
    } else if (hasStep) {
      // Why: `N/step` means N-through-max by step (cronie/Quartz/AWS extension) — what
      // contemporary cron authors expect; original Vixie simply errored here.
      hi = spec.max;
    } else {
      hi = lo;
    }
    if (lo > hi) {
      throw fieldError(spec, `range ${String(lo)}-${String(hi)} is reversed in "${item}"`);
    }
  }

  for (let v = lo; v <= hi; v += step) {
    into.add(spec.normalize ? spec.normalize(v) : v);
  }
}

function parseField(text: string, spec: FieldSpec): Set<number> {
  const values = new Set<number>();
  for (const item of text.split(",")) {
    if (item === "") throw fieldError(spec, `empty list entry in "${text}"`);
    parseItem(item, spec, values);
  }
  return values;
}

/**
 * Parse a 5-field (min hour dom mon dow) or 6-field (sec min hour dom mon dow) cron
 * expression. Throws `EngineError("VALIDATION", …)` naming the bad field, so deploy-time
 * errors point the author at exactly what to fix in their `meta` trigger.
 */
export function parseCron(expr: string): CronSchedule {
  const fields = expr.trim().split(/\s+/);
  // Why mirror the SDK's field-count check exactly: the manifest schema's only cron
  // validation is "5 or 6 fields" — the two validators must agree on that boundary.
  if (fields.length !== 5 && fields.length !== 6) {
    throw new EngineError(
      "VALIDATION",
      `cron: expression "${expr}" has ${String(fields.length)} field(s); ` +
        `expected 5 (min hour dom mon dow) or 6 (sec min hour dom mon dow)`,
    );
  }
  const six = fields.length === 6;
  // The length check above guarantees every index below exists; `?? ""` (which parseField
  // rejects) keeps the narrowing honest under noUncheckedIndexedAccess without a cast.
  const field = (i: number): string => fields[i] ?? "";
  const domText = field(six ? 3 : 2);
  const dowText = field(six ? 5 : 4);
  return {
    seconds: six ? sorted(parseField(field(0), SECOND)) : [0],
    minutes: sorted(parseField(field(six ? 1 : 0), MINUTE)),
    hours: sorted(parseField(field(six ? 2 : 1), HOUR)),
    daysOfMonth: parseField(domText, DOM),
    months: parseField(field(six ? 4 : 3), MONTH),
    daysOfWeek: parseField(dowText, DOW),
    domIsStar: domText.startsWith("*"),
    dowIsStar: dowText.startsWith("*"),
  };
}

const asc = (a: number, b: number): number => a - b;
const sorted = (values: Set<number>): number[] => [...values].sort(asc);

// ============================================================================
// Next-fire computation
// ============================================================================

const DAY_MS = 86_400_000;
// Why ~5 years: long enough that any schedule with a real fire (worst case: a dom/month
// combo that only exists in leap years) is found, short enough that an impossible schedule
// (Feb 30) returns null after a bounded, fast day scan instead of looping forever.
const HORIZON_DAYS = 366 * 5 + 7;

/**
 * Why a cached formatter per timezone: constructing Intl.DateTimeFormat is the expensive
 * part (locale + tz data resolution); formatToParts on a cached instance is cheap enough
 * to call a handful of times per candidate fire.
 */
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timezone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timezone);
  if (cached) return cached;
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      // Why h23: guarantees hours 00-23 (h24 would render midnight as "24").
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    throw new EngineError(
      "VALIDATION",
      `cron: unknown timezone "${timezone}"`,
      'use an IANA zone name like "America/New_York" or "UTC"',
    );
  }
  formatterCache.set(timezone, fmt);
  return fmt;
}

interface WallTime {
  readonly year: number;
  readonly month: number; // 1-12
  readonly day: number; // 1-31
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

/** Read the wall-clock reading of a UTC instant in the formatter's timezone. */
function wallTimeAt(fmt: Intl.DateTimeFormat, epochMs: number): WallTime {
  let year = 0;
  let month = 0;
  let day = 0;
  let hour = 0;
  let minute = 0;
  let second = 0;
  for (const part of fmt.formatToParts(epochMs)) {
    switch (part.type) {
      case "year":
        year = Number.parseInt(part.value, 10);
        break;
      case "month":
        month = Number.parseInt(part.value, 10);
        break;
      case "day":
        day = Number.parseInt(part.value, 10);
        break;
      case "hour":
        hour = Number.parseInt(part.value, 10);
        break;
      case "minute":
        minute = Number.parseInt(part.value, 10);
        break;
      case "second":
        second = Number.parseInt(part.value, 10);
        break;
      default:
        break;
    }
  }
  return { year, month, day, hour, minute, second };
}

/** UTC-offset of the zone at `epochMs`, in ms (positive east of UTC). */
function offsetAt(fmt: Intl.DateTimeFormat, epochMs: number): number {
  const w = wallTimeAt(fmt, epochMs);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - epochMs;
}

/**
 * All UTC instants (sorted ascending) at which the zone's wall clock reads exactly the given
 * time: 0 instants in a spring-forward gap, 1 normally, 2 across a fall-back overlap.
 *
 * Why probe offsets a day either side of the naive guess: the zone's offset at the target
 * instant is unknown until we pick an instant. Sampling the offset at guess±24h brackets any
 * single transition (real-world DST shifts are well under 24h), and each candidate offset is
 * then verified by reading the wall clock back — a stale or irrelevant offset simply fails
 * verification, so over-probing is harmless.
 */
function wallTimeToEpochs(fmt: Intl.DateTimeFormat, target: WallTime): number[] {
  const guess = Date.UTC(
    target.year,
    target.month - 1,
    target.day,
    target.hour,
    target.minute,
    target.second,
  );
  const candidateOffsets = new Set<number>([
    offsetAt(fmt, guess - DAY_MS),
    offsetAt(fmt, guess),
    offsetAt(fmt, guess + DAY_MS),
  ]);
  const epochs: number[] = [];
  for (const offset of candidateOffsets) {
    const epoch = guess - offset;
    const readBack = wallTimeAt(fmt, epoch);
    if (
      readBack.year === target.year &&
      readBack.month === target.month &&
      readBack.day === target.day &&
      readBack.hour === target.hour &&
      readBack.minute === target.minute &&
      readBack.second === target.second
    ) {
      epochs.push(epoch);
    }
  }
  return epochs.sort(asc);
}

/** Vixie's day-match rule — see the module header for why the star flags (not set contents) decide. */
function dayMatches(schedule: CronSchedule, year: number, month: number, day: number): boolean {
  const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const domHit = schedule.daysOfMonth.has(day);
  const dowHit = schedule.daysOfWeek.has(dow);
  return schedule.domIsStar || schedule.dowIsStar ? domHit && dowHit : domHit || dowHit;
}

/**
 * The next fire time STRICTLY AFTER `afterMs`, computed in the given IANA timezone (default
 * "UTC"), as epoch ms. Returns null when no fire occurs within the ~5-year search horizon
 * (an impossible schedule like Feb 30). Throws `EngineError("VALIDATION", …)` on an invalid
 * timezone.
 *
 * Why day-first enumeration instead of stepping minute-by-minute: a sparse schedule (e.g.
 * `0 0 29 2 *`) would otherwise scan millions of minutes across years; scanning calendar
 * days needs only ~1.8k cheap iterations, and Intl is consulted only on days that match.
 */
export function nextFire(schedule: CronSchedule, afterMs: number, timezone = "UTC"): number | null {
  const fmt = getFormatter(timezone);
  const start = wallTimeAt(fmt, afterMs);

  // Why iterate wall dates via UTC date arithmetic: calendar succession (Jun 30 → Jul 1) is
  // timezone-independent, so a UTC day cursor never needs Intl; noon keeps the cursor clear
  // of any midnight-adjacent DST weirdness when adding 24h.
  let dayCursor = Date.UTC(start.year, start.month - 1, start.day, 12);

  for (let i = 0; i < HORIZON_DAYS; i++) {
    const cursor = new Date(dayCursor);
    const year = cursor.getUTCFullYear();
    const month = cursor.getUTCMonth() + 1;
    const day = cursor.getUTCDate();

    if (schedule.months.has(month) && dayMatches(schedule, year, month, day)) {
      // Why lower-bounding by wall time is safe on the first day: the earliest-occurrence
      // wall→epoch mapping is monotonic, and the first occurrence of afterMs's own wall
      // reading is ≤ afterMs — so earlier wall times can never yield an epoch > afterMs.
      const first = i === 0;
      for (const hour of schedule.hours) {
        if (first && hour < start.hour) continue;
        for (const minute of schedule.minutes) {
          if (first && hour === start.hour && minute < start.minute) continue;
          for (const second of schedule.seconds) {
            if (first && hour === start.hour && minute === start.minute && second < start.second) {
              continue;
            }
            const epochs = wallTimeToEpochs(fmt, { year, month, day, hour, minute, second });
            // `epochs[0]` is undefined in a spring-forward gap (the wall time never occurs,
            // so it never fires); otherwise it is the FIRST (earlier-UTC) occurrence, which
            // makes a fall-back-repeated wall time fire exactly once. The strict `>` also
            // enforces the STRICTLY-after contract.
            const epoch = epochs[0];
            if (epoch !== undefined && epoch > afterMs) return epoch;
          }
        }
      }
    }
    dayCursor += DAY_MS;
  }
  return null;
}

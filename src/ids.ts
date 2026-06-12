// ULIDs — the engine's primary-key format (CODE_QUALITY §2.2): time-sortable, URL-safe,
// no auto-increment integers. Implemented in-house: 26 chars of Crockford base32 over
// 48 bits of timestamp + 80 bits of crypto randomness. Zero dependencies on purpose —
// every dependency in a public package is supply-chain surface.

import { randomBytes } from "node:crypto";

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32 (no I, L, O, U)
const TIME_LEN = 10;
const RANDOM_LEN = 16;
export const ULID_LENGTH = TIME_LEN + RANDOM_LEN;

/** Generate a ULID for the given timestamp (defaults to now). */
export function ulid(timeMs: number = Date.now()): string {
  if (!Number.isInteger(timeMs) || timeMs < 0 || timeMs > 2 ** 48 - 1) {
    throw new RangeError(`ulid timestamp out of range: ${String(timeMs)}`);
  }
  let time = "";
  let t = timeMs;
  for (let i = 0; i < TIME_LEN; i++) {
    time = ENCODING[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = randomBytes(RANDOM_LEN);
  let rand = "";
  for (let i = 0; i < RANDOM_LEN; i++) {
    // Why modulo a byte: 256 % 32 === 0, so each character stays uniformly distributed.
    rand += ENCODING[(bytes[i] as number) % 32];
  }
  return time + rand;
}

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** True when `value` is a well-formed ULID (shape check only, not provenance). */
export function isUlid(value: string): boolean {
  return ULID_RE.test(value);
}

/** Recover the millisecond timestamp encoded in a ULID's time component. */
export function ulidTime(id: string): number {
  if (!isUlid(id)) throw new RangeError(`not a ULID: ${id}`);
  let t = 0;
  for (let i = 0; i < TIME_LEN; i++) {
    t = t * 32 + ENCODING.indexOf(id[i] as string);
  }
  return t;
}

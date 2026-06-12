import { describe, expect, it } from "vitest";
import { isUlid, ulid, ulidTime, ULID_LENGTH } from "./ids.js";

describe("ulid", () => {
  it("generates 26-char Crockford base32 ids", () => {
    const id = ulid();
    expect(id).toHaveLength(ULID_LENGTH);
    expect(isUlid(id)).toBe(true);
  });

  it("round-trips the timestamp", () => {
    const t = 1750000000000;
    expect(ulidTime(ulid(t))).toBe(t);
  });

  it("sorts lexicographically by time", () => {
    const earlier = ulid(1000);
    const later = ulid(2000);
    expect(earlier < later).toBe(true);
  });

  it("is unique across many generations in the same millisecond", () => {
    const t = 1750000000000;
    const ids = new Set(Array.from({ length: 1000 }, () => ulid(t)));
    expect(ids.size).toBe(1000);
  });

  it("rejects out-of-range timestamps", () => {
    expect(() => ulid(-1)).toThrow(RangeError);
    expect(() => ulid(2 ** 48)).toThrow(RangeError);
    expect(() => ulid(1.5)).toThrow(RangeError);
  });

  it("rejects malformed ids in ulidTime", () => {
    expect(() => ulidTime("not-a-ulid")).toThrow(RangeError);
    expect(isUlid("ILOU".repeat(7))).toBe(false);
  });
});

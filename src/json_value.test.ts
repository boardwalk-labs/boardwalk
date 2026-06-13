// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { asJsonValue, isJsonValue } from "./json_value.js";
import { EngineError } from "./errors.js";

describe("isJsonValue", () => {
  it("accepts JSON trees", () => {
    expect(isJsonValue(null)).toBe(true);
    expect(isJsonValue("s")).toBe(true);
    expect(isJsonValue(1.5)).toBe(true);
    expect(isJsonValue(false)).toBe(true);
    expect(isJsonValue([1, { a: ["b", null] }])).toBe(true);
    expect(isJsonValue(Object.create(null))).toBe(true);
  });

  it("rejects non-JSON values", () => {
    expect(isJsonValue(undefined)).toBe(false);
    expect(isJsonValue(() => 1)).toBe(false);
    expect(isJsonValue(Symbol("x"))).toBe(false);
    expect(isJsonValue(10n)).toBe(false);
    expect(isJsonValue(NaN)).toBe(false);
    expect(isJsonValue(Infinity)).toBe(false);
    expect(isJsonValue(new Date())).toBe(false);
    expect(isJsonValue({ a: undefined })).toBe(false);
    expect(isJsonValue([1, () => 2])).toBe(false);
  });
});

describe("asJsonValue", () => {
  it("returns the value unchanged when valid", () => {
    const v = { a: [1, "x"] };
    expect(asJsonValue(v, "output")).toEqual({ a: [1, "x"] });
  });

  it("throws a VALIDATION EngineError naming the subject", () => {
    expect(() => asJsonValue(new Map(), "The run's declared output")).toThrowError(EngineError);
    expect(() => asJsonValue(new Map(), "The run's declared output")).toThrow(
      /declared output must be a JSON-serializable value/,
    );
  });
});

// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { canonicalJson, defaultIdempotencyKey } from "./idempotency.js";

describe("canonicalJson", () => {
  it("sorts object keys recursively", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it("preserves array order", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });

  it("matches JSON.stringify for scalars and nested structures", () => {
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson('a "quoted" string')).toBe(JSON.stringify('a "quoted" string'));
    expect(canonicalJson(1.5)).toBe("1.5");
    expect(canonicalJson([{ a: [true, false] }])).toBe('[{"a":[true,false]}]');
  });
});

describe("defaultIdempotencyKey", () => {
  it("is stable across object key order", () => {
    const a = defaultIdempotencyKey("run-1", "child", { x: 1, y: 2 });
    const b = defaultIdempotencyKey("run-1", "child", { y: 2, x: 1 });
    expect(a).toBe(b);
  });

  it("differs by parent, slug, and input", () => {
    const base = defaultIdempotencyKey("run-1", "child", { x: 1 });
    expect(defaultIdempotencyKey("run-2", "child", { x: 1 })).not.toBe(base);
    expect(defaultIdempotencyKey("run-1", "other", { x: 1 })).not.toBe(base);
    expect(defaultIdempotencyKey("run-1", "child", { x: 2 })).not.toBe(base);
  });

  it("is a hex sha256", () => {
    expect(defaultIdempotencyKey("r", "s", null)).toMatch(/^[0-9a-f]{64}$/);
  });
});

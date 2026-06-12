import { describe, expect, it } from "vitest";
import { Redactor } from "./redact.js";

describe("Redactor", () => {
  it("scrubs every occurrence of a registered value", () => {
    const r = new Redactor();
    r.add("GH_TOKEN", "ghp_secret123");
    expect(r.redact("token=ghp_secret123 retry with ghp_secret123")).toBe(
      "token=[redacted:GH_TOKEN] retry with [redacted:GH_TOKEN]",
    );
  });

  it("redacts longer values first so fragments of overlapping secrets can't survive", () => {
    const r = new Redactor();
    r.add("SHORT", "abc12345");
    r.add("LONG", "abc12345-extended-tail");
    const out = r.redact("x abc12345-extended-tail y abc12345 z");
    expect(out).toBe("x [redacted:LONG] y [redacted:SHORT] z");
    expect(out).not.toContain("abc12345");
  });

  it("ignores values too short to redact meaningfully", () => {
    const r = new Redactor();
    r.add("TINY", "ab");
    expect(r.redact("ab absolutely")).toBe("ab absolutely");
  });

  it("is a no-op with no registered values", () => {
    expect(new Redactor().redact("untouched")).toBe("untouched");
  });
});

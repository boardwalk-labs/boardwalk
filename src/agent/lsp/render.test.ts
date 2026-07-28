// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { Diagnostic } from "./client.js";
import {
  MAX_RENDERED_DIAGNOSTICS,
  MAX_RENDERED_LOCATIONS,
  renderDiagnostics,
  renderLocations,
  type RenderedLocation,
} from "./render.js";

describe("renderDiagnostics", () => {
  it("renders a clean file as a single 'no diagnostics' line", () => {
    expect(renderDiagnostics("src/a.ts", [])).toBe("No diagnostics for src/a.ts.");
  });

  it("renders severity, path:line, message, and the source tag", () => {
    const out = renderDiagnostics("src/a.ts", [
      { line: 12, severity: "error", message: "Cannot find name 'x'.", source: "ts 2304" },
    ]);
    expect(out).toContain("src/a.ts: 1 error");
    expect(out).toContain("error src/a.ts:12 Cannot find name 'x'. [ts 2304]");
  });

  it("sorts errors before warnings, then by line, and summarizes counts", () => {
    const diagnostics: Diagnostic[] = [
      { line: 9, severity: "warning", message: "unused" },
      { line: 2, severity: "error", message: "type error" },
      { line: 1, severity: "warning", message: "deprecated" },
    ];
    const out = renderDiagnostics("a.ts", diagnostics);
    const lines = out.split("\n");
    expect(lines[0]).toBe("a.ts: 1 error, 2 warnings");
    expect(lines[1]).toContain("error a.ts:2");
    expect(lines[2]).toContain("warning a.ts:1"); // warnings ordered by line within their group
    expect(lines[3]).toContain("warning a.ts:9");
  });

  it("caps the rendered set and notes how many were truncated", () => {
    const many: Diagnostic[] = Array.from({ length: MAX_RENDERED_DIAGNOSTICS + 5 }, (_, i) => ({
      line: i + 1,
      severity: "error",
      message: `e${String(i)}`,
    }));
    const out = renderDiagnostics("a.ts", many);
    expect(out).toContain(`…[5 more diagnostics truncated]`);
    // The header still reflects the FULL count, not the rendered count.
    expect(out).toContain(`a.ts: ${String(MAX_RENDERED_DIAGNOSTICS + 5)} errors`);
  });

  it("omits the source tag when the diagnostic has none", () => {
    const out = renderDiagnostics("a.ts", [{ line: 1, severity: "warning", message: "m" }]);
    expect(out).toContain("warning a.ts:1 m");
    expect(out).not.toContain("[");
  });
});

describe("renderLocations", () => {
  it("leads each line with path:line:col, followed by the explaining text", () => {
    const out = renderLocations("references to `parse`", [
      { path: "src/a.ts", line: 12, character: 7, text: "const out = parse(raw)" },
    ]);
    expect(out).toBe("1 result for references to `parse`:\nsrc/a.ts:12:7  const out = parse(raw)");
  });

  it("renders a bare location when there is no text (an unreadable source file)", () => {
    const out = renderLocations("definition of `x`", [{ path: "src/a.ts", line: 1, character: 1 }]);
    expect(out).toContain("src/a.ts:1:1");
    expect(out).not.toContain("  "); // no dangling separator with nothing after it
  });

  it("reports an empty answer as an explicit no-results line", () => {
    expect(renderLocations("references to `x`", [])).toBe("No results for references to `x`.");
  });

  it("caps the rendered set while the header keeps the FULL count", () => {
    const many: RenderedLocation[] = Array.from({ length: MAX_RENDERED_LOCATIONS + 3 }, (_, i) => ({
      path: "src/a.ts",
      line: i + 1,
      character: 1,
    }));
    const out = renderLocations("references to `x`", many);
    expect(out).toContain(`${String(MAX_RENDERED_LOCATIONS + 3)} results for`);
    expect(out).toContain("…[3 more results truncated]");
    expect(out.split("\n")).toHaveLength(MAX_RENDERED_LOCATIONS + 2); // header + capped rows + note
  });
});

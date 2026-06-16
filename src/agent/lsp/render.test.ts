// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { Diagnostic } from "./client.js";
import { MAX_RENDERED_DIAGNOSTICS, renderDiagnostics } from "./render.js";

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

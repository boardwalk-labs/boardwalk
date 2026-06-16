// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { EngineError } from "../../errors.js";
import type { Diagnostic, FileDiagnostics, LspService } from "../lsp/index.js";
import { diagnosticsTool } from "./diagnostics.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

function ws(): string {
  const dir = mkdtempSync(join(tmpdir(), "bw-diag-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A minimal LspService double — only the methods the tool calls. */
function fakeLsp(opts: {
  diagnostics?: Diagnostic[];
  available?: boolean;
  files?: string[];
}): LspService {
  const result: FileDiagnostics = {
    available: opts.available ?? true,
    diagnostics: opts.diagnostics ?? [],
  };
  const stub = {
    supports: () => result.available,
    diagnostics: () => Promise.resolve(result),
    filesWithDiagnostics: () => opts.files ?? [],
  };
  return stub as unknown as LspService;
}

describe("diagnostics tool", () => {
  it("returns rendered diagnostics for a workspace file", async () => {
    const dir = ws();
    writeFileSync(join(dir, "a.ts"), "oops;\n");
    const tool = diagnosticsTool(
      dir,
      fakeLsp({ diagnostics: [{ line: 1, severity: "error", message: "Cannot find 'oops'." }] }),
    );
    const out = await tool.execute({ path: "a.ts" });
    expect(out).toContain("error a.ts:1 Cannot find 'oops'.");
  });

  it("reports a clean note when there are no diagnostics", async () => {
    const dir = ws();
    writeFileSync(join(dir, "ok.ts"), "export const x = 1;\n");
    const tool = diagnosticsTool(dir, fakeLsp({ diagnostics: [] }));
    expect(await tool.execute({ path: "ok.ts" })).toBe("No diagnostics for ok.ts.");
  });

  it("degrades cleanly when no language server is available (never an error)", async () => {
    const dir = ws();
    writeFileSync(join(dir, "a.ts"), "x\n");
    const tool = diagnosticsTool(dir, fakeLsp({ available: false }));
    expect(await tool.execute({ path: "a.ts" })).toBe(
      "No language server available for a.ts — diagnostics skipped.",
    );
  });

  it("lists the workspace files with diagnostics when workspace: true", async () => {
    const dir = ws();
    writeFileSync(join(dir, "a.ts"), "x\n");
    const tool = diagnosticsTool(
      dir,
      fakeLsp({ files: [pathToFileURL(join(dir, "broken.ts")).href] }),
    );
    const out = await tool.execute({ path: "a.ts", workspace: true });
    expect(out).toContain("Files with diagnostics:");
    expect(out).toContain("broken.ts");
    expect(out).not.toContain(dir); // workspace-relative only — the data dir never leaks
  });

  it("is confined to the workspace and rejects a missing file", async () => {
    const dir = ws();
    const tool = diagnosticsTool(dir, fakeLsp({}));
    await expect(tool.execute({ path: "../escape.ts" })).rejects.toThrow(/escapes the workspace/);
    await expect(tool.execute({ path: "nope.ts" })).rejects.toThrow(/no such file/);
  });

  it("rejects a non-string path", async () => {
    const tool = diagnosticsTool(ws(), fakeLsp({}));
    await expect(tool.execute({ path: 42 })).rejects.toThrow(EngineError);
  });
});

// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  isCommandAvailable,
  languageIdForPath,
  resolveOnPath,
  serverForPath,
  LANGUAGE_SERVERS,
} from "./registry.js";

describe("serverForPath", () => {
  it("routes every TS/JS extension to the typescript server", () => {
    for (const ext of [".ts", ".tsx", ".cts", ".mts", ".js", ".jsx", ".cjs", ".mjs"]) {
      expect(serverForPath(`/ws/file${ext}`)?.id).toBe("typescript");
    }
  });

  it("routes Python sources and stubs to pyright", () => {
    expect(serverForPath("/ws/etl.py")?.id).toBe("pyright");
    expect(serverForPath("/ws/etl.pyi")?.id).toBe("pyright");
    expect(serverForPath("/ws/Analysis.PY")?.id).toBe("pyright");
  });

  it("is case-insensitive on the extension", () => {
    expect(serverForPath("/ws/Component.TSX")?.id).toBe("typescript");
  });

  it("returns undefined for an unhandled extension or a file with none", () => {
    expect(serverForPath("/ws/notes.md")).toBeUndefined();
    expect(serverForPath("/ws/README")).toBeUndefined();
    expect(serverForPath("/ws/.gitignore")).toBeUndefined(); // a dotfile has no extension
  });
});

describe("languageIdForPath", () => {
  it("maps extensions to the LSP languageId", () => {
    const server = LANGUAGE_SERVERS[0];
    if (server === undefined) throw new Error("expected a registered server");
    expect(languageIdForPath(server, "/ws/a.ts")).toBe("typescript");
    expect(languageIdForPath(server, "/ws/a.tsx")).toBe("typescriptreact");
    expect(languageIdForPath(server, "/ws/a.jsx")).toBe("javascriptreact");
    expect(languageIdForPath(server, "/ws/a.js")).toBe("javascript");
    expect(languageIdForPath(server, "/ws/a.mjs")).toBe("javascript");
  });
});

describe("pyright settings", () => {
  /** The one registered server that configures itself; the TS server needs no settings. */
  function pyright() {
    const server = LANGUAGE_SERVERS.find((entry) => entry.id === "pyright");
    if (server === undefined) throw new Error("expected pyright to be registered");
    return server;
  }

  it("points pyright at the resolved python3, so imports resolve against the real interpreter", () => {
    const settings = pyright().settings?.();
    const python = settings?.["python"];
    // A wrong interpreter is worse than none: it reports reportMissingImports for every installed
    // package, and those diagnostics ride along on every write/edit result.
    expect(python).toMatchObject({
      pythonPath: resolveOnPath("python3") ?? resolveOnPath("python"),
    });
  });

  it("keeps analysis to open files, so a large workspace isn't type-checked on every sync", () => {
    const settings = pyright().settings?.();
    expect(settings?.["python"]).toMatchObject({
      analysis: {
        diagnosticMode: "openFilesOnly",
        typeCheckingMode: "basic",
        autoSearchPaths: true,
        useLibraryCodeForTypes: true,
      },
    });
  });

  it("omits pythonPath entirely when no interpreter resolves, rather than asserting a wrong one", () => {
    const path = process.env["PATH"];
    process.env["PATH"] = "/nonexistent-dir-for-this-test";
    try {
      const settings = pyright().settings?.();
      expect(settings?.["python"]).not.toHaveProperty("pythonPath");
    } finally {
      process.env["PATH"] = path;
    }
  });
});

describe("isCommandAvailable", () => {
  it("resolves a real command on PATH (node is always present in CI)", () => {
    expect(isCommandAvailable("node")).toBe(true);
  });

  it("reports a nonexistent command as unavailable (the best-effort gate)", () => {
    expect(isCommandAvailable("definitely-not-a-real-server-7f3a")).toBe(false);
  });

  it("checks an absolute path directly", () => {
    expect(isCommandAvailable(process.execPath)).toBe(true);
    expect(isCommandAvailable("/no/such/binary/here")).toBe(false);
  });
});

describe("resolveOnPath", () => {
  it("returns the absolute path a bare command resolves to", () => {
    const resolved = resolveOnPath("node");
    expect(resolved).toBeDefined();
    expect(resolved?.endsWith("node")).toBe(true);
  });

  it("returns undefined for an unresolvable command", () => {
    expect(resolveOnPath("definitely-not-a-real-server-7f3a")).toBeUndefined();
    expect(resolveOnPath("/no/such/binary/here")).toBeUndefined();
  });
});

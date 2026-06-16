// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  isCommandAvailable,
  languageIdForPath,
  serverForPath,
  LANGUAGE_SERVERS,
} from "./registry.js";

describe("serverForPath", () => {
  it("routes every TS/JS extension to the typescript server", () => {
    for (const ext of [".ts", ".tsx", ".cts", ".mts", ".js", ".jsx", ".cjs", ".mjs"]) {
      expect(serverForPath(`/ws/file${ext}`)?.id).toBe("typescript");
    }
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

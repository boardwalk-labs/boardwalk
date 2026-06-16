// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { EngineError } from "../../errors.js";
import type { ToolHost } from "./host_tools.js";
import { ALL_BUILTIN_NAMES, READ_ONLY_BUILTIN_NAMES, selectBuiltins } from "./registry.js";

const WS = "/tmp/ws-not-touched"; // selection never touches the filesystem
const fullHost: ToolHost = {
  fetchUrl: () =>
    Promise.resolve({ status: 200, contentType: undefined, body: "", truncated: false }),
  webSearch: () => Promise.resolve([]),
  writeArtifact: () => Promise.resolve({ id: "1", name: "n", url: "u" }),
  lsp: () => Promise.resolve("ok"),
};

function names(
  builtins: Parameters<typeof selectBuiltins>[0],
  host: ToolHost | undefined,
): string[] {
  return selectBuiltins(builtins, { workspaceDir: WS, host })
    .map((t) => t.name)
    .sort();
}

describe("selectBuiltins", () => {
  it('defaults to "all" — every sandbox built-in (no host ⇒ no host-backed tools)', () => {
    expect(names(undefined, undefined)).toEqual(
      ["apply_patch", "bash", "edit", "glob", "grep", "ls", "read", "write"].sort(),
    );
  });

  it('"all" with a full host includes the host-backed tools too', () => {
    expect(names("all", fullHost).sort()).toEqual([...ALL_BUILTIN_NAMES].sort());
  });

  it('"none" selects nothing', () => {
    expect(names("none", fullHost)).toEqual([]);
  });

  it('"read-only" is the non-mutating set (present ones only)', () => {
    // With a full host, all read-only names resolve.
    expect(names("read-only", fullHost)).toEqual([...READ_ONLY_BUILTIN_NAMES].sort());
    // Without a host, the host-backed read-only tools drop out, sandbox ones remain.
    expect(names("read-only", undefined)).toEqual(["glob", "grep", "ls", "read"].sort());
    // It never includes a mutating tool.
    for (const mutating of ["write", "edit", "apply_patch", "bash", "artifacts"]) {
      expect(names("read-only", fullHost)).not.toContain(mutating);
    }
  });

  it("an explicit subset selects exactly those", () => {
    expect(names(["read", "bash"], undefined)).toEqual(["bash", "read"]);
  });

  it("an explicit UNKNOWN name fails loudly (UNSUPPORTED)", () => {
    expect(() =>
      selectBuiltins(["definitely_not_a_tool"], { workspaceDir: WS, host: undefined }),
    ).toThrow(/not available on this engine/);
    try {
      selectBuiltins(["nope"], { workspaceDir: WS, host: undefined });
    } catch (err) {
      expect(err).toBeInstanceOf(EngineError);
      expect(err instanceof EngineError ? err.code : "").toBe("UNSUPPORTED");
    }
  });

  it("an explicit host-backed name WITHOUT a backend fails loudly with a backend-specific hint", () => {
    try {
      selectBuiltins(["web_search"], { workspaceDir: WS, host: undefined });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(EngineError);
      expect(err instanceof EngineError ? (err.hint ?? "") : "").toContain("no backend configured");
    }
  });
});

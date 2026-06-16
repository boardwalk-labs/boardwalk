// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { EngineError } from "../../errors.js";
import { LspService } from "../lsp/index.js";
import type { ToolHost } from "./host_tools.js";
import {
  ALL_BUILTIN_NAMES,
  READ_ONLY_BUILTIN_NAMES,
  selectBuiltins,
  subagentSelected,
} from "./registry.js";

const WS = "/tmp/ws-not-touched"; // selection never touches the filesystem
const fullHost: ToolHost = {
  fetchUrl: () =>
    Promise.resolve({ status: 200, contentType: undefined, body: "", truncated: false }),
  webSearch: () => Promise.resolve([]),
  writeArtifact: () => Promise.resolve({ id: "1", name: "n", url: "u" }),
};

// Selection never spawns anything; a bare LspService is enough to make `diagnostics` available.
const lspService = new LspService({ workspaceDir: WS, isAvailable: () => false });

function names(
  builtins: Parameters<typeof selectBuiltins>[0],
  host: ToolHost | undefined,
): string[] {
  return selectBuiltins(builtins, { workspaceDir: WS, host, lspService })
    .map((t) => t.name)
    .sort();
}

/** Names with NO LspService wired — the `diagnostics` built-in must be absent. */
function namesNoLsp(builtins: Parameters<typeof selectBuiltins>[0]): string[] {
  return selectBuiltins(builtins, { workspaceDir: WS, host: undefined, lspService: undefined })
    .map((t) => t.name)
    .sort();
}

describe("selectBuiltins", () => {
  it('defaults to "all" — sandbox built-ins + engine-native diagnostics (no host ⇒ no host-backed tools)', () => {
    expect(names(undefined, undefined)).toEqual(
      ["apply_patch", "bash", "diagnostics", "edit", "glob", "grep", "ls", "read", "write"].sort(),
    );
  });

  it('"all" with a full host + LSP service includes the host-backed tools too', () => {
    expect(names("all", fullHost).sort()).toEqual([...ALL_BUILTIN_NAMES].sort());
  });

  it("the engine-native diagnostics tool is omitted when the run has no LspService", () => {
    expect(namesNoLsp("all")).not.toContain("diagnostics");
    expect(namesNoLsp("all")).toEqual(
      ["apply_patch", "bash", "edit", "glob", "grep", "ls", "read", "write"].sort(),
    );
  });

  it('"none" selects nothing', () => {
    expect(names("none", fullHost)).toEqual([]);
  });

  it('"read-only" is the non-mutating set (present ones only)', () => {
    // With a full host + LSP service, all read-only names resolve.
    expect(names("read-only", fullHost)).toEqual([...READ_ONLY_BUILTIN_NAMES].sort());
    // Without a host (but with the LSP service), the host-backed read-only tools drop out; the
    // sandbox ones plus the engine-native diagnostics remain.
    expect(names("read-only", undefined)).toEqual(
      ["diagnostics", "glob", "grep", "ls", "read"].sort(),
    );
    // It never includes a mutating tool.
    for (const mutating of ["write", "edit", "apply_patch", "bash", "artifacts"]) {
      expect(names("read-only", fullHost)).not.toContain(mutating);
    }
  });

  it("an explicit subset selects exactly those", () => {
    expect(names(["read", "bash"], undefined)).toEqual(["bash", "read"]);
  });

  it("recognizes `subagent` in an explicit list but builds no registry tool for it (leaf-layer)", () => {
    // `subagent` is assembled by the leaf layer (it needs io.forkLeaf); the registry only accepts
    // the name (no UNSUPPORTED) and produces nothing for it.
    expect(names(["read", "subagent"], undefined)).toEqual(["read"]);
    expect(names(["subagent"], undefined)).toEqual([]);
  });

  it("an explicit UNKNOWN name fails loudly (UNSUPPORTED)", () => {
    expect(() =>
      selectBuiltins(["definitely_not_a_tool"], {
        workspaceDir: WS,
        host: undefined,
        lspService,
      }),
    ).toThrow(/not available on this engine/);
    try {
      selectBuiltins(["nope"], { workspaceDir: WS, host: undefined, lspService });
    } catch (err) {
      expect(err).toBeInstanceOf(EngineError);
      expect(err instanceof EngineError ? err.code : "").toBe("UNSUPPORTED");
    }
  });

  it("an explicit host-backed name WITHOUT a backend fails loudly with a backend-specific hint", () => {
    try {
      selectBuiltins(["web_search"], { workspaceDir: WS, host: undefined, lspService });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(EngineError);
      expect(err instanceof EngineError ? (err.hint ?? "") : "").toContain("no backend configured");
    }
  });
});

describe("subagentSelected", () => {
  it('is default-on under "all"/undefined, off for "none"/"read-only"', () => {
    expect(subagentSelected(undefined)).toBe(true);
    expect(subagentSelected("all")).toBe(true);
    expect(subagentSelected("none")).toBe(false);
    expect(subagentSelected("read-only")).toBe(false);
  });

  it("under an explicit list, only when `subagent` is named", () => {
    expect(subagentSelected(["read", "bash"])).toBe(false);
    expect(subagentSelected(["read", "subagent"])).toBe(true);
    expect(subagentSelected([])).toBe(false);
  });
});

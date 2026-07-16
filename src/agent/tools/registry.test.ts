// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { EngineError } from "../../errors.js";
import { LspService } from "../lsp/index.js";
import type { ToolHost } from "./host_tools.js";
import {
  ALL_BUILTIN_NAMES,
  READ_ONLY_BUILTIN_NAMES,
  runCodeSelected,
  selectBuiltins,
  subagentSelected,
} from "./registry.js";

const WS = "/tmp/ws-not-touched"; // selection never touches the filesystem
const fullHost: ToolHost = {
  fetchUrl: () =>
    Promise.resolve({ status: 200, contentType: undefined, body: "", truncated: false }),
  httpRequest: () =>
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
      [
        "apply_patch",
        "bash",
        "clock",
        "diagnostics",
        "edit",
        "glob",
        "grep",
        "ls",
        "read",
        "todo",
        "write",
      ].sort(),
    );
  });

  it('"all" with a full host + LSP service includes the host-backed tools too', () => {
    expect(names("all", fullHost).sort()).toEqual([...ALL_BUILTIN_NAMES].sort());
  });

  it("the engine-native diagnostics tool is omitted when the run has no LspService", () => {
    expect(namesNoLsp("all")).not.toContain("diagnostics");
    expect(namesNoLsp("all")).toEqual(
      [
        "apply_patch",
        "bash",
        "clock",
        "edit",
        "glob",
        "grep",
        "ls",
        "read",
        "todo",
        "write",
      ].sort(),
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
      ["clock", "diagnostics", "glob", "grep", "ls", "read", "todo"].sort(),
    );
    // It never includes a mutating tool (http can POST/DELETE, so it's excluded too).
    for (const mutating of ["write", "edit", "apply_patch", "bash", "artifacts", "http"]) {
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

  it("recognizes `run_code` in an explicit list but builds no registry tool for it (leaf-layer)", () => {
    // Like `subagent`, `run_code` is assembled by the leaf layer (it needs the resolved tool set).
    expect(names(["read", "run_code"], undefined)).toEqual(["read"]);
    expect(names(["run_code"], undefined)).toEqual([]);
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

describe("selectBuiltins — type-invalid `builtins` (untrusted runtime input)", () => {
  /** Select with a value the TS types forbid, as an untyped author program would pass. */
  function reject(builtins: unknown): EngineError {
    try {
      selectBuiltins(builtins as Parameters<typeof selectBuiltins>[0], {
        workspaceDir: WS,
        host: undefined,
        lspService,
      });
    } catch (err) {
      if (err instanceof EngineError) return err;
      throw new Error(`expected an EngineError, got ${String(err)}`);
    }
    throw new Error("expected selectBuiltins to throw");
  }

  it("rejects a bare built-in name and points at the array form, in the hint", () => {
    // `builtins: "bash"` used to iterate the string's CHARACTERS: `Built-in tool "b" is not
    // available on this engine` — a true statement about a mistake the author never made.
    const err = reject("bash");
    expect(err.code).toBe("VALIDATION");
    expect(err.message).toContain("`builtins`");
    expect(err.message).toContain('a string ("bash")');
    // The fix lives in the hint (rendered beside the message), stated once.
    expect(err.hint).toContain('Did you mean `builtins: ["bash"]`?');
    expect(err.message).not.toContain("Did you mean");
  });

  it("rejects other wrong shapes without crashing on a non-iterable", () => {
    // `builtins: {}` fell through the enum checks into `for (const name of selection)`.
    expect(reject({}).message).toContain("`builtins`");
    expect(reject(123).message).toContain("a number (123)");
    expect(reject([123]).message).toContain("non-string or empty entry");
    expect(reject([null]).message).toContain("non-string or empty entry");
    expect(reject([""]).message).toContain("non-string or empty entry");
    // A near-miss that isn't a real built-in gets no "Did you mean" — only the known-built-ins list.
    expect(reject("read-onlyy").hint).not.toContain("Did you mean");
  });

  it("still accepts every legal shape", () => {
    expect(() => names(undefined, undefined)).not.toThrow();
    expect(() => names("all", undefined)).not.toThrow();
    expect(() => names("read-only", undefined)).not.toThrow();
    expect(() => names("none", undefined)).not.toThrow();
    expect(names([], undefined)).toEqual([]);
    expect(names(["read"], undefined)).toEqual(["read"]);
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

describe("runCodeSelected", () => {
  it('is default-on under "all"/undefined, off for "none"/"read-only"', () => {
    expect(runCodeSelected(undefined)).toBe(true);
    expect(runCodeSelected("all")).toBe(true);
    expect(runCodeSelected("none")).toBe(false);
    expect(runCodeSelected("read-only")).toBe(false);
  });

  it("under an explicit list, only when `run_code` is named", () => {
    expect(runCodeSelected(["read", "bash"])).toBe(false);
    expect(runCodeSelected(["read", "run_code"])).toBe(true);
    expect(runCodeSelected([])).toBe(false);
  });
});

// SPDX-License-Identifier: Apache-2.0

// The navigation result parsers. A language server is an external process, so every shape here is
// untrusted input — these cover the several wire forms the LSP permits for each method, the 0-based
// → 1-based conversion, and the degrade-don't-throw contract on junk.

import { describe, expect, it } from "vitest";
import {
  parseCallHierarchyItems,
  parseCalls,
  parseDocumentSymbols,
  parseHover,
  parseLocations,
  parseWorkspaceSymbols,
  symbolKindName,
} from "./navigation.js";

/** An LSP range at 0-based line/character, as a server sends it. */
function range(line: number, character: number) {
  return { start: { line, character }, end: { line, character: character + 4 } };
}

describe("parseLocations", () => {
  it("parses a bare Location, converting 0-based positions to 1-based", () => {
    const result = parseLocations({ uri: "file:///ws/a.ts", range: range(11, 6) });
    expect(result).toEqual([{ path: "/ws/a.ts", line: 12, character: 7 }]);
  });

  it("parses an array of Locations", () => {
    const result = parseLocations([
      { uri: "file:///ws/a.ts", range: range(0, 0) },
      { uri: "file:///ws/b.ts", range: range(4, 2) },
    ]);
    expect(result).toEqual([
      { path: "/ws/a.ts", line: 1, character: 1 },
      { path: "/ws/b.ts", line: 5, character: 3 },
    ]);
  });

  it("parses LocationLink, preferring targetSelectionRange (the name) over targetRange (the body)", () => {
    const result = parseLocations([
      {
        targetUri: "file:///ws/a.ts",
        targetRange: range(10, 0),
        targetSelectionRange: range(11, 16),
      },
    ]);
    expect(result).toEqual([{ path: "/ws/a.ts", line: 12, character: 17 }]);
  });

  it("falls back to targetRange when a LocationLink omits the selection range", () => {
    const result = parseLocations([{ targetUri: "file:///ws/a.ts", targetRange: range(3, 1) }]);
    expect(result).toEqual([{ path: "/ws/a.ts", line: 4, character: 2 }]);
  });

  it("keeps the good entries when one element is malformed", () => {
    const result = parseLocations([
      { uri: "file:///ws/a.ts", range: range(0, 0) },
      { uri: "file:///ws/b.ts" }, // no range
      "not an object",
      { uri: "file:///ws/c.ts", range: range(2, 0) },
    ]);
    expect(result.map((entry) => entry.path)).toEqual(["/ws/a.ts", "/ws/c.ts"]);
  });

  it("returns [] for null and for junk (the server answering 'nothing')", () => {
    expect(parseLocations(null)).toEqual([]);
    expect(parseLocations(undefined)).toEqual([]);
    expect(parseLocations(42)).toEqual([]);
    expect(parseLocations({ nope: true })).toEqual([]);
  });

  it("decodes a percent-encoded URI back to a path", () => {
    const result = parseLocations({ uri: "file:///ws/my%20dir/a.ts", range: range(0, 0) });
    expect(result[0]?.path).toBe("/ws/my dir/a.ts");
  });
});

describe("parseDocumentSymbols", () => {
  it("flattens the hierarchical form depth-first, tagging children with their container", () => {
    const result = parseDocumentSymbols(
      [
        {
          name: "Parser",
          kind: 5,
          range: range(0, 0),
          selectionRange: range(0, 6),
          children: [
            { name: "parse", kind: 6, range: range(1, 2), selectionRange: range(1, 4) },
            { name: "reset", kind: 6, range: range(5, 2), selectionRange: range(5, 4) },
          ],
        },
      ],
      "/ws/a.ts",
    );
    expect(result).toEqual([
      { name: "Parser", kind: "class", location: { path: "/ws/a.ts", line: 1, character: 7 } },
      {
        name: "parse",
        kind: "method",
        location: { path: "/ws/a.ts", line: 2, character: 5 },
        container: "Parser",
      },
      {
        name: "reset",
        kind: "method",
        location: { path: "/ws/a.ts", line: 6, character: 5 },
        container: "Parser",
      },
    ]);
  });

  it("uses selectionRange (the identifier), not range (the whole declaration)", () => {
    const result = parseDocumentSymbols(
      [{ name: "parse", kind: 12, range: range(10, 0), selectionRange: range(10, 9) }],
      "/ws/a.ts",
    );
    expect(result[0]?.location).toEqual({ path: "/ws/a.ts", line: 11, character: 10 });
  });

  it("also accepts the flat SymbolInformation form some servers answer with", () => {
    const result = parseDocumentSymbols(
      [
        {
          name: "parse",
          kind: 12,
          location: { uri: "file:///ws/a.ts", range: range(7, 2) },
          containerName: "module",
        },
      ],
      "/ws/a.ts",
    );
    expect(result).toEqual([
      {
        name: "parse",
        kind: "function",
        location: { path: "/ws/a.ts", line: 8, character: 3 },
        container: "module",
      },
    ]);
  });

  it("returns [] for a non-array result", () => {
    expect(parseDocumentSymbols(null, "/ws/a.ts")).toEqual([]);
  });
});

describe("parseWorkspaceSymbols", () => {
  it("parses symbols carrying a full Location", () => {
    const result = parseWorkspaceSymbols([
      { name: "parse", kind: 12, location: { uri: "file:///ws/a.ts", range: range(3, 5) } },
    ]);
    expect(result).toEqual([
      { name: "parse", kind: "function", location: { path: "/ws/a.ts", line: 4, character: 6 } },
    ]);
  });

  it("accepts the lazy { uri } location form, defaulting to the top of the file", () => {
    // The union must try the full Location FIRST; if it matched { uri } first it would strip the
    // range and report every symbol at 1:1, which is what this pins.
    const result = parseWorkspaceSymbols([
      { name: "Parser", kind: 5, location: { uri: "file:///ws/b.ts" } },
    ]);
    expect(result).toEqual([
      { name: "Parser", kind: "class", location: { path: "/ws/b.ts", line: 1, character: 1 } },
    ]);
  });

  it("omits an empty containerName rather than rendering a dangling dot", () => {
    const result = parseWorkspaceSymbols([
      {
        name: "parse",
        kind: 12,
        location: { uri: "file:///ws/a.ts", range: range(0, 0) },
        containerName: "",
      },
    ]);
    expect(result[0]).not.toHaveProperty("container");
  });
});

describe("parseCallHierarchyItems", () => {
  const item = {
    name: "parse",
    kind: 12,
    uri: "file:///ws/a.ts",
    range: range(10, 0),
    selectionRange: range(10, 9),
    data: { serverPrivate: "token" },
  };

  it("keeps the RAW item, which the follow-up request must echo back verbatim", () => {
    const parsed = parseCallHierarchyItems([item]);
    // The server-private `data` field is how some servers correlate the second call; rebuilding the
    // item from our narrowed shape would drop it and the follow-up would return nothing.
    expect(parsed[0]?.raw).toBe(item);
  });

  it("parses the display shape alongside the raw item", () => {
    const parsed = parseCallHierarchyItems([item]);
    expect(parsed[0]?.symbol).toEqual({
      name: "parse",
      kind: "function",
      location: { path: "/ws/a.ts", line: 11, character: 10 },
    });
  });

  it("returns [] for a non-array result", () => {
    expect(parseCallHierarchyItems(null)).toEqual([]);
  });
});

describe("parseCalls", () => {
  const caller = {
    name: "main",
    kind: 12,
    uri: "file:///ws/main.ts",
    range: range(2, 0),
    selectionRange: range(2, 9),
  };

  it("reads `from` for incoming calls and `to` for outgoing", () => {
    expect(parseCalls([{ from: caller, fromRanges: [] }], "incoming")).toEqual([
      { name: "main", kind: "function", location: { path: "/ws/main.ts", line: 3, character: 10 } },
    ]);
    expect(parseCalls([{ to: caller, fromRanges: [] }], "outgoing")).toEqual([
      { name: "main", kind: "function", location: { path: "/ws/main.ts", line: 3, character: 10 } },
    ]);
  });

  it("ignores an edge carrying the other direction's key", () => {
    expect(parseCalls([{ to: caller }], "incoming")).toEqual([]);
  });
});

describe("parseHover", () => {
  it("parses MarkupContent", () => {
    expect(parseHover({ contents: { kind: "markdown", value: "```ts\nparse(): void\n```" } })).toBe(
      "```ts\nparse(): void\n```",
    );
  });

  it("parses a bare string and a legacy MarkedString object", () => {
    expect(parseHover({ contents: "function parse(): void" })).toBe("function parse(): void");
    expect(parseHover({ contents: { language: "ts", value: "parse(): void" } })).toBe(
      "parse(): void",
    );
  });

  it("joins an array of MarkedStrings, dropping blank segments", () => {
    expect(parseHover({ contents: ["function parse(): void", "   ", "Parses the input."] })).toBe(
      "function parse(): void\n\nParses the input.",
    );
  });

  it("returns null when the server has nothing to say", () => {
    expect(parseHover(null)).toBeNull();
    expect(parseHover({ contents: "" })).toBeNull();
    expect(parseHover({ contents: [] })).toBeNull();
    expect(parseHover({ nope: true })).toBeNull();
  });
});

describe("symbolKindName", () => {
  it("names the kinds a coding agent actually sees", () => {
    expect(symbolKindName(5)).toBe("class");
    expect(symbolKindName(6)).toBe("method");
    expect(symbolKindName(12)).toBe("function");
    expect(symbolKindName(13)).toBe("variable");
  });

  it("degrades to a neutral label for an unknown or future kind", () => {
    expect(symbolKindName(99)).toBe("symbol");
    expect(symbolKindName(0)).toBe("symbol");
  });
});

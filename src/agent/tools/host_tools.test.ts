// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { hostBackedTools, type ToolHost } from "./host_tools.js";

function get(host: ToolHost | undefined, name: string) {
  const tool = hostBackedTools(host).get(name);
  if (tool === undefined) throw new Error(`expected tool ${name}`);
  return tool;
}

describe("hostBackedTools — registration follows backend presence", () => {
  it("registers only the tools whose hooks the host supplies", () => {
    expect([...hostBackedTools(undefined).keys()]).toEqual([]);
    expect([...hostBackedTools({ fetchUrl: () => Promise.reject(new Error()) }).keys()]).toEqual([
      "webfetch",
    ]);
    const full: ToolHost = {
      fetchUrl: () =>
        Promise.resolve({ status: 200, contentType: "x", body: "", truncated: false }),
      webSearch: () => Promise.resolve([]),
      writeArtifact: () => Promise.resolve({ id: "1", name: "n", url: "u" }),
      lsp: () => Promise.resolve("ok"),
    };
    expect([...hostBackedTools(full).keys()].sort()).toEqual(
      ["artifacts", "lsp", "web_search", "webfetch"].sort(),
    );
  });
});

describe("webfetch", () => {
  it("renders status, content-type, body and a truncation note", async () => {
    const tool = get(
      {
        fetchUrl: () =>
          Promise.resolve({ status: 200, contentType: "text/html", body: "<p>", truncated: true }),
      },
      "webfetch",
    );
    const out = await tool.execute({ url: "https://example.com" });
    expect(out).toContain("[HTTP 200 text/html]");
    expect(out).toContain("<p>");
    expect(out).toContain("response truncated");
  });

  it("passes maxBytes through to the backend", async () => {
    let seen: number | undefined;
    const tool = get(
      {
        fetchUrl: (_url, opts) => {
          seen = opts?.maxBytes;
          return Promise.resolve({
            status: 200,
            contentType: undefined,
            body: "",
            truncated: false,
          });
        },
      },
      "webfetch",
    );
    await tool.execute({ url: "https://x", maxBytes: 99 });
    expect(seen).toBe(99);
  });
});

describe("web_search", () => {
  it("formats ranked results and handles empty", async () => {
    const tool = get(
      {
        webSearch: () => Promise.resolve([{ title: "T", url: "https://u", snippet: "snip" }]),
      },
      "web_search",
    );
    const out = await tool.execute({ query: "q" });
    expect(out).toContain("1. T");
    expect(out).toContain("https://u");
    expect(out).toContain("snip");

    const empty = get({ webSearch: () => Promise.resolve([]) }, "web_search");
    expect(await empty.execute({ query: "q" })).toBe("(no results)");
  });
});

describe("artifacts", () => {
  it("writes and reads through the backend", async () => {
    const stored = new Map<string, string>();
    const tool = get(
      {
        writeArtifact: (name, _ct, body) => {
          stored.set(name, body);
          return Promise.resolve({ id: "a1", name, url: `file://${name}` });
        },
        readArtifact: (name) => Promise.resolve(stored.get(name) ?? ""),
      },
      "artifacts",
    );
    const wrote = await tool.execute({ action: "write", name: "out.txt", content: "data" });
    expect(wrote).toContain("file://out.txt");
    const read = await tool.execute({ action: "read", name: "out.txt" });
    expect(read).toBe("data");
  });

  it("read fails loudly when the backend supports no reads", async () => {
    const tool = get(
      { writeArtifact: () => Promise.resolve({ id: "1", name: "n", url: "u" }) },
      "artifacts",
    );
    await expect(tool.execute({ action: "read", name: "x" })).rejects.toThrow(
      /does not support reading/,
    );
  });

  it("rejects an unknown action", async () => {
    const tool = get(
      { writeArtifact: () => Promise.resolve({ id: "1", name: "n", url: "u" }) },
      "artifacts",
    );
    await expect(tool.execute({ action: "delete", name: "x" })).rejects.toThrow(/unknown action/);
  });
});

describe("lsp", () => {
  it("forwards the request to the backend", async () => {
    let seen: unknown;
    const tool = get(
      {
        lsp: (req) => {
          seen = req;
          return Promise.resolve("symbols: foo, bar");
        },
      },
      "lsp",
    );
    const out = await tool.execute({ action: "symbols", path: "a.ts", query: "foo" });
    expect(out).toContain("symbols: foo, bar");
    expect(seen).toEqual({ action: "symbols", path: "a.ts", query: "foo" });
  });
});

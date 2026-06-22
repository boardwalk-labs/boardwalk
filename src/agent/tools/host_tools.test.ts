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
    expect([...hostBackedTools({ httpRequest: () => Promise.reject(new Error()) }).keys()]).toEqual(
      ["http"],
    );
    const full: ToolHost = {
      fetchUrl: () =>
        Promise.resolve({ status: 200, contentType: "x", body: "", truncated: false }),
      httpRequest: () =>
        Promise.resolve({ status: 200, contentType: "x", body: "", truncated: false }),
      webSearch: () => Promise.resolve([]),
      writeArtifact: () => Promise.resolve({ id: "1", name: "n", url: "u" }),
    };
    expect([...hostBackedTools(full).keys()].sort()).toEqual(
      ["artifacts", "http", "web_search", "webfetch"].sort(),
    );
  });
});

describe("http", () => {
  it("forwards method/headers/body to the backend and renders the response", async () => {
    let seen: { req: unknown; maxBytes: number | undefined } | undefined;
    const tool = get(
      {
        httpRequest: (req, opts) => {
          seen = { req, maxBytes: opts?.maxBytes };
          return Promise.resolve({
            status: 201,
            contentType: "application/json",
            body: '{"ok":true}',
            truncated: false,
          });
        },
      },
      "http",
    );
    const out = await tool.execute({
      url: "https://api.example.com/things",
      method: "post",
      headers: { "content-type": "application/json" },
      body: '{"name":"x"}',
      maxBytes: 1024,
    });
    expect(seen?.req).toEqual({
      url: "https://api.example.com/things",
      method: "POST", // normalized to upper-case
      headers: { "content-type": "application/json" },
      body: '{"name":"x"}',
    });
    expect(seen?.maxBytes).toBe(1024);
    expect(out).toContain("[HTTP 201 application/json]");
    expect(out).toContain('{"ok":true}');
  });

  it("defaults to GET (no method passed to the backend) and notes truncation", async () => {
    let method: string | undefined = "UNSET";
    const tool = get(
      {
        httpRequest: (req) => {
          method = req.method;
          return Promise.resolve({
            status: 200,
            contentType: undefined,
            body: "hi",
            truncated: true,
          });
        },
      },
      "http",
    );
    const out = await tool.execute({ url: "https://x" });
    expect(method).toBeUndefined(); // omitted ⇒ the backend defaults GET
    expect(out).toContain("[HTTP 200]");
    expect(out).toContain("response truncated");
  });

  it("rejects an unsupported method before calling the backend", async () => {
    let called = false;
    const tool = get(
      {
        httpRequest: () => {
          called = true;
          return Promise.resolve({
            status: 200,
            contentType: undefined,
            body: "",
            truncated: false,
          });
        },
      },
      "http",
    );
    await expect(tool.execute({ url: "https://x", method: "TRACE" })).rejects.toThrow(
      /unsupported method/,
    );
    expect(called).toBe(false);
  });

  it("rejects non-string header values", async () => {
    const tool = get({ httpRequest: () => Promise.reject(new Error("should not run")) }, "http");
    await expect(tool.execute({ url: "https://x", headers: { a: 1 } })).rejects.toThrow(
      /must be a string/,
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

// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import { EngineError } from "../errors.js";
import { runWebSearch } from "./web_search.js";

const env = (overrides: Record<string, string>) => (name: string) => overrides[name];

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runWebSearch — fail-closed without configuration", () => {
  it("throws an UNSUPPORTED error naming the env vars when no provider is configured", async () => {
    const err: unknown = await runWebSearch("q", undefined, env({})).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EngineError);
    expect(err instanceof EngineError ? err.code : "").toBe("UNSUPPORTED");
    expect(err instanceof EngineError ? (err.hint ?? "") : "").toContain("BOARDWALK_SEARCH_URL");
  });

  it("also fails closed when only the URL (and not the key) is set", async () => {
    await expect(
      runWebSearch("q", undefined, env({ BOARDWALK_SEARCH_URL: "https://search" })),
    ).rejects.toThrow(/no provider configured/);
  });
});

describe("runWebSearch — configured provider", () => {
  it("parses the tavily response shape (content → snippet)", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        Response.json({ results: [{ title: "Doc", url: "https://d", content: "body text" }] }),
      );
    const results = await runWebSearch(
      "query",
      3,
      env({ BOARDWALK_SEARCH_URL: "https://search", BOARDWALK_SEARCH_API_KEY: "k" }),
    );
    expect(results).toEqual([{ title: "Doc", url: "https://d", snippet: "body text" }]);
    // The tavily shape posts api_key + query + max_results in the body.
    const body = fetchMock.mock.calls[0]?.[1]?.body;
    expect(typeof body === "string" ? body : "").toContain('"max_results":3');
    expect(typeof body === "string" ? body : "").toContain('"api_key":"k"');
  });

  it("parses the openai response shape with a Bearer header", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        Response.json({ results: [{ title: "T", url: "https://u", snippet: "s" }] }),
      );
    const results = await runWebSearch(
      "q",
      undefined,
      env({
        BOARDWALK_SEARCH_URL: "https://search",
        BOARDWALK_SEARCH_API_KEY: "secret-key",
        BOARDWALK_SEARCH_FORMAT: "openai",
      }),
    );
    expect(results).toEqual([{ title: "T", url: "https://u", snippet: "s" }]);
    const headers = fetchMock.mock.calls[0]?.[1]?.headers;
    expect(headers && "authorization" in headers ? headers.authorization : "").toBe(
      "Bearer secret-key",
    );
  });

  it("surfaces a provider error on a non-2xx response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 500 }));
    await expect(
      runWebSearch(
        "q",
        undefined,
        env({ BOARDWALK_SEARCH_URL: "u", BOARDWALK_SEARCH_API_KEY: "k" }),
      ),
    ).rejects.toThrow(/returned 500/);
  });
});

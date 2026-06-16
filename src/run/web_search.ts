// SPDX-License-Identifier: Apache-2.0

// The single-node engine's default `web_search` backend. The engine doesn't bundle a search
// index; it forwards to a provider the operator configures by environment variable, fail-closed
// with an actionable error when none is set. Zero new dependencies — a plain `fetch` of a JSON
// search API.
//
// Configuration (env, `BOARDWALK_` prefixed like the rest of §2.5):
//   BOARDWALK_SEARCH_URL      — the search API endpoint (a JSON POST API). REQUIRED to enable search.
//   BOARDWALK_SEARCH_API_KEY  — the bearer token / API key for that endpoint. REQUIRED.
//   BOARDWALK_SEARCH_FORMAT   — "tavily" (default) | "openai". The response shape to parse.
//
// "tavily": POST `{ api_key, query, max_results }`, response `{ results: [{ title, url, content }] }`.
// "openai": POST `{ query, max_results }` with `Authorization: Bearer`, response
//           `{ results: [{ title, url, snippet }] }` — a generic shape for an OpenAI-compatible
//           search proxy or a self-hosted endpoint.
//
// The hosted platform supplies its own broker-backed web_search and never reaches this file.

import { z } from "zod";
import { EngineError } from "../errors.js";

export interface SearchResult {
  title: string;
  url: string;
  snippet?: string;
}

type GetEnv = (name: string) => string | undefined;

const tavilyResponseSchema = z.object({
  results: z
    .array(
      z.object({
        title: z.string().default(""),
        url: z.string().default(""),
        content: z.string().optional(),
      }),
    )
    .default([]),
});

const genericResponseSchema = z.object({
  results: z
    .array(
      z.object({
        title: z.string().default(""),
        url: z.string().default(""),
        snippet: z.string().optional(),
      }),
    )
    .default([]),
});

/**
 * Run a web search through the engine's configured provider. With no provider configured this
 * FAILS CLOSED with a clear setup hint — the tool is advertised (the backend hook exists), but a
 * call without configuration is a loud error, not a silent empty result, so the gap is obvious.
 */
export async function runWebSearch(
  query: string,
  limit: number | undefined,
  getEnv: GetEnv,
): Promise<SearchResult[]> {
  const url = getEnv("BOARDWALK_SEARCH_URL");
  const apiKey = getEnv("BOARDWALK_SEARCH_API_KEY");
  if (url === undefined || url.length === 0 || apiKey === undefined || apiKey.length === 0) {
    throw new EngineError(
      "UNSUPPORTED",
      "web_search has no provider configured on this engine.",
      "Set BOARDWALK_SEARCH_URL and BOARDWALK_SEARCH_API_KEY (and optionally " +
        "BOARDWALK_SEARCH_FORMAT=tavily|openai) to enable the web_search built-in.",
    );
  }
  const format = (getEnv("BOARDWALK_SEARCH_FORMAT") ?? "tavily").toLowerCase();
  const maxResults = limit ?? 5;

  const response =
    format === "openai"
      ? await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ query, max_results: maxResults }),
        })
      : await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ api_key: apiKey, query, max_results: maxResults }),
        });

  if (!response.ok) {
    throw new EngineError(
      "PROVIDER_ERROR",
      `web_search provider returned ${String(response.status)}.`,
    );
  }
  const json: unknown = await response.json();
  if (format === "openai") {
    const parsed = genericResponseSchema.parse(json);
    return parsed.results.slice(0, maxResults).map((r) => ({
      title: r.title,
      url: r.url,
      ...(r.snippet !== undefined ? { snippet: r.snippet } : {}),
    }));
  }
  const parsed = tavilyResponseSchema.parse(json);
  return parsed.results.slice(0, maxResults).map((r) => ({
    title: r.title,
    url: r.url,
    ...(r.content !== undefined ? { snippet: r.content } : {}),
  }));
}

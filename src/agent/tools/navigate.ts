// SPDX-License-Identifier: Apache-2.0

// The `navigate` built-in: language-server code intelligence — where a symbol is defined, who
// references it, what its type is, what a file declares, and who calls what. Where `diagnostics`
// answers "is what I just wrote correct?", this answers "what is this and what touches it?", which
// is the question `grep` only approximates: grep matches text, a language server resolves meaning
// (the right `parse` of five, not every line containing the word).
//
// ENGINE-NATIVE (the engine spawns the language server in the run's workspace) and BEST-EFFORT: a
// file with no installed server returns a short note, never an error. Read-only, so it joins the
// `"read-only"` built-in set, and confined to the workspace via containedPath like every other
// coding tool — a model-chosen path is untrusted input.

import { existsSync, readFileSync, statSync } from "node:fs";
import { EngineError } from "../../errors.js";
import type { LocationQuery, LspService, Position } from "../lsp/index.js";
import { renderLocations, type RenderedLocation, type SymbolMatch } from "../lsp/index.js";
import type { ExecutableTool } from "../tools.js";
import { containedPath, workspaceRelative } from "./sandbox.js";

/** Every operation `navigate` accepts, and what each asks the language server. */
const OPERATIONS = [
  "definition",
  "references",
  "implementations",
  "hover",
  "document_symbols",
  "workspace_symbols",
  "incoming_calls",
  "outgoing_calls",
] as const;

type Operation = (typeof OPERATIONS)[number];

/** The `navigate` operations that map straight onto a position-in, locations-out LSP query. */
const LOCATION_QUERIES: Partial<Record<Operation, LocationQuery>> = {
  definition: "definition",
  references: "references",
  implementations: "implementations",
};

/** Characters that continue an identifier, used to reject a match inside a longer word. */
const IDENTIFIER_CHAR = /[A-Za-z0-9_$]/;

/** Cap on a rendered source line — one minified file must not flood the result. */
const MAX_PREVIEW_CHARS = 200;

/** How the caller addressed a position: by symbol name, by coordinates, or by both. */
export interface PositionRequest {
  symbol?: string;
  line?: number;
  character?: number;
}

/**
 * Resolve the caller's addressing into a concrete 1-based position.
 *
 * Accepting a SYMBOL NAME (not just coordinates) is the point: an agent arrives here from `grep`
 * holding a name and at best a line, never a column, and an LSP query aimed a few characters off an
 * identifier returns nothing at all. Guessing silently would surface as "no results" — the failure
 * that reads as a broken tool. So `symbol` is resolved against the file's real text, `line` narrows
 * it when a name repeats, and an unresolvable address fails loudly with what to pass instead.
 */
export function resolvePosition(text: string, request: PositionRequest): Position {
  const lines = text.split(/\r?\n/);
  const { symbol, line, character } = request;

  if (line !== undefined && character !== undefined) {
    if (line > lines.length) {
      throw new EngineError(
        "VALIDATION",
        `navigate: line ${String(line)} is past the end of the file (${String(lines.length)} lines).`,
      );
    }
    return { line, character };
  }

  if (symbol === undefined) {
    throw new EngineError(
      "VALIDATION",
      "navigate: this operation needs a position, and none was given.",
      'Pass `symbol` (the identifier to target, e.g. `symbol: "parseConfig"`), optionally with ' +
        "`line` to disambiguate a repeated name, or both `line` and `character` for an exact position.",
    );
  }

  const candidates = line !== undefined ? [line] : lines.map((_, index) => index + 1);
  for (const candidate of candidates) {
    const lineText = lines[candidate - 1];
    if (lineText === undefined) continue;
    const column = findIdentifier(lineText, symbol);
    if (column !== null) return { line: candidate, character: column };
  }

  const where = line !== undefined ? ` on line ${String(line)}` : " in the file";
  throw new EngineError(
    "VALIDATION",
    `navigate: symbol "${symbol}" was not found${where}.`,
    "Check the spelling, or use `grep` to locate it first — `symbol` must match the identifier exactly.",
  );
}

/**
 * The 1-based column of `symbol` in `lineText` as a WHOLE identifier, or null. The boundary check is
 * what keeps a search for `parse` off the `p` in `parseConfig`; `\b` can't do it, because `$` is an
 * identifier character in JS but not a regex word character.
 */
function findIdentifier(lineText: string, symbol: string): number | null {
  for (let from = 0; from <= lineText.length - symbol.length; ) {
    const at = lineText.indexOf(symbol, from);
    if (at === -1) return null;
    const before = at === 0 ? "" : (lineText[at - 1] ?? "");
    const after = lineText[at + symbol.length] ?? "";
    if (!IDENTIFIER_CHAR.test(before) && !IDENTIFIER_CHAR.test(after)) return at + 1;
    from = at + 1;
  }
  return null;
}

export function navigateTool(workspaceDir: string, lsp: LspService): ExecutableTool {
  return {
    name: "navigate",
    description:
      "Resolve code by MEANING using the language server: jump to a definition, list references, " +
      "show a type on hover, outline a file, search symbols workspace-wide, or walk the call " +
      "hierarchy. Prefer this over `grep` for questions about a symbol — grep matches text, this " +
      "resolves the actual declaration. Target a position with `symbol` (the identifier name, " +
      "easiest) or exact `line`+`character`. Best-effort: a file with no installed language server " +
      "returns a short note, never an error.",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: [...OPERATIONS],
          description:
            "definition | references | implementations | hover | document_symbols | " +
            "workspace_symbols | incoming_calls (who calls this) | outgoing_calls (what this calls).",
        },
        path: {
          type: "string",
          description:
            "Workspace-relative file path. Required for every operation — for workspace_symbols it " +
            "selects which language's server answers.",
        },
        symbol: {
          type: "string",
          description:
            "The identifier to target, matched as a whole word. Combine with `line` when the name " +
            "appears more than once. Ignored by document_symbols and workspace_symbols.",
        },
        line: { type: "number", description: "1-based line number." },
        character: {
          type: "number",
          description: "1-based column; use with `line` for an exact position.",
        },
        query: {
          type: "string",
          description: "Symbol name or prefix to search for (workspace_symbols only).",
        },
      },
      required: ["operation", "path"],
      additionalProperties: false,
    },
    execute: async (input) => {
      const operation = requireOperation(input);
      const path = requireString(input, "path");
      const file = containedPath(workspaceDir, path);
      if (!existsSync(file) || statSync(file).isDirectory()) {
        throw new EngineError("VALIDATION", `navigate: no such file "${path}".`);
      }
      if (!lsp.supports(file)) {
        return `No language server available for ${path} — navigation skipped.`;
      }

      const relative = (absolute: string): string => workspaceRelative(workspaceDir, absolute);
      const preview = sourceLineReader();

      if (operation === "workspace_symbols") {
        const query = requireString(input, "query");
        const answer = await lsp.workspaceSymbols(file, query);
        if (!answer.answered) return stillIndexing(path);
        return renderLocations(
          `workspace symbols matching "${query}"`,
          answer.value.map(toSymbolLine(relative)),
        );
      }

      if (operation === "document_symbols") {
        const answer = await lsp.documentSymbols(file);
        if (!answer.answered) return stillIndexing(path);
        return renderLocations(`symbols in ${path}`, answer.value.map(toSymbolLine(relative)));
      }

      const position = resolvePosition(readFileSync(file, "utf8"), positionRequest(input));
      const target = describeTarget(input, path, position);

      if (operation === "hover") {
        const answer = await lsp.hover(file, position);
        if (!answer.answered) return stillIndexing(path);
        return answer.value ?? `No hover information for ${target}.`;
      }

      if (operation === "incoming_calls" || operation === "outgoing_calls") {
        const direction = operation === "incoming_calls" ? "incoming" : "outgoing";
        const answer = await lsp.calls(file, position, direction);
        if (!answer.answered) return stillIndexing(path);
        const summary =
          direction === "incoming" ? `callers of ${target}` : `calls made by ${target}`;
        return renderLocations(summary, answer.value.map(toSymbolLine(relative)));
      }

      // Everything left is a position-in, locations-out query; the map is exhaustive over them.
      const query = LOCATION_QUERIES[operation];
      if (query === undefined) {
        throw new EngineError("VALIDATION", `navigate: unsupported operation "${operation}".`);
      }
      const answer = await lsp.locations(file, query, position);
      if (!answer.answered) return stillIndexing(path);
      const rendered: RenderedLocation[] = answer.value.map((location) => {
        const text = preview(location.path, location.line);
        return {
          path: relative(location.path),
          line: location.line,
          character: location.character,
          ...(text !== undefined ? { text } : {}),
        };
      });
      return renderLocations(`${operation} of ${target}`, rendered);
    },
  };
}

/**
 * What to say when the server never answered. Crucially NOT "no results": the loop would read that
 * as "this symbol is unused" and act on it. Naming the cause tells it the query is worth repeating.
 */
function stillIndexing(path: string): string {
  return (
    `The language server did not answer in time for ${path} — it is likely still indexing the ` +
    "workspace. This is not a result: retry the same query."
  );
}

/** Render a symbol as its location plus a `kind name` label (a preview would just repeat the name). */
function toSymbolLine(
  relative: (absolute: string) => string,
): (symbol: SymbolMatch) => RenderedLocation {
  return (symbol) => ({
    path: relative(symbol.location.path),
    line: symbol.location.line,
    character: symbol.location.character,
    text: `${symbol.kind} ${symbol.container !== undefined ? `${symbol.container}.` : ""}${symbol.name}`,
  });
}

/**
 * Reads source lines for result previews, caching each file for the life of one call. References
 * commonly cluster in a handful of files, so the cache turns an N-result render into a few reads;
 * an unreadable file caches as null and renders as a bare location.
 */
function sourceLineReader(): (path: string, line: number) => string | undefined {
  const cache = new Map<string, string[] | null>();
  return (path, line) => {
    let lines = cache.get(path);
    if (lines === undefined) {
      try {
        lines = readFileSync(path, "utf8").split(/\r?\n/);
      } catch {
        lines = null;
      }
      cache.set(path, lines);
    }
    const text = lines?.[line - 1]?.trim();
    if (text === undefined || text.length === 0) return undefined;
    return text.length > MAX_PREVIEW_CHARS ? `${text.slice(0, MAX_PREVIEW_CHARS)}…` : text;
  };
}

/** How a result header names what was asked about — the symbol when given, else the coordinates. */
function describeTarget(input: Record<string, unknown>, path: string, position: Position): string {
  const symbol = input["symbol"];
  if (typeof symbol === "string" && symbol.length > 0) return `\`${symbol}\``;
  return `${path}:${String(position.line)}:${String(position.character)}`;
}

/** Narrow the position-addressing inputs. Spread-if-present because exactOptionalPropertyTypes
 *  distinguishes an absent key from an explicit `undefined`. */
function positionRequest(input: Record<string, unknown>): PositionRequest {
  const symbol = input["symbol"];
  const line = optionalPositiveInt(input["line"], "line");
  const character = optionalPositiveInt(input["character"], "character");
  return {
    ...(typeof symbol === "string" && symbol.length > 0 ? { symbol } : {}),
    ...(line !== undefined ? { line } : {}),
    ...(character !== undefined ? { character } : {}),
  };
}

function requireOperation(input: Record<string, unknown>): Operation {
  const value = input["operation"];
  const match = OPERATIONS.find((operation) => operation === value);
  if (match === undefined) {
    throw new EngineError(
      "VALIDATION",
      `navigate: \`operation\` must be one of ${OPERATIONS.join(", ")}.`,
    );
  }
  return match;
}

function requireString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new EngineError("VALIDATION", `Tool input "${key}" must be a non-empty string.`);
  }
  return value;
}

function optionalPositiveInt(value: unknown, key: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new EngineError(
      "VALIDATION",
      `Tool input "${key}" must be a positive integer when provided.`,
    );
  }
  return value;
}

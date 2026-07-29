// SPDX-License-Identifier: Apache-2.0

// Parsing of the language server's NAVIGATION results into the shapes the `navigate` tool renders.
//
// A language server is a separate process we do not control, so its replies are external input and
// are parsed with Zod rather than cast. Arrays are parsed ELEMENT-WISE on
// purpose: one oddly-shaped entry among three hundred references should cost that entry, not the
// whole answer. Anything unparseable degrades to "no result", never an error.
//
// LSP positions are 0-based on both axes; everything here converts to the 1-based line:character
// an editor (and a human reading the tool output) uses.

import { z } from "zod";
import { fileUriToPath } from "./uri.js";

/** A position in a source file. 1-based on both axes. */
export interface SourceLocation {
  /** Absolute path on disk; the tool layer renders it workspace-relative. */
  path: string;
  line: number;
  character: number;
}

/** A symbol the server knows about, and where it is declared. */
export interface SymbolMatch {
  name: string;
  /** Human-readable LSP SymbolKind ("function", "class", …); "symbol" when unrecognized. */
  kind: string;
  location: SourceLocation;
  /** Enclosing symbol (the class of a method, the module of a class) when the server reports one. */
  container?: string;
}

/**
 * One call-hierarchy item. `raw` is the server's own object, kept verbatim because the LSP spec
 * requires echoing the item back unmodified on the incoming/outgoing follow-up request — narrowing
 * it to our shape and rebuilding it would drop the server-private `data` field some servers use to
 * correlate the second call.
 */
export interface CallHierarchyItem {
  raw: unknown;
  symbol: SymbolMatch;
}

const positionSchema = z.object({
  line: z.number().int().nonnegative(),
  character: z.number().int().nonnegative(),
});

const rangeSchema = z.object({ start: positionSchema });

/** LSP `Location`. */
const locationSchema = z.object({ uri: z.string().min(1), range: rangeSchema });

/**
 * LSP `LocationLink`, which a server may answer instead of `Location` because we declare
 * `linkSupport`. `targetSelectionRange` is the identifier itself and `targetRange` the whole
 * declaration, so the former is preferred when present — it points at the name, not the body.
 */
const locationLinkSchema = z.object({
  targetUri: z.string().min(1),
  targetRange: rangeSchema,
  targetSelectionRange: rangeSchema.optional(),
});

// Safe in either order: `uri` and `targetUri` are each required by exactly one branch, so the two
// shapes are disjoint and neither can silently strip the other's fields.
const anyLocationSchema = z.union([locationSchema, locationLinkSchema]);

/**
 * A `WorkspaceSymbol`'s location may be a full `Location` or the lazy `{ uri }` form the server
 * expects to resolve later. Order is LOAD-BEARING: the full shape must come first, or a union match
 * on `{ uri }` would strip the range and report every symbol at line 1.
 */
const symbolLocationSchema = z.union([locationSchema, z.object({ uri: z.string().min(1) })]);

/** LSP `SymbolInformation` / `WorkspaceSymbol` — a flat symbol carrying its own location. */
const symbolInformationSchema = z.object({
  name: z.string().min(1),
  kind: z.number().int(),
  location: symbolLocationSchema,
  containerName: z.string().optional(),
});

/**
 * LSP `DocumentSymbol` — the hierarchical form, which carries no URI (it is implicitly the document
 * that was asked about). `children` stays `unknown` and is re-parsed during the walk: modelling the
 * recursion in the schema buys nothing when the walk has to visit every node anyway.
 */
const documentSymbolSchema = z.object({
  name: z.string().min(1),
  kind: z.number().int(),
  range: rangeSchema,
  selectionRange: rangeSchema,
  children: z.array(z.unknown()).optional(),
});

const markupContentSchema = z.object({ kind: z.string(), value: z.string() });
const markedStringSchema = z.union([
  z.string(),
  z.object({ language: z.string(), value: z.string() }),
]);
const hoverSchema = z.object({
  contents: z.union([markupContentSchema, z.array(markedStringSchema), markedStringSchema]),
});

const callHierarchyItemSchema = z.object({
  name: z.string().min(1),
  kind: z.number().int(),
  uri: z.string().min(1),
  range: rangeSchema,
  selectionRange: rangeSchema,
});

/** LSP SymbolKind (1–26) as the names a model reads, rather than the wire integers. */
const SYMBOL_KINDS: Record<number, string> = {
  1: "file",
  2: "module",
  3: "namespace",
  4: "package",
  5: "class",
  6: "method",
  7: "property",
  8: "field",
  9: "constructor",
  10: "enum",
  11: "interface",
  12: "function",
  13: "variable",
  14: "constant",
  15: "string",
  16: "number",
  17: "boolean",
  18: "array",
  19: "object",
  20: "key",
  21: "null",
  22: "enum member",
  23: "struct",
  24: "event",
  25: "operator",
  26: "type parameter",
};

/** The readable name for an LSP SymbolKind; unknown//future kinds degrade to a neutral "symbol". */
export function symbolKindName(kind: number): string {
  return SYMBOL_KINDS[kind] ?? "symbol";
}

/**
 * Parse a definition/implementation/references result. The LSP allows a bare `Location`, an array of
 * `Location`, an array of `LocationLink`, or null for all three methods, so all four are accepted.
 */
export function parseLocations(result: unknown): SourceLocation[] {
  const single = anyLocationSchema.safeParse(result);
  if (single.success) return [toSourceLocation(single.data)];
  if (!Array.isArray(result)) return [];
  const out: SourceLocation[] = [];
  for (const entry of result) {
    const parsed = anyLocationSchema.safeParse(entry);
    if (parsed.success) out.push(toSourceLocation(parsed.data));
  }
  return out;
}

/**
 * Parse a `textDocument/documentSymbol` result, flattening the hierarchical form depth-first so a
 * class and its methods read as one ordered list. `filePath` supplies the location the hierarchical
 * form omits. Both the hierarchical (`DocumentSymbol`) and flat (`SymbolInformation`) shapes occur
 * in the wild — typescript-language-server answers with the former, other servers the latter.
 */
export function parseDocumentSymbols(result: unknown, filePath: string): SymbolMatch[] {
  if (!Array.isArray(result)) return [];
  const out: SymbolMatch[] = [];
  for (const entry of result) {
    collectDocumentSymbol(entry, filePath, undefined, out);
  }
  return out;
}

/** Parse a `workspace/symbol` result (always the flat `SymbolInformation`/`WorkspaceSymbol` form). */
export function parseWorkspaceSymbols(result: unknown): SymbolMatch[] {
  if (!Array.isArray(result)) return [];
  const out: SymbolMatch[] = [];
  for (const entry of result) {
    const parsed = symbolInformationSchema.safeParse(entry);
    if (parsed.success) out.push(fromSymbolInformation(parsed.data));
  }
  return out;
}

/** Parse a `textDocument/prepareCallHierarchy` result, keeping each item's raw form for the follow-up. */
export function parseCallHierarchyItems(result: unknown): CallHierarchyItem[] {
  if (!Array.isArray(result)) return [];
  const out: CallHierarchyItem[] = [];
  for (const entry of result) {
    const parsed = callHierarchyItemSchema.safeParse(entry);
    if (!parsed.success) continue;
    out.push({ raw: entry, symbol: fromCallHierarchyItem(parsed.data) });
  }
  return out;
}

/**
 * Parse a `callHierarchy/incomingCalls` or `callHierarchy/outgoingCalls` result. The two differ only
 * in which side of the edge carries the item — `from` for callers, `to` for callees.
 */
export function parseCalls(result: unknown, direction: "incoming" | "outgoing"): SymbolMatch[] {
  if (!Array.isArray(result)) return [];
  const key = direction === "incoming" ? "from" : "to";
  const out: SymbolMatch[] = [];
  for (const entry of result) {
    if (typeof entry !== "object" || entry === null) continue;
    const parsed = callHierarchyItemSchema.safeParse((entry as Record<string, unknown>)[key]);
    if (parsed.success) out.push(fromCallHierarchyItem(parsed.data));
  }
  return out;
}

/**
 * Parse a `textDocument/hover` result into plain text. Servers answer with markdown, a legacy
 * `MarkedString`, or an array of them; all three collapse to the text a model reads, with the
 * markdown code fences left intact because they carry the type signature's formatting.
 */
export function parseHover(result: unknown): string | null {
  const parsed = hoverSchema.safeParse(result);
  if (!parsed.success) return null;
  const { contents } = parsed.data;
  const parts = Array.isArray(contents) ? contents : [contents];
  const text = parts
    .map((part) => (typeof part === "string" ? part : part.value))
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join("\n\n");
  return text.length > 0 ? text : null;
}

function toSourceLocation(value: z.infer<typeof anyLocationSchema>): SourceLocation {
  if ("uri" in value) return atRange(value.uri, value.range);
  return atRange(value.targetUri, value.targetSelectionRange ?? value.targetRange);
}

function atRange(uri: string, range: z.infer<typeof rangeSchema>): SourceLocation {
  return {
    path: fileUriToPath(uri),
    line: range.start.line + 1,
    character: range.start.character + 1,
  };
}

/** Walk one `DocumentSymbol` (and its children) into the flat output list, depth-first. */
function collectDocumentSymbol(
  entry: unknown,
  filePath: string,
  container: string | undefined,
  out: SymbolMatch[],
): void {
  const hierarchical = documentSymbolSchema.safeParse(entry);
  if (hierarchical.success) {
    const symbol = hierarchical.data;
    out.push({
      name: symbol.name,
      kind: symbolKindName(symbol.kind),
      location: {
        path: filePath,
        line: symbol.selectionRange.start.line + 1,
        character: symbol.selectionRange.start.character + 1,
      },
      ...(container !== undefined ? { container } : {}),
    });
    for (const child of symbol.children ?? []) {
      collectDocumentSymbol(child, filePath, symbol.name, out);
    }
    return;
  }
  // Not hierarchical: a server answering documentSymbol with the flat form, which carries its own
  // location and container and therefore has no children to walk.
  const flat = symbolInformationSchema.safeParse(entry);
  if (flat.success) out.push(fromSymbolInformation(flat.data));
}

function fromSymbolInformation(value: z.infer<typeof symbolInformationSchema>): SymbolMatch {
  const { location } = value;
  const resolved =
    "range" in location
      ? atRange(location.uri, location.range)
      : { path: fileUriToPath(location.uri), line: 1, character: 1 };
  return {
    name: value.name,
    kind: symbolKindName(value.kind),
    location: resolved,
    ...(value.containerName !== undefined && value.containerName.length > 0
      ? { container: value.containerName }
      : {}),
  };
}

function fromCallHierarchyItem(value: z.infer<typeof callHierarchyItemSchema>): SymbolMatch {
  return {
    name: value.name,
    kind: symbolKindName(value.kind),
    location: atRange(value.uri, value.selectionRange),
  };
}

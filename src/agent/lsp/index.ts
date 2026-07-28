// SPDX-License-Identifier: Apache-2.0

// Public surface of the engine-native LSP module: the per-run service, its session/client types,
// the ext→server registry, the navigation result shapes, and the shared renderers.

export { LspService, DEFAULT_DIAGNOSTICS_WAIT_MS } from "./service.js";
export type {
  LspServiceOptions,
  FileDiagnostics,
  LocationQuery,
  Position,
  NavigationResult,
} from "./service.js";
export { LspSession } from "./session.js";
export type { LspSessionOptions, SyncResult, LspRequestOutcome } from "./session.js";
export { LspClient, LspTimeoutError } from "./client.js";
export type {
  Diagnostic,
  DiagnosticSeverity,
  LspClientStatus,
  LspClientOptions,
} from "./client.js";
export {
  LANGUAGE_SERVERS,
  serverForPath,
  isCommandAvailable,
  resolveOnPath,
  languageIdForPath,
} from "./registry.js";
export type { LanguageServer } from "./registry.js";
export {
  renderDiagnostics,
  renderLocations,
  MAX_RENDERED_DIAGNOSTICS,
  MAX_RENDERED_LOCATIONS,
} from "./render.js";
export type { RenderedLocation } from "./render.js";
export {
  parseLocations,
  parseDocumentSymbols,
  parseWorkspaceSymbols,
  parseCallHierarchyItems,
  parseCalls,
  parseHover,
  symbolKindName,
} from "./navigation.js";
export type { SourceLocation, SymbolMatch, CallHierarchyItem } from "./navigation.js";
export { fileUriToPath } from "./uri.js";
export { FrameDecoder, encodeFrame } from "./framing.js";

// SPDX-License-Identifier: Apache-2.0

// Public surface of the engine-native LSP module: the per-run service, its session/client types,
// the ext→server registry, and the shared diagnostics renderer.

export { LspService, DEFAULT_DIAGNOSTICS_WAIT_MS } from "./service.js";
export type { LspServiceOptions, FileDiagnostics } from "./service.js";
export { LspSession } from "./session.js";
export type { LspSessionOptions, SyncResult } from "./session.js";
export { LspClient } from "./client.js";
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
  languageIdForPath,
} from "./registry.js";
export type { LanguageServer } from "./registry.js";
export { renderDiagnostics, MAX_RENDERED_DIAGNOSTICS } from "./render.js";
export { FrameDecoder, encodeFrame } from "./framing.js";

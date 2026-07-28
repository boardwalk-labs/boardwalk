// SPDX-License-Identifier: Apache-2.0

// file:// URI ↔ path conversion. Language servers address documents by URI; every model-bound
// rendering addresses them by workspace-relative path, so both the diagnostics and navigation
// tools cross this boundary.

/**
 * Decode a `file://` URI back to a filesystem path (the inverse of pathToFileURL for display). A
 * value that isn't a file URI — or that won't parse — is returned unchanged: this feeds rendering,
 * where showing the server's raw string beats showing nothing.
 */
export function fileUriToPath(uri: string): string {
  if (!uri.startsWith("file://")) return uri;
  try {
    return decodeURIComponent(new URL(uri).pathname);
  } catch {
    return uri;
  }
}

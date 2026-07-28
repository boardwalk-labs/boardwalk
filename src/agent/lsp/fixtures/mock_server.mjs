// SPDX-License-Identifier: Apache-2.0

// Test fixture: a minimal language server speaking LSP over stdio with Content-Length framing.
// Plain .mjs so it runs straight off `process.execPath` with no compile step (tsc ignores .mjs
// under src/, so `pnpm build` neither compiles nor ships it); tests reference it by absolute path.
// It implements just enough to exercise the real client: initialize, shutdown/exit, and a
// publishDiagnostics emitted after each didOpen/didChange.
//
// Behavior knobs via env (so one fixture covers several scenarios):
//   MOCK_LSP_DIAGNOSTIC  — the diagnostic message to publish (default a TS-style error).
//   MOCK_LSP_NO_DIAGS    — "1" to publish an EMPTY diagnostics array (a clean file).
//   MOCK_LSP_HANG_INIT   — "1" to never answer `initialize` (exercises the handshake timeout).
//   MOCK_LSP_IGNORE_SHUTDOWN — "1" to ignore `shutdown`/`exit` (exercises the SIGKILL fallback).
//   MOCK_LSP_ASK_CONFIG  — a config section to request via `workspace/configuration` after
//                          `initialized`; the client's answer is echoed back as the hover text, so a
//                          test can assert the client served its settings over the real wire.
//   MOCK_LSP_HANG_REQUEST — "1" to never answer navigation requests (exercises the request timeout).

const DIAGNOSTIC = process.env.MOCK_LSP_DIAGNOSTIC ?? "Cannot find name 'oops'.";
const NO_DIAGS = process.env.MOCK_LSP_NO_DIAGS === "1";
const HANG_INIT = process.env.MOCK_LSP_HANG_INIT === "1";
const IGNORE_SHUTDOWN = process.env.MOCK_LSP_IGNORE_SHUTDOWN === "1";
const ASK_CONFIG = process.env.MOCK_LSP_ASK_CONFIG;
const HANG_REQUEST = process.env.MOCK_LSP_HANG_REQUEST === "1";

/** What the client answered our workspace/configuration request with, echoed back on hover. */
let receivedConfig = null;
let configAnswered = false;
/** Hover ids parked until the config answer arrives — see replyHover for why this must wait. */
const pendingHovers = [];
/** Our own request ids live in a separate space from the client's; start high to avoid confusion. */
const CONFIG_REQUEST_ID = 9001;

function send(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function publishDiagnostics(uri) {
  send({
    jsonrpc: "2.0",
    method: "textDocument/publishDiagnostics",
    params: {
      uri,
      diagnostics: NO_DIAGS
        ? []
        : [
            {
              range: { start: { line: 2, character: 6 }, end: { line: 2, character: 10 } },
              severity: 1,
              code: 2304,
              source: "ts",
              message: DIAGNOSTIC,
            },
          ],
    },
  });
}

// Incremental Content-Length decoder (mirrors the client's framing, independently implemented).
let buffer = Buffer.alloc(0);
let expected = null;

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    if (expected === null) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;
      const header = buffer.subarray(0, headerEnd).toString("ascii");
      const match = /content-length:\s*(\d+)/i.exec(header);
      buffer = buffer.subarray(headerEnd + 4);
      if (match === null) continue;
      expected = Number.parseInt(match[1], 10);
    }
    if (buffer.length < expected) break;
    const body = buffer.subarray(0, expected).toString("utf8");
    buffer = buffer.subarray(expected);
    expected = null;
    let msg;
    try {
      msg = JSON.parse(body);
    } catch {
      continue;
    }
    handle(msg);
  }
});

/**
 * Answer a hover with whatever the client served for our configuration request. When ASK_CONFIG is
 * set the reply is PARKED until that answer arrives: the client writes didOpen + hover before it can
 * possibly have read our config request, so answering immediately would race and echo a stale null.
 */
function replyHover(id) {
  if (ASK_CONFIG !== undefined && !configAnswered) {
    pendingHovers.push(id);
    return;
  }
  send({
    jsonrpc: "2.0",
    id,
    result: { contents: { kind: "plaintext", value: JSON.stringify(receivedConfig) } },
  });
}

function handle(msg) {
  // A reply to the workspace/configuration request we sent (no `method`, our id).
  if (msg.method === undefined && msg.id === CONFIG_REQUEST_ID) {
    receivedConfig = msg.result;
    configAnswered = true;
    while (pendingHovers.length > 0) replyHover(pendingHovers.shift());
    return;
  }

  if (msg.method === "initialize") {
    if (HANG_INIT) return; // never answer — the client's handshake timeout must fire
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { capabilities: { textDocumentSync: 1 }, serverInfo: { name: "mock-lsp" } },
    });
  } else if (msg.method === "initialized") {
    if (ASK_CONFIG !== undefined) {
      send({
        jsonrpc: "2.0",
        id: CONFIG_REQUEST_ID,
        method: "workspace/configuration",
        params: { items: [{ section: ASK_CONFIG }] },
      });
    }
  } else if (msg.method === "textDocument/hover") {
    if (HANG_REQUEST) return; // never answer — the navigation timeout must fire
    replyHover(msg.id);
  } else if (msg.method === "textDocument/definition") {
    if (HANG_REQUEST) return;
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: [
        {
          uri: msg.params.textDocument.uri,
          range: { start: { line: 4, character: 9 }, end: { line: 4, character: 14 } },
        },
      ],
    });
  } else if (msg.method === "textDocument/didOpen" || msg.method === "textDocument/didChange") {
    publishDiagnostics(msg.params.textDocument.uri);
  } else if (msg.method === "shutdown") {
    if (IGNORE_SHUTDOWN) return; // never acknowledge — the client must SIGKILL on close
    send({ jsonrpc: "2.0", id: msg.id, result: null });
  } else if (msg.method === "exit") {
    if (IGNORE_SHUTDOWN) return;
    process.exit(0);
  }
}

process.stderr.write("mock-lsp fixture started\n");

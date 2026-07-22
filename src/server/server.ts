// SPDX-License-Identifier: Apache-2.0

// The engine's HTTP surface (SPEC §2.4): JSON API + SSE live tail + webhook triggers + the
// local run-log page, on bare node:http. This file owns the socket lifecycle only — routing
// lives in routes/router.ts, and every handler goes through engine/store methods, never SQL.
//
// Security posture (v1): bound to localhost by default; there is NO auth on this surface
// beyond webhook auth, so binding wider logs a prominent warning and is the operator's call.

import { createServer } from "node:http";
import type { Engine } from "../engine.js";
import { sendError } from "./http.js";
import { dispatchRequest } from "./routes/router.js";

export interface EngineServerOptions {
  /** Default bind host when `listen` doesn't name one. Default 127.0.0.1. */
  host?: string;
  /** Server diagnostics (bind warnings, internal errors kept off the wire). Default: stderr. */
  log?: (line: string) => void;
}

export interface EngineServer {
  /** Bind and start serving. `port` 0 picks a free port; the resolved value reports it. */
  listen(port: number, host?: string): Promise<{ port: number }>;
  /** Stop accepting and drop open connections (SSE tails would otherwise hold close forever). */
  close(): Promise<void>;
}

/**
 * Hosts only the local machine can reach. Exported for direct testing — the bind warning
 * hinges on this judgement.
 */
export function isLoopbackHost(host: string): boolean {
  return (
    host === "127.0.0.1" || host === "::1" || host === "localhost" || host === "::ffff:127.0.0.1"
  );
}

/**
 * Build (but do not bind) the HTTP server for an engine. Separate from the Engine itself so
 * embedding hosts never pay for an HTTP layer they don't use.
 */
export function createEngineServer(engine: Engine, opts: EngineServerOptions = {}): EngineServer {
  const log =
    opts.log ??
    ((line: string): void => {
      process.stderr.write(`${line}\n`);
    });
  const server = createServer((req, res) => {
    // One catch for every route: handlers just throw, and the error contract stays uniform.
    void dispatchRequest(engine, req, res, log).catch((err: unknown) => {
      sendError(res, err, log);
    });
  });

  return {
    listen(port: number, host?: string): Promise<{ port: number }> {
      const bindHost = host ?? opts.host ?? "127.0.0.1";
      if (!isLoopbackHost(bindHost)) {
        log(
          `WARNING: engine server binding to ${bindHost} — this surface has NO authentication ` +
            `beyond webhook auth (SPEC §2.4). Anyone who can reach it can start, cancel, and ` +
            `read runs. Only bind beyond loopback on a network you trust.`,
        );
      }
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, bindHost, () => {
          server.removeListener("error", reject);
          const address = server.address();
          // A TCP listen always yields an AddressInfo; a string means a pipe, which would be
          // a programming error here.
          if (address === null || typeof address === "string") {
            reject(new Error("engine server did not bind to a TCP port"));
            return;
          }
          resolve({ port: address.port });
        });
      });
    },
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close((err) => (err !== undefined ? reject(err) : resolve()));
        // SSE tails are long-lived by design; without this, close() never settles.
        server.closeAllConnections();
      });
    },
  };
}

// SPDX-License-Identifier: Apache-2.0

// Test double: a minimal OAuth 2.1 authorization server (RFC 8414 metadata, RFC 7591 dynamic
// registration, authorization endpoint that just 302s back with a code, token endpoint with
// authorization_code + refresh_token grants, real S256 PKCE verification). Also serves RFC
// 9728 protected-resource metadata at /resource-metadata so a fake MCP server's 401 hint has
// somewhere to point. Shared by the oauth unit tests and the end-to-end flow.

import { createHash, randomUUID } from "node:crypto";
import http from "node:http";

interface IssuedCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
}

export interface FakeAuthServer {
  issuer: string;
  tokenEndpoint: string;
  /** RFC 9728 protected-resource metadata endpoint naming this AS. */
  resourceMetadataUrl: string;
  /** Access tokens this AS has issued and not revoked — share with a fake MCP server's auth. */
  validTokens: Set<string>;
  registrations: number;
  codeExchanges: number;
  refreshCalls: number;
  /** Form params of the most recent token request (resource/PKCE assertions). */
  lastTokenRequest: URLSearchParams | null;
  /** Query of the most recent /authorize hit (challenge/resource assertions). */
  lastAuthorizeQuery: URLSearchParams | null;
  close(): Promise<void>;
}

export interface FakeAuthServerOptions {
  /** expires_in (seconds) on issued access tokens. Omit for non-expiring tokens. */
  expiresInSeconds?: number;
  /** Refuse to advertise a registration_endpoint (tests the no-DCR failure). */
  withoutRegistration?: boolean;
}

export function startFakeAuthServer(opts: FakeAuthServerOptions = {}): Promise<FakeAuthServer> {
  const codes = new Map<string, IssuedCode>();
  const refreshTokens = new Map<string, string>(); // refresh token → clientId
  const validTokens = new Set<string>();
  interface FakeAuthState {
    registrations: number;
    codeExchanges: number;
    refreshCalls: number;
    lastTokenRequest: URLSearchParams | null;
    lastAuthorizeQuery: URLSearchParams | null;
  }
  const state: FakeAuthState = {
    registrations: 0,
    codeExchanges: 0,
    refreshCalls: 0,
    lastTokenRequest: null,
    lastAuthorizeQuery: null,
  };
  let issuer = "";

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", issuer);
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      const respondJson = (status: number, payload: object): void => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };

      if (url.pathname === "/.well-known/oauth-authorization-server") {
        respondJson(200, {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          ...(opts.withoutRegistration === true
            ? {}
            : { registration_endpoint: `${issuer}/register` }),
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
        });
        return;
      }

      if (url.pathname === "/resource-metadata") {
        respondJson(200, {
          resource: url.searchParams.get("resource") ?? undefined,
          authorization_servers: [issuer],
        });
        return;
      }

      if (url.pathname === "/register" && req.method === "POST") {
        state.registrations += 1;
        respondJson(201, { client_id: `client-${String(state.registrations)}` });
        return;
      }

      if (url.pathname === "/authorize") {
        state.lastAuthorizeQuery = url.searchParams;
        const redirectUri = url.searchParams.get("redirect_uri");
        const clientId = url.searchParams.get("client_id");
        const challenge = url.searchParams.get("code_challenge");
        const stateParam = url.searchParams.get("state");
        if (redirectUri === null || clientId === null || challenge === null) {
          res.writeHead(400).end("missing params");
          return;
        }
        // No consent screen in a fake — authorization IS the redirect.
        const code = `code-${randomUUID()}`;
        codes.set(code, { clientId, redirectUri, codeChallenge: challenge });
        const target = new URL(redirectUri);
        target.searchParams.set("code", code);
        if (stateParam !== null) target.searchParams.set("state", stateParam);
        res.writeHead(302, { location: target.toString() }).end();
        return;
      }

      if (url.pathname === "/token" && req.method === "POST") {
        const params = new URLSearchParams(body);
        state.lastTokenRequest = params;
        const grantType = params.get("grant_type");
        if (grantType === "authorization_code") {
          const issued = codes.get(params.get("code") ?? "");
          const verifier = params.get("code_verifier") ?? "";
          const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
          if (
            issued === undefined ||
            issued.clientId !== params.get("client_id") ||
            issued.redirectUri !== params.get("redirect_uri") ||
            issued.codeChallenge !== challenge
          ) {
            respondJson(400, { error: "invalid_grant" });
            return;
          }
          codes.delete(params.get("code") ?? "");
          state.codeExchanges += 1;
          respondJson(200, issueTokens(issued.clientId));
          return;
        }
        if (grantType === "refresh_token") {
          const clientId = refreshTokens.get(params.get("refresh_token") ?? "");
          if (clientId === undefined || clientId !== params.get("client_id")) {
            respondJson(400, { error: "invalid_grant" });
            return;
          }
          state.refreshCalls += 1;
          respondJson(200, issueTokens(clientId));
          return;
        }
        respondJson(400, { error: "unsupported_grant_type" });
        return;
      }

      res.writeHead(404).end();
    });
  });

  function issueTokens(clientId: string): object {
    const accessToken = `at-${randomUUID()}`;
    const refreshToken = `rt-${randomUUID()}`;
    validTokens.add(accessToken);
    refreshTokens.set(refreshToken, clientId);
    return {
      access_token: accessToken,
      token_type: "Bearer",
      refresh_token: refreshToken,
      ...(opts.expiresInSeconds !== undefined ? { expires_in: opts.expiresInSeconds } : {}),
    };
  }

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      issuer = `http://127.0.0.1:${String(port)}`;
      resolve({
        issuer,
        tokenEndpoint: `${issuer}/token`,
        resourceMetadataUrl: `${issuer}/resource-metadata`,
        validTokens,
        get registrations(): number {
          return state.registrations;
        },
        get codeExchanges(): number {
          return state.codeExchanges;
        },
        get refreshCalls(): number {
          return state.refreshCalls;
        },
        get lastTokenRequest(): URLSearchParams | null {
          return state.lastTokenRequest;
        },
        get lastAuthorizeQuery(): URLSearchParams | null {
          return state.lastAuthorizeQuery;
        },
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

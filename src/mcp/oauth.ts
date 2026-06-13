// PARENT-side OAuth 2.1 for MCP servers (MCP authorization spec, 2025-06-18): discovery
// (RFC 9728 protected-resource metadata → RFC 8414 AS metadata), RFC 7591 dynamic client
// registration, the authorization-code + PKCE (S256) grant with a loopback redirect, RFC 8707
// resource indicators, and the refresh grant. All of it runs in the ENGINE process: token
// state never belongs to the run process, and the one interactive step is an explicit public
// API (`Engine.authorizeMcpServer`) — a headless run that would need a human fails loudly
// instead of prompting. Every external response is Zod-validated.

import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import { z } from "zod";
import { EngineError } from "../errors.js";
import { canonicalServerUrl, type McpTokenEntry, type McpTokenStore } from "./token_store.js";

export interface OAuthIo {
  fetchImpl?: typeof fetch | undefined;
}

// ----------------------------------------------------------------------------
// PKCE (RFC 7636, S256 only — OAuth 2.1 forbids `plain`)
// ----------------------------------------------------------------------------

export interface PkcePair {
  verifier: string;
  challenge: string;
}

/** A fresh high-entropy verifier and its S256 challenge. */
export function createPkcePair(): PkcePair {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: s256Challenge(verifier) };
}

/** The S256 transform, exported so tests can verify the challenge against the verifier. */
export function s256Challenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

// ----------------------------------------------------------------------------
// WWW-Authenticate parsing (RFC 9110 §11.6.1, the Bearer challenge subset we need)
// ----------------------------------------------------------------------------

/**
 * Extract the parameters of a Bearer challenge (`resource_metadata`, `error`, …). Returns an
 * empty record for non-Bearer or malformed headers — discovery then falls back to the
 * well-known path, so a sloppy header degrades gracefully instead of failing authorization.
 */
export function parseBearerChallenge(header: string): Record<string, string> {
  const match = /^\s*Bearer\b(.*)$/i.exec(header);
  if (match === null) return {};
  const params: Record<string, string> = {};
  // key="quoted value" or key=token, comma-separated.
  const paramRe = /([A-Za-z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,"]+))/g;
  for (const param of (match[1] ?? "").matchAll(paramRe)) {
    const key = param[1];
    const value = param[2] !== undefined ? param[2].replaceAll('\\"', '"') : param[3];
    if (key !== undefined && value !== undefined) params[key.toLowerCase()] = value;
  }
  return params;
}

// ----------------------------------------------------------------------------
// Discovery: server → protected-resource metadata → authorization-server metadata
// ----------------------------------------------------------------------------

const protectedResourceSchema = z.looseObject({
  resource: z.string().optional(),
  authorization_servers: z.array(z.string()).optional(),
});

const asMetadataSchema = z.looseObject({
  issuer: z.string().min(1),
  authorization_endpoint: z.string().min(1),
  token_endpoint: z.string().min(1),
  registration_endpoint: z.string().optional(),
});

export interface AuthorizationDiscovery {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string | undefined;
  /** The RFC 8707 resource indicator to bind grants to (canonical server URL by default). */
  resource: string;
}

/**
 * Find the authorization server for an MCP server: probe it unauthenticated, follow the 401's
 * `resource_metadata` hint (RFC 9728), fall back to the well-known protected-resource path,
 * and finally — for pre-9728 servers — treat the server's own origin as the issuer (the
 * 2025-03-26 MCP default). Failing any later step is loud: authorization can't be guessed.
 */
export async function discoverAuthorization(
  serverUrl: string,
  io: OAuthIo = {},
): Promise<AuthorizationDiscovery> {
  const doFetch = io.fetchImpl ?? fetch;
  const canonical = canonicalServerUrl(serverUrl);
  const origin = new URL(serverUrl).origin;

  const metadataUrls = [
    ...(await resourceMetadataHint(serverUrl, doFetch)),
    wellKnownUrl(serverUrl, "oauth-protected-resource"),
    `${origin}/.well-known/oauth-protected-resource`,
  ];

  let issuer = origin; // pre-RFC-9728 fallback: the resource server is its own issuer
  let resource = canonical;
  for (const url of dedupe(metadataUrls)) {
    const metadata = await fetchJson(url, doFetch, protectedResourceSchema);
    if (metadata === null) continue;
    issuer = metadata.authorization_servers?.[0] ?? issuer;
    resource = metadata.resource ?? resource;
    break;
  }

  const asMetadata = await fetchJson(
    wellKnownUrl(issuer, "oauth-authorization-server"),
    doFetch,
    asMetadataSchema,
  );
  if (asMetadata === null) {
    throw new EngineError(
      "PROVIDER_ERROR",
      `Could not discover OAuth authorization-server metadata for MCP server ${serverUrl} ` +
        `(issuer ${issuer}).`,
      "The server's authorization server must publish RFC 8414 metadata at " +
        "/.well-known/oauth-authorization-server.",
    );
  }
  return {
    authorizationEndpoint: asMetadata.authorization_endpoint,
    tokenEndpoint: asMetadata.token_endpoint,
    registrationEndpoint: asMetadata.registration_endpoint,
    resource,
  };
}

/** Probe the MCP server unauthenticated and harvest the 401's resource_metadata hint, if any. */
async function resourceMetadataHint(serverUrl: string, doFetch: typeof fetch): Promise<string[]> {
  try {
    const response = await doFetch(serverUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "ping" }),
    });
    if (response.status !== 401) return [];
    const challenge = parseBearerChallenge(response.headers.get("www-authenticate") ?? "");
    const hint = challenge["resource_metadata"];
    return hint !== undefined ? [hint] : [];
  } catch {
    return []; // unreachable server — the well-known fallbacks will fail loudly below
  }
}

/** RFC 8414 path handling: the well-known segment goes between the origin and the path. */
function wellKnownUrl(base: string, suffix: string): string {
  const url = new URL(base);
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.origin}/.well-known/${suffix}${path}`;
}

async function fetchJson<T extends z.ZodType>(
  url: string,
  doFetch: typeof fetch,
  schema: T,
): Promise<z.infer<T> | null> {
  try {
    const response = await doFetch(url, { headers: { accept: "application/json" } });
    if (!response.ok) return null;
    const parsed = schema.safeParse(await response.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function dedupe(urls: readonly string[]): string[] {
  return [...new Set(urls)];
}

// ----------------------------------------------------------------------------
// Dynamic client registration (RFC 7591)
// ----------------------------------------------------------------------------

const registrationResultSchema = z.looseObject({ client_id: z.string().min(1) });

/** Register a public client (no secret — token_endpoint_auth_method "none", per OAuth 2.1 CLI practice). */
export async function registerClient(
  registrationEndpoint: string,
  redirectUri: string,
  io: OAuthIo = {},
): Promise<string> {
  const doFetch = io.fetchImpl ?? fetch;
  const response = await doFetch(registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: "Boardwalk Engine",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  if (!response.ok) {
    throw new EngineError(
      "PROVIDER_ERROR",
      `OAuth client registration failed: ${String(response.status)} from ${registrationEndpoint}.`,
    );
  }
  const parsed = registrationResultSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new EngineError(
      "PROVIDER_ERROR",
      `OAuth client registration returned a malformed response (no client_id).`,
    );
  }
  return parsed.data.client_id;
}

// ----------------------------------------------------------------------------
// Token grants (authorization_code exchange + refresh_token)
// ----------------------------------------------------------------------------

const tokenResponseSchema = z.looseObject({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().positive().optional(),
});

export interface TokenGrant {
  accessToken: string;
  refreshToken: string | undefined;
  /** Epoch ms, derived from expires_in at grant time. Undefined when the AS declared none. */
  expiresAt: number | undefined;
}

export interface ExchangeCodeArgs {
  tokenEndpoint: string;
  clientId: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
  resource: string;
}

export async function exchangeAuthorizationCode(
  args: ExchangeCodeArgs,
  io: OAuthIo = {},
): Promise<TokenGrant> {
  return await tokenGrant(
    args.tokenEndpoint,
    {
      grant_type: "authorization_code",
      client_id: args.clientId,
      code: args.code,
      redirect_uri: args.redirectUri,
      code_verifier: args.codeVerifier,
      resource: args.resource,
    },
    io,
  );
}

export interface RefreshTokenArgs {
  tokenEndpoint: string;
  clientId: string;
  refreshToken: string;
  resource: string | undefined;
}

export async function refreshAccessToken(
  args: RefreshTokenArgs,
  io: OAuthIo = {},
): Promise<TokenGrant> {
  return await tokenGrant(
    args.tokenEndpoint,
    {
      grant_type: "refresh_token",
      client_id: args.clientId,
      refresh_token: args.refreshToken,
      ...(args.resource !== undefined ? { resource: args.resource } : {}),
    },
    io,
  );
}

async function tokenGrant(
  tokenEndpoint: string,
  params: Record<string, string>,
  io: OAuthIo,
): Promise<TokenGrant> {
  const doFetch = io.fetchImpl ?? fetch;
  const response = await doFetch(tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(params).toString(),
  });
  if (!response.ok) {
    // Status only — an AS error body can echo grant material; never put it in an error message.
    throw new EngineError(
      "PROVIDER_ERROR",
      `OAuth token request (${params["grant_type"] ?? "unknown grant"}) failed: ` +
        `${String(response.status)} from ${tokenEndpoint}.`,
    );
  }
  const parsed = tokenResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new EngineError("PROVIDER_ERROR", "OAuth token response was malformed.");
  }
  return {
    accessToken: parsed.data.access_token,
    refreshToken: parsed.data.refresh_token,
    expiresAt:
      parsed.data.expires_in !== undefined
        ? Date.now() + Math.floor(parsed.data.expires_in * 1000)
        : undefined,
  };
}

// ----------------------------------------------------------------------------
// The interactive authorization flow (Engine.authorizeMcpServer's implementation)
// ----------------------------------------------------------------------------

export interface AuthorizeFlowArgs {
  serverUrl: string;
  store: McpTokenStore;
  /** Hands the URL a human must open to the caller (CLI prints it, a UI links it). */
  onAuthorizationUrl: (url: string) => void;
  /** How long to wait for the human. Default 5 minutes. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_AUTHORIZE_TIMEOUT_MS = 5 * 60_000;

/**
 * The one-time interactive step: discovery → dynamic registration → PKCE authorization-code
 * grant with a loopback redirect → tokens persisted to the store. Resolves when the grant is
 * stored; rejects on state mismatch, an AS `error` redirect, or timeout. After this, runs use
 * the server headlessly (silent refresh included) until the grant dies.
 */
export async function runAuthorizationFlow(args: AuthorizeFlowArgs): Promise<void> {
  const io: OAuthIo = { fetchImpl: args.fetchImpl };
  const discovery = await discoverAuthorization(args.serverUrl, io);
  if (discovery.registrationEndpoint === undefined) {
    throw new EngineError(
      "UNSUPPORTED",
      `The authorization server for ${args.serverUrl} does not support dynamic client ` +
        "registration (RFC 7591), which this engine requires.",
      "Pre-provisioned client credentials are not supported yet; supply a token via the " +
        "McpServerRef headers instead.",
    );
  }

  const state = randomBytes(16).toString("base64url");
  const pkce = createPkcePair();
  const loopback = await startLoopbackListener(
    state,
    args.timeoutMs ?? DEFAULT_AUTHORIZE_TIMEOUT_MS,
  );
  try {
    const clientId = await registerClient(discovery.registrationEndpoint, loopback.redirectUri, io);

    const authorizeUrl = new URL(discovery.authorizationEndpoint);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", loopback.redirectUri);
    authorizeUrl.searchParams.set("state", state);
    authorizeUrl.searchParams.set("code_challenge", pkce.challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("resource", discovery.resource);
    args.onAuthorizationUrl(authorizeUrl.toString());

    const code = await loopback.code;
    const grant = await exchangeAuthorizationCode(
      {
        tokenEndpoint: discovery.tokenEndpoint,
        clientId,
        code,
        redirectUri: loopback.redirectUri,
        codeVerifier: pkce.verifier,
        resource: discovery.resource,
      },
      io,
    );
    const entry: McpTokenEntry = {
      clientId,
      accessToken: grant.accessToken,
      ...(grant.refreshToken !== undefined ? { refreshToken: grant.refreshToken } : {}),
      ...(grant.expiresAt !== undefined ? { expiresAt: grant.expiresAt } : {}),
      tokenEndpoint: discovery.tokenEndpoint,
      resource: discovery.resource,
    };
    args.store.set(args.serverUrl, entry);
  } finally {
    loopback.close();
  }
}

interface LoopbackListener {
  redirectUri: string;
  /** Resolves with the authorization code; rejects on error/state-mismatch/timeout. */
  code: Promise<string>;
  close: () => void;
}

/**
 * The OAuth 2.1 native-app redirect target: an ephemeral HTTP listener on 127.0.0.1 (loopback
 * redirect URIs are the one http:// form the spec allows). One-shot — first valid hit settles.
 */
function startLoopbackListener(state: string, timeoutMs: number): Promise<LoopbackListener> {
  return new Promise((resolveListener, rejectListener) => {
    let resolveCode: ((code: string) => void) | null = null;
    let rejectCode: ((err: Error) => void) | null = null;
    const code = new Promise<string>((resolve, reject) => {
      resolveCode = resolve;
      rejectCode = reject;
    });
    // Why the pre-attached catch: if the flow fails BEFORE awaiting `code` (e.g. registration
    // throws), close() rejects this promise with nobody listening yet — without a standing
    // handler that's an unhandled rejection. The real awaiter still receives the rejection.
    void code.catch(() => undefined);

    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const fail = (message: string): void => {
        res.writeHead(400, { "content-type": "text/plain" }).end(message);
        rejectCode?.(new EngineError("PROVIDER_ERROR", `MCP authorization failed: ${message}`));
      };
      const errorParam = url.searchParams.get("error");
      if (errorParam !== null) {
        fail(`the authorization server returned error "${errorParam}".`);
        return;
      }
      if (url.searchParams.get("state") !== state) {
        fail("state mismatch on the OAuth redirect (possible CSRF) — try authorizing again.");
        return;
      }
      const codeParam = url.searchParams.get("code");
      if (codeParam === null || codeParam.length === 0) {
        fail("the redirect carried no authorization code.");
        return;
      }
      res
        .writeHead(200, { "content-type": "text/html" })
        .end(
          "<html><body>Authorized — you can close this tab and return to Boardwalk.</body></html>",
        );
      resolveCode?.(codeParam);
    });

    const timer = setTimeout(() => {
      rejectCode?.(
        new EngineError(
          "PROVIDER_ERROR",
          `MCP authorization timed out after ${String(Math.round(timeoutMs / 1000))}s — the ` +
            "authorization URL was never completed.",
        ),
      );
      server.close();
    }, timeoutMs);

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address !== "object") {
        clearTimeout(timer);
        server.close();
        rejectListener(new EngineError("INTERNAL", "Loopback listener failed to bind a port."));
        return;
      }
      resolveListener({
        redirectUri: `http://127.0.0.1:${String(address.port)}/callback`,
        code,
        close: () => {
          clearTimeout(timer);
          server.close();
          // A close before settle (caller bailed early) must not leave the promise pending.
          rejectCode?.(new EngineError("CANCELLED", "MCP authorization was abandoned."));
        },
      });
    });
  });
}

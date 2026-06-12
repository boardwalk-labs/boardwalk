// Unit coverage for the parent-side OAuth pieces: PKCE math, WWW-Authenticate parsing, and
// discovery / registration / code-exchange / refresh against the in-test fake authorization
// server (real HTTP, real S256 verification — the fake AS rejects a wrong verifier, so a PKCE
// regression fails here, not in the field).

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startFakeAuthServer, type FakeAuthServer } from "../testing/fake_oauth.js";
import { startFakeMcpServer } from "../testing/fake_mcp.js";
import {
  createPkcePair,
  discoverAuthorization,
  exchangeAuthorizationCode,
  parseBearerChallenge,
  refreshAccessToken,
  registerClient,
  runAuthorizationFlow,
  s256Challenge,
} from "./oauth.js";
import { McpTokenStore } from "./token_store.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

async function fakeAs(
  opts: Parameters<typeof startFakeAuthServer>[0] = {},
): Promise<FakeAuthServer> {
  const as = await startFakeAuthServer(opts);
  cleanups.push(() => as.close());
  return as;
}

describe("PKCE", () => {
  it("the challenge is the base64url SHA-256 of the verifier (S256), recomputed independently", () => {
    const pair = createPkcePair();
    const expected = createHash("sha256").update(pair.verifier, "ascii").digest("base64url");
    expect(pair.challenge).toBe(expected);
    expect(s256Challenge(pair.verifier)).toBe(expected);
    // base64url alphabet only — no padding, no '+'/'/' that would need URL-escaping.
    expect(pair.verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(pair.challenge).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("every pair is fresh (verifiers never repeat)", () => {
    expect(createPkcePair().verifier).not.toBe(createPkcePair().verifier);
  });
});

describe("parseBearerChallenge", () => {
  it("extracts quoted and unquoted params from a Bearer challenge", () => {
    expect(
      parseBearerChallenge(
        'Bearer realm="mcp", resource_metadata="https://x.example.com/.well-known/oauth-protected-resource", error=invalid_token',
      ),
    ).toEqual({
      realm: "mcp",
      resource_metadata: "https://x.example.com/.well-known/oauth-protected-resource",
      error: "invalid_token",
    });
  });

  it("handles a bare Bearer, escaped quotes, and non-Bearer schemes", () => {
    expect(parseBearerChallenge("Bearer")).toEqual({});
    expect(parseBearerChallenge('Bearer realm="say \\"hi\\""')).toEqual({ realm: 'say "hi"' });
    expect(parseBearerChallenge('Basic realm="nope"')).toEqual({});
    expect(parseBearerChallenge("")).toEqual({});
  });
});

describe("discovery", () => {
  it("follows the 401 resource_metadata hint to the AS metadata (RFC 9728 → RFC 8414)", async () => {
    const as = await fakeAs();
    const mcp = await startFakeMcpServer({
      auth: { validTokens: new Set(), resourceMetadataUrl: as.resourceMetadataUrl },
    });
    cleanups.push(() => mcp.close());

    const discovery = await discoverAuthorization(mcp.url);
    expect(discovery.authorizationEndpoint).toBe(`${as.issuer}/authorize`);
    expect(discovery.tokenEndpoint).toBe(`${as.issuer}/token`);
    expect(discovery.registrationEndpoint).toBe(`${as.issuer}/register`);
    // No `resource` in the metadata ⇒ the canonical server URL is the resource indicator.
    expect(discovery.resource).toBe(mcp.url);
  });

  it("falls back to the server origin as issuer when there is no metadata anywhere", async () => {
    // The fake AS *is* the MCP server origin here: nothing serves protected-resource
    // metadata, so discovery must fall back to treating the origin as the issuer.
    const as = await fakeAs();
    const discovery = await discoverAuthorization(`${as.issuer}/mcp`);
    expect(discovery.tokenEndpoint).toBe(`${as.issuer}/token`);
  });

  it("fails loudly when no authorization-server metadata can be found", async () => {
    const mcp = await startFakeMcpServer({ auth: { validTokens: new Set() } });
    cleanups.push(() => mcp.close());
    await expect(discoverAuthorization(mcp.url)).rejects.toThrow(/authorization-server metadata/);
  });
});

describe("registration + grants against the fake AS", () => {
  it("registers a public client and exchanges a code (PKCE verified server-side)", async () => {
    const as = await fakeAs({ expiresInSeconds: 3600 });
    const redirectUri = "http://127.0.0.1:7777/callback";
    const clientId = await registerClient(`${as.issuer}/register`, redirectUri);
    expect(as.registrations).toBe(1);

    // Drive /authorize by hand (no browser): the fake AS 302s back with the code.
    const pkce = createPkcePair();
    const authorizeUrl = new URL(`${as.issuer}/authorize`);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("code_challenge", pkce.challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    const redirect = await fetch(authorizeUrl, { redirect: "manual" });
    const code = new URL(redirect.headers.get("location") ?? "").searchParams.get("code") ?? "";
    expect(code).not.toBe("");

    const before = Date.now();
    const grant = await exchangeAuthorizationCode({
      tokenEndpoint: as.tokenEndpoint,
      clientId,
      code,
      redirectUri,
      codeVerifier: pkce.verifier,
      resource: "https://mcp.example.com/mcp",
    });
    expect(as.validTokens.has(grant.accessToken)).toBe(true);
    expect(grant.refreshToken).toBeDefined();
    expect(grant.expiresAt).toBeGreaterThanOrEqual(before + 3600_000);
    // The RFC 8707 resource indicator traveled with the exchange.
    expect(as.lastTokenRequest?.get("resource")).toBe("https://mcp.example.com/mcp");

    // A WRONG verifier is rejected — proves the fake AS actually checks S256, which is what
    // makes the happy path above meaningful.
    await expect(
      exchangeAuthorizationCode({
        tokenEndpoint: as.tokenEndpoint,
        clientId,
        code: "code-reused",
        redirectUri,
        codeVerifier: "wrong-verifier",
        resource: "https://mcp.example.com/mcp",
      }),
    ).rejects.toThrow(/400/);
  });

  it("the refresh grant issues a fresh access token", async () => {
    const as = await fakeAs();
    const store = await authorizeAgainst(as);
    const entry = store.get(`${as.issuer}/mcp`);
    const grant = await refreshAccessToken({
      tokenEndpoint: as.tokenEndpoint,
      clientId: entry?.clientId ?? "",
      refreshToken: entry?.refreshToken ?? "",
      resource: entry?.resource,
    });
    expect(as.refreshCalls).toBe(1);
    expect(grant.accessToken).not.toBe(entry?.accessToken);
    expect(as.validTokens.has(grant.accessToken)).toBe(true);
  });
});

describe("runAuthorizationFlow (loopback end to end, no engine)", () => {
  it("discovery → registration → PKCE → loopback redirect → tokens in the store", async () => {
    const as = await fakeAs({ expiresInSeconds: 600 });
    const store = await authorizeAgainst(as);

    const entry = store.get(`${as.issuer}/mcp`);
    expect(entry).not.toBeNull();
    expect(as.validTokens.has(entry?.accessToken ?? "")).toBe(true);
    expect(entry?.refreshToken).toBeDefined();
    expect(entry?.tokenEndpoint).toBe(as.tokenEndpoint);
    // The authorize request carried PKCE S256 + the resource indicator.
    expect(as.lastAuthorizeQuery?.get("code_challenge_method")).toBe("S256");
    expect(as.lastAuthorizeQuery?.get("resource")).toBe(`${as.issuer}/mcp`);
  });

  it("rejects on an AS error redirect and on a state mismatch", async () => {
    const as = await fakeAs();
    // Error param: simulate the human denying consent by hitting the loopback with ?error=.
    await expect(
      authorizeAgainst(as, async (url) => {
        const redirectUri = new URL(url).searchParams.get("redirect_uri") ?? "";
        await fetch(`${redirectUri}?error=access_denied`);
      }),
    ).rejects.toThrow(/access_denied/);

    // State mismatch: replay the redirect with the right code param but a forged state.
    await expect(
      authorizeAgainst(as, async (url) => {
        const authorize = new URL(url);
        authorize.searchParams.set("state", "forged-state");
        const redirect = await fetch(authorize, { redirect: "manual" });
        await fetch(redirect.headers.get("location") ?? "");
      }),
    ).rejects.toThrow(/state mismatch/i);
  });

  it("times out when the authorization URL is never completed", async () => {
    const as = await fakeAs();
    await expect(authorizeAgainst(as, () => Promise.resolve(), { timeoutMs: 100 })).rejects.toThrow(
      /timed out/,
    );
  });

  it("fails loudly when the AS offers no dynamic registration", async () => {
    const as = await fakeAs({ withoutRegistration: true });
    await expect(authorizeAgainst(as)).rejects.toThrow(/dynamic client registration/);
  });
});

/**
 * Run the full authorization flow against the fake AS (its origin doubles as the MCP server,
 * exercising the no-metadata fallback). The default "browser" just follows the 302.
 */
async function authorizeAgainst(
  as: FakeAuthServer,
  browser?: (url: string) => Promise<void>,
  opts: { timeoutMs?: number } = {},
): Promise<McpTokenStore> {
  const dir = mkdtempSync(join(tmpdir(), "bw-oauth-test-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = new McpTokenStore(join(dir, "mcp_tokens.json"));
  const follow =
    browser ??
    (async (url: string): Promise<void> => {
      const redirect = await fetch(url, { redirect: "manual" });
      await fetch(redirect.headers.get("location") ?? "");
    });
  await runAuthorizationFlow({
    serverUrl: `${as.issuer}/mcp`,
    store,
    onAuthorizationUrl: (url) => void follow(url),
    timeoutMs: opts.timeoutMs ?? 15_000,
  });
  return store;
}

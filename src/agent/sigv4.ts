// SPDX-License-Identifier: Apache-2.0

// AWS Signature Version 4, hand-rolled on node:crypto — zero AWS SDK, zero `aws4`. The BYO
// Bedrock adapter (bedrock.ts) needs to sign its InvokeModel POST, and SigV4 is the only thing
// the SDK gives us there; reproducing it in ~120 lines beats pulling the dependency tree.
//
// The flow follows the AWS spec verbatim (docs: "Signature Version 4 signing process"):
//   1. CANONICAL REQUEST  — method, URI, query, canonical+signed headers, hashed payload.
//   2. STRING TO SIGN      — algorithm, timestamp, credential scope, hash(canonical request).
//   3. SIGNING KEY         — HMAC chain: kDate→kRegion→kService→kSigning over the secret key.
//   4. SIGNATURE           — HMAC-SHA256(signing key, string to sign), hex.
//   5. AUTHORIZATION       — "AWS4-HMAC-SHA256 Credential=…, SignedHeaders=…, Signature=…".
//
// Each step is its own pure function so the documented AKIDEXAMPLE test vectors can assert the
// intermediate strings, not just the final signature (sigv4.test.ts). All inputs flow in; no
// clock, no environment, no globals.

import { createHash, createHmac } from "node:crypto";

const ALGORITHM = "AWS4-HMAC-SHA256";
const TERMINATOR = "aws4_request";

/** AWS credentials, as resolved from the engine environment (never inline config). */
export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  /** STS temporary credentials carry a session token, signed in as `x-amz-security-token`. */
  sessionToken?: string | undefined;
}

/** A request to sign. Headers are merged with the computed `host`/`x-amz-date` before signing. */
export interface SignableRequest {
  method: string;
  /** Endpoint, e.g. https://bedrock-runtime.us-east-1.amazonaws.com/model/<id>/invoke. */
  url: string;
  /** Already-present headers (e.g. content-type). Names are case-insensitive per the spec. */
  headers: Record<string, string>;
  /** The exact request body bytes — hashed into the canonical request. */
  body: string;
}

export interface SigningContext {
  region: string;
  service: string;
  credentials: AwsCredentials;
  /** The signing instant. Pure input so tests can pin the AWS example timestamp. */
  date: Date;
}

/** The headers a caller must send for the signature to verify: the originals plus what we added. */
export interface SignedHeaders {
  headers: Record<string, string>;
  authorization: string;
}

/**
 * Sign `request` and return the full header set to send (originals + `host`, `x-amz-date`, the
 * optional `x-amz-security-token`, and `authorization`). The caller sends exactly these headers;
 * adding or dropping one after signing breaks the signature.
 */
export function signRequest(request: SignableRequest, ctx: SigningContext): SignedHeaders {
  const url = new URL(request.url);
  const amzDate = toAmzDate(ctx.date); // 20150830T123600Z
  const dateStamp = amzDate.slice(0, 8); // 20150830

  // Host and x-amz-date are always signed; the session token is signed when present so a swapped
  // token can't be replayed against this signature.
  const headers: Record<string, string> = {
    ...request.headers,
    host: url.host,
    "x-amz-date": amzDate,
    ...(ctx.credentials.sessionToken !== undefined
      ? { "x-amz-security-token": ctx.credentials.sessionToken }
      : {}),
  };

  const { canonicalRequest, signedHeaders } = buildCanonicalRequest(request.method, url, {
    headers,
    body: request.body,
  });
  const scope = credentialScope(dateStamp, ctx.region, ctx.service);
  const stringToSign = buildStringToSign(amzDate, scope, canonicalRequest);
  const signingKey = deriveSigningKey(
    ctx.credentials.secretAccessKey,
    dateStamp,
    ctx.region,
    ctx.service,
  );
  const signature = hmacHex(signingKey, stringToSign);

  const authorization =
    `${ALGORITHM} Credential=${ctx.credentials.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return { headers: { ...headers, authorization }, authorization };
}

/**
 * Step 1 — the canonical request: a normalized rendering of the request that signer and AWS both
 * derive identically. Returns the rendering plus the `SignedHeaders` list it implies (the same
 * list must appear in the Authorization header).
 */
export function buildCanonicalRequest(
  method: string,
  url: URL,
  req: { headers: Record<string, string>; body: string },
): { canonicalRequest: string; signedHeaders: string } {
  // Header names are lower-cased and sorted; values are trimmed and inner whitespace collapsed.
  const normalized = Object.entries(req.headers)
    .map(([name, value]) => [name.toLowerCase(), value.trim().replace(/\s+/g, " ")] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const canonicalHeaders = normalized.map(([name, value]) => `${name}:${value}\n`).join("");
  const signedHeaders = normalized.map(([name]) => name).join(";");
  const payloadHash = sha256Hex(req.body);

  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri(url),
    canonicalQuery(url),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  return { canonicalRequest, signedHeaders };
}

/** Step 2 — the string to sign: algorithm, timestamp, scope, and the hash of the canonical request. */
export function buildStringToSign(
  amzDate: string,
  scope: string,
  canonicalRequest: string,
): string {
  return [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
}

/** Step 3 — the signing key: an HMAC chain seeded with "AWS4" + the secret, over date/region/service. */
export function deriveSigningKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Buffer {
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, TERMINATOR);
}

/** The `<date>/<region>/<service>/aws4_request` scope, shared by the scope line and Credential=. */
export function credentialScope(dateStamp: string, region: string, service: string): string {
  return `${dateStamp}/${region}/${service}/${TERMINATOR}`;
}

/** ISO 8601 basic format in UTC: 20150830T123600Z — the `x-amz-date` header value. */
export function toAmzDate(date: Date): string {
  return `${date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "")}`;
}

// ----------------------------------------------------------------------------
// URI/query canonicalization
// ----------------------------------------------------------------------------

// The canonical URI is the URL path with each segment URI-encoded (the path separators stay).
// AWS does NOT double-encode for most services; Bedrock model ids arrive already percent-encoded
// in the path, so we re-encode from the DECODED segments to land on the spec's single-encoding.
function canonicalUri(url: URL): string {
  if (url.pathname === "" || url.pathname === "/") return "/";
  return url.pathname
    .split("/")
    .map((segment) => awsUriEncode(decodeURIComponent(segment)))
    .join("/");
}

// Query params sorted by key (then value), each key and value URI-encoded. Bedrock InvokeModel
// carries none today, but the canonical form must still be emitted (empty string when absent).
function canonicalQuery(url: URL): string {
  const pairs: [string, string][] = [...url.searchParams.entries()].map(([k, v]) => [
    awsUriEncode(k),
    awsUriEncode(v),
  ]);
  pairs.sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0,
  );
  return pairs.map(([k, v]) => `${k}=${v}`).join("&");
}

// RFC 3986 unreserved set stays literal; everything else is %XX uppercase. encodeURIComponent is
// close but leaves !*'()~ alone — AWS encodes all but `~`, so we patch those four plus restore `~`.
function awsUriEncode(value: string): string {
  return encodeURIComponent(value)
    .replace(/[!*'()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%7E/g, "~");
}

// ----------------------------------------------------------------------------
// Crypto primitives
// ----------------------------------------------------------------------------

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function hmacHex(key: Buffer, data: string): string {
  return createHmac("sha256", key).update(data, "utf8").digest("hex");
}

function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

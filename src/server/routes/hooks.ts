// SPDX-License-Identifier: Apache-2.0

// POST /hooks/:name — a webhook endpoint. Every deployed workflow carrying
// `{ kind: "webhook", name }` runs on every delivery, so one endpoint can drive several workflows.
//
// Credentials are *server* environment variables (not workflow secrets, so they resolve from
// process.env), and which one is set picks the scheme — the descriptor no longer declares it:
//   BOARDWALK_WEBHOOK_TOKEN__<NAME>   vs  `Authorization: Bearer <token>`
//   BOARDWALK_WEBHOOK_SECRET__<NAME>  vs  `X-Boardwalk-Signature: sha256=<hex>` (HMAC over raw body)
// <NAME> is the webhook name upper-cased with `-` → `_`. Neither set, or both, is 503 (fail closed).

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import {
  HttpError,
  MAX_BODY_BYTES,
  jsonValueSchema,
  parseJsonBody,
  readBody,
  sendJson,
} from "../http.js";
import type { RouteContext } from "./router.js";

export async function handleWebhook(ctx: RouteContext, name: string): Promise<void> {
  // Read the raw body up front: signature auth signs the exact bytes on the wire, before any JSON
  // parsing can normalize them away.
  const rawBody = await readBody(ctx.req, MAX_BODY_BYTES);

  // Authorize BEFORE looking anything up, so an unauthenticated caller learns nothing about what is
  // deployed here — including whether this webhook name has any workflows attached.
  authorize(ctx.req, name, rawBody);

  const attached = ctx.engine.store
    .listWorkflows()
    .filter((row) => row.manifest.triggers.some(isAttachedTo(name)));

  const input =
    rawBody.length === 0 ? null : parseJsonBody(rawBody, jsonValueSchema, "webhook payload");

  const runs = attached.map((row) => {
    const run = ctx.engine.startRun(row.slug, {
      input,
      triggerKind: "webhook",
      actor: { type: "webhook", source: name },
    });
    return { id: run.id, status: run.status, workflow: row.slug };
  });

  // 202 with however many runs started — zero is a legitimate outcome (nothing attached yet), not a
  // sender error, and answering 4xx would make senders retry a state only the operator can change.
  sendJson(ctx.res, 202, { runs });
}

function isAttachedTo(name: string) {
  return (trigger: { kind: string; name?: string }): boolean =>
    trigger.kind === "webhook" && trigger.name === name;
}

/** `BOARDWALK_WEBHOOK_<kind>__<NAME>`: the webhook name upper-cased, hyphens → underscores. */
function webhookEnvVarName(kind: "TOKEN" | "SECRET", name: string): string {
  return `BOARDWALK_WEBHOOK_${kind}__${name.toUpperCase().replaceAll("-", "_")}`;
}

/**
 * Pick the scheme from whichever credential the operator configured, failing CLOSED when that is
 * ambiguous: unset means an unconfigured webhook must never become an open trigger, and both set
 * means the intended scheme is unknowable — guessing one would silently accept the weaker.
 */
function authorize(req: IncomingMessage, name: string, rawBody: Buffer): void {
  const tokenVar = webhookEnvVarName("TOKEN", name);
  const secretVar = webhookEnvVarName("SECRET", name);
  const token = process.env[tokenVar];
  const secret = process.env[secretVar];
  const hasToken = token !== undefined && token !== "";
  const hasSecret = secret !== undefined && secret !== "";

  if (hasToken && hasSecret) {
    throw new HttpError(
      503,
      "WEBHOOK_AMBIGUOUS",
      `Webhook "${name}" has both a token and a signing secret configured.`,
      `Unset either ${tokenVar} or ${secretVar} and restart the server.`,
    );
  }
  if (hasToken) {
    authorizeToken(req, token);
    return;
  }
  if (hasSecret) {
    authorizeSignature(req, secret, rawBody);
    return;
  }
  throw new HttpError(
    503,
    "WEBHOOK_UNCONFIGURED",
    `Webhook "${name}" is not configured on this server.`,
    `Set ${tokenVar} (bearer token) or ${secretVar} (HMAC secret) and restart the server.`,
  );
}

/** One generic 401 for every credential failure — no oracle for which part was wrong. */
function unauthorized(): HttpError {
  return new HttpError(401, "UNAUTHORIZED", "Invalid webhook credentials.");
}

function authorizeToken(req: IncomingMessage, expected: string): void {
  const header = req.headers.authorization;
  if (header === undefined || !header.startsWith("Bearer ")) throw unauthorized();
  if (!constantTimeEquals(header.slice("Bearer ".length), expected)) throw unauthorized();
}

function authorizeSignature(req: IncomingMessage, secret: string, rawBody: Buffer): void {
  const header = req.headers["x-boardwalk-signature"];
  if (typeof header !== "string") throw unauthorized();
  const match = /^sha256=([0-9a-f]{64})$/i.exec(header);
  const presentedHex = match?.[1];
  if (presentedHex === undefined) throw unauthorized();
  const presented = Buffer.from(presentedHex, "hex");
  const computed = createHmac("sha256", secret).update(rawBody).digest();
  // The regex pins 64 hex chars = 32 bytes = SHA-256 output, so the lengths already match; the
  // explicit check keeps timingSafeEqual's equal-length precondition locally provable.
  if (presented.length !== computed.length || !timingSafeEqual(presented, computed)) {
    throw unauthorized();
  }
}

/**
 * Constant-time string equality. Why hash-then-compare: timingSafeEqual demands equal-length inputs,
 * and comparing fixed-size digests both satisfies that and avoids leaking the expected token's
 * length through an early length check.
 */
function constantTimeEquals(a: string, b: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(a).digest(),
    createHash("sha256").update(b).digest(),
  );
}

// POST /hooks/:workflow/:triggerIndex — the webhook trigger endpoint, and this engine's v0
// answer to MASTER_SPEC §10's open webhook-auth question (documented in SPEC §2.4):
// per-workflow credentials live in *server* environment variables —
//   token auth:     BOARDWALK_WEBHOOK_TOKEN__<NAME>   vs  `Authorization: Bearer <token>`
//   signature auth: BOARDWALK_WEBHOOK_SECRET__<NAME>  vs  `X-Boardwalk-Signature: sha256=<hex>`
//                   (HMAC-SHA256 over the raw request body)
// where <NAME> is the workflow name upper-cased with `-` → `_`. Missing variable = 503 (fail
// closed, hint names the variable); bad credential = 401. These are server config, not
// workflow secrets, so they resolve from process.env — never from the engine's env map.

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

export async function handleWebhook(
  ctx: RouteContext,
  workflowName: string,
  triggerIndexRaw: string,
): Promise<void> {
  // The raw body is read up front: signature auth signs the exact bytes on the wire, before
  // any JSON parsing can normalize them away.
  const rawBody = await readBody(ctx.req, MAX_BODY_BYTES);

  // One identical 404 for "no workflow", "no such trigger index", and "not a webhook
  // trigger" — an unauthenticated caller learns nothing about what is deployed here.
  const notFound = new HttpError(
    404,
    "NOT_FOUND",
    `No webhook trigger at /hooks/${workflowName}/${triggerIndexRaw}.`,
  );
  const workflow = ctx.engine.store.getWorkflow(workflowName);
  if (workflow === null) throw notFound;
  if (!/^\d+$/.test(triggerIndexRaw)) throw notFound;
  const trigger = workflow.manifest.triggers[Number(triggerIndexRaw)];
  if (trigger === undefined || trigger.kind !== "webhook") throw notFound;

  if (trigger.auth === "token") authorizeToken(ctx.req, workflowName);
  else authorizeSignature(ctx.req, workflowName, rawBody);

  const input =
    rawBody.length === 0 ? null : parseJsonBody(rawBody, jsonValueSchema, "webhook payload");
  const run = ctx.engine.startRun(workflowName, { input, triggerKind: "webhook" });
  sendJson(ctx.res, 201, { run: { id: run.id, status: run.status } });
}

/** `BOARDWALK_WEBHOOK_<kind>__<NAME>`: the workflow name upper-cased, hyphens → underscores. */
function webhookEnvVarName(kind: "TOKEN" | "SECRET", workflowName: string): string {
  return `BOARDWALK_WEBHOOK_${kind}__${workflowName.toUpperCase().replaceAll("-", "_")}`;
}

/**
 * Read the trigger's credential from the server environment, failing CLOSED when unset: a
 * webhook that nobody configured must never become an open trigger. Read lazily per request
 * so an operator can fix the environment without redeploying workflows.
 */
function requiredCredential(kind: "TOKEN" | "SECRET", workflowName: string): string {
  const name = webhookEnvVarName(kind, workflowName);
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new HttpError(
      503,
      "WEBHOOK_UNCONFIGURED",
      `Webhook auth for workflow "${workflowName}" is not configured on this server.`,
      `Set the environment variable ${name} and restart the server.`,
    );
  }
  return value;
}

/** One generic 401 for every credential failure — no oracle for which part was wrong. */
function unauthorized(): HttpError {
  return new HttpError(401, "UNAUTHORIZED", "Invalid webhook credentials.");
}

function authorizeToken(req: IncomingMessage, workflowName: string): void {
  const expected = requiredCredential("TOKEN", workflowName);
  const header = req.headers.authorization;
  if (header === undefined || !header.startsWith("Bearer ")) throw unauthorized();
  if (!constantTimeEquals(header.slice("Bearer ".length), expected)) throw unauthorized();
}

function authorizeSignature(req: IncomingMessage, workflowName: string, rawBody: Buffer): void {
  const secret = requiredCredential("SECRET", workflowName);
  const header = req.headers["x-boardwalk-signature"];
  if (typeof header !== "string") throw unauthorized();
  const match = /^sha256=([0-9a-f]{64})$/i.exec(header);
  const presentedHex = match?.[1];
  if (presentedHex === undefined) throw unauthorized();
  const presented = Buffer.from(presentedHex, "hex");
  const computed = createHmac("sha256", secret).update(rawBody).digest();
  // The regex pins 64 hex chars = 32 bytes = SHA-256 output, so the lengths already match;
  // the explicit check keeps timingSafeEqual's equal-length precondition locally provable.
  if (presented.length !== computed.length || !timingSafeEqual(presented, computed)) {
    throw unauthorized();
  }
}

/**
 * Constant-time string equality. Why hash-then-compare: timingSafeEqual demands equal-length
 * inputs, and comparing fixed-size digests both satisfies that and avoids leaking the
 * expected token's length through an early length check.
 */
function constantTimeEquals(a: string, b: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(a).digest(),
    createHash("sha256").update(b).digest(),
  );
}

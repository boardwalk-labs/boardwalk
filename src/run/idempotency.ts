// SPDX-License-Identifier: Apache-2.0

// Default idempotency keys for workflows.call / workflows.run.
//
// Contract (SDK CallOptions): "a deterministic key over (parent_run_id, target, input)" — a
// restarted parent recomputes the same key and re-attaches to the child it already spawned
// instead of spawning a duplicate. Determinism requires canonical JSON: object key order must
// not change the key. Inputs are narrowed to JsonValue at the IPC boundary before they get
// here, so this module is fully typed — no unknown, no casts.

import { createHash } from "node:crypto";
import type { JsonValue } from "@boardwalk-labs/workflow";

/** Serialize like JSON.stringify but with object keys sorted recursively — equal values ⇒ equal strings. */
export function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const parts = Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, v]) => `${JSON.stringify(key)}:${canonicalJson(v)}`);
    return `{${parts.join(",")}}`;
  }
  return JSON.stringify(value);
}

/** The default child-call idempotency key: sha256 over (parent run, target slug, input). */
export function defaultIdempotencyKey(parentRunId: string, slug: string, input: JsonValue): string {
  return createHash("sha256")
    .update(parentRunId)
    .update(" ")
    .update(slug)
    .update(" ")
    .update(canonicalJson(input))
    .digest("hex");
}

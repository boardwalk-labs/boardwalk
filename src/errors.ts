// SPDX-License-Identifier: Apache-2.0

// Engine errors carry a stable machine-readable code (surfaced in run_status `failed` events
// and API responses) plus an actionable message. Messages NEVER contain secret values.

export const ENGINE_ERROR_CODES = [
  "VALIDATION", // bad manifest/config/input at a trust boundary
  "NOT_FOUND", // unknown workflow/run
  "CONFLICT", // duplicate name, concurrent state conflict
  "SECRET_MISSING", // declared secret has no value in this environment
  "SECRET_UNDECLARED", // program read a secret not in permissions.secrets
  "MODEL_UNRESOLVED", // agent() with no model and no configured default
  "PROVIDER_ERROR", // upstream inference provider failure
  "BUDGET_EXCEEDED", // run terminated by budget.*
  "PROGRAM_ERROR", // the workflow program threw
  "CRASHED", // run process died and restarts were exhausted
  "CANCELLED",
  "UNSUPPORTED", // capability not present on this engine
  "INTERNAL",
] as const;

export type EngineErrorCode = (typeof ENGINE_ERROR_CODES)[number];

/** Narrow a string (e.g. an error code off the IPC wire) to a known engine code. */
export function isEngineErrorCode(code: string): code is EngineErrorCode {
  return ENGINE_ERROR_CODES.some((c) => c === code);
}

export class EngineError extends Error {
  readonly code: EngineErrorCode;
  /** A one-line pointer at the fix (file to edit, config to set) — safe to show anywhere. */
  readonly hint: string | undefined;

  constructor(code: EngineErrorCode, message: string, hint?: string) {
    super(message);
    this.name = "EngineError";
    this.code = code;
    this.hint = hint;
  }
}

/**
 * A short, safe rendering of an untrusted value for a validation message — `a string ("bash")`,
 * `a number (123)`, `an array`. Echoing the offending value is what lets a message name the actual
 * mistake instead of only restating the rule, so it is clipped rather than omitted: a validation
 * error must never become a channel for dumping a huge (or sensitive) value into run events.
 */
export function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  const type = typeof value;
  if (type === "undefined") return "undefined";
  if (type === "string" || type === "number" || type === "boolean") {
    const literal = JSON.stringify(value);
    return `a ${type} (${literal.length <= 40 ? literal : `${literal.slice(0, 39)}…`})`;
  }
  return `${/^[aeiou]/.test(type) ? "an" : "a"} ${type}`; // "an object", not "a object"
}

/** Narrow an unknown thrown value to a safe { code, message } for events/API responses. */
export function toErrorShape(err: unknown): { code: string; message: string } {
  if (err instanceof EngineError) return { code: err.code, message: err.message };
  if (err instanceof Error) return { code: "PROGRAM_ERROR", message: err.message };
  return { code: "PROGRAM_ERROR", message: String(err) };
}

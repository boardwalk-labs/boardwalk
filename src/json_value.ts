// Runtime narrowing for JsonValue. Values arriving over the run process's JSON-serialized IPC
// channel are JSON by construction, but "by construction" is exactly what trust boundaries
// don't get to assume — so narrow structurally instead of casting.

import type { JsonValue } from "@boardwalk-labs/workflow";
import { EngineError } from "./errors.js";

/** True when `value` is a plain JSON tree (no functions, symbols, bigints, class instances). */
export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (isPlainObject(value)) return Object.values(value).every(isJsonValue);
  return false;
}

/** Narrow to a plain object (prototype Object.prototype or null — no class instances). */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Narrow to JsonValue or throw — used where a JSON shape is a protocol requirement. */
export function asJsonValue(value: unknown, what: string): JsonValue {
  if (isJsonValue(value)) return value;
  throw new EngineError("VALIDATION", `${what} must be a JSON-serializable value.`);
}

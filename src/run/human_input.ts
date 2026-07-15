// SPDX-License-Identifier: Apache-2.0

// Validate a human-in-the-loop response against the gate's input spec.
//
// The input spec (a discriminated union on `kind`: text | choice | multiselect) is the single
// source of truth for what a valid answer looks like — the same description the UI renders from.
// A submission is checked here before it ever reaches the program: a bad answer is a VALIDATION
// error the responder sees, never a value the workflow has to defend against. Returns the
// normalized result the program receives (stored on the request row as the durable answer).

import { z } from "zod";
import type { JsonValue } from "@boardwalk-labs/workflow";
import { EngineError } from "../errors.js";

// Only the fields validation reads — z.object strips the presentational extras (multiline,
// placeholder, otherLabel) so a spec that carries them still parses.
const inputSpecSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), required: z.boolean().optional() }),
  z.object({
    kind: z.literal("choice"),
    options: z.array(z.string()),
    allowOther: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("multiselect"),
    options: z.array(z.string()),
    allowOther: z.boolean().optional(),
    min: z.number().int().nonnegative().optional(),
    max: z.number().int().nonnegative().optional(),
  }),
]);

const textResponseSchema = z.object({ value: z.string() });
const choiceResponseSchema = z.object({ value: z.string(), isOther: z.boolean().optional() });
const multiResponseSchema = z.object({
  values: z.array(z.string()),
  other: z.string().optional(),
});

/**
 * Validate `value` against the stored `specJson` and return the normalized {@link JsonValue}
 * result. Throws VALIDATION on a bad submission, INTERNAL on a corrupt spec.
 */
export function validateHumanInputResponse(specJson: unknown, value: unknown): JsonValue {
  const spec = inputSpecSchema.safeParse(specJson);
  if (!spec.success) {
    throw new EngineError("INTERNAL", `corrupt human-input spec: ${spec.error.message}`);
  }
  const s = spec.data;

  if (s.kind === "text") {
    const parsed = textResponseSchema.safeParse(value);
    if (!parsed.success) {
      throw new EngineError("VALIDATION", `a text response must be { value: string }`);
    }
    if (s.required === true && parsed.data.value.length === 0) {
      throw new EngineError("VALIDATION", `a response is required`);
    }
    return { value: parsed.data.value };
  }

  if (s.kind === "choice") {
    const parsed = choiceResponseSchema.safeParse(value);
    if (!parsed.success) {
      throw new EngineError(
        "VALIDATION",
        `a choice response must be { value: string, isOther?: boolean }`,
      );
    }
    const allowOther = s.allowOther ?? true;
    const known = s.options.includes(parsed.data.value);
    const isOther = parsed.data.isOther ?? !known;
    if (!isOther && !known) {
      throw new EngineError(
        "VALIDATION",
        `"${parsed.data.value}" is not one of the offered options`,
      );
    }
    if (isOther && !allowOther) {
      throw new EngineError("VALIDATION", `a free-text answer is not allowed for this gate`);
    }
    return { value: parsed.data.value, isOther };
  }

  // multiselect
  const parsed = multiResponseSchema.safeParse(value);
  if (!parsed.success) {
    throw new EngineError(
      "VALIDATION",
      `a multiselect response must be { values: string[], other?: string }`,
    );
  }
  for (const selection of parsed.data.values) {
    if (!s.options.includes(selection)) {
      throw new EngineError("VALIDATION", `"${selection}" is not one of the offered options`);
    }
  }
  const allowOther = s.allowOther ?? true;
  if (parsed.data.other !== undefined && !allowOther) {
    throw new EngineError("VALIDATION", `a free-text answer is not allowed for this gate`);
  }
  const count = parsed.data.values.length + (parsed.data.other !== undefined ? 1 : 0);
  if (s.min !== undefined && count < s.min) {
    throw new EngineError("VALIDATION", `select at least ${String(s.min)}`);
  }
  if (s.max !== undefined && count > s.max) {
    throw new EngineError("VALIDATION", `select at most ${String(s.max)}`);
  }
  return {
    values: parsed.data.values,
    ...(parsed.data.other !== undefined ? { other: parsed.data.other } : {}),
  };
}

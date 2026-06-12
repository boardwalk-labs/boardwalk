// Engine errors carry a stable machine-readable code (surfaced in run_status `failed` events
// and API responses) plus an actionable message. Messages NEVER contain secret values.

export type EngineErrorCode =
  | "VALIDATION" // bad manifest/config/input at a trust boundary
  | "NOT_FOUND" // unknown workflow/run
  | "CONFLICT" // duplicate name, concurrent state conflict
  | "SECRET_MISSING" // declared secret has no value in this environment
  | "SECRET_UNDECLARED" // program read a secret not in meta.secrets
  | "MODEL_UNRESOLVED" // agent() with no model and no configured default
  | "PROVIDER_ERROR" // upstream inference provider failure
  | "BUDGET_EXCEEDED" // run terminated by budget.*
  | "PROGRAM_ERROR" // the workflow program threw
  | "CRASHED" // run process died and restarts were exhausted
  | "CANCELLED"
  | "UNSUPPORTED" // capability not present on this engine (MASTER_SPEC §4)
  | "INTERNAL";

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

/** Narrow an unknown thrown value to a safe { code, message } for events/API responses. */
export function toErrorShape(err: unknown): { code: string; message: string } {
  if (err instanceof EngineError) return { code: err.code, message: err.message };
  if (err instanceof Error) return { code: "PROGRAM_ERROR", message: err.message };
  return { code: "PROGRAM_ERROR", message: String(err) };
}

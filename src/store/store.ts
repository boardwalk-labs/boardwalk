// SPDX-License-Identifier: Apache-2.0

// The engine's one persistence module — every SQL statement in the engine lives here
// (storage access goes through one persistence module). The backend is
// node:sqlite, synchronous on purpose: a single-node engine gains nothing from an async
// driver, and synchronous statements make multi-row invariants trivially transactional.
//
// Conventions: ULID primary keys, integer-ms timestamps, and JSON columns
// Zod-validated on READ — a row that fails validation throws EngineError("INTERNAL") naming
// the table and column, so corrupt state surfaces as a loud error instead of flowing into the
// scheduler as data.

import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue, SQLOutputValue, StatementSync } from "node:sqlite";
import { z } from "zod";
import { runEventSchema, workflowManifestSchema } from "@boardwalk-labs/workflow";
import type { JsonValue, RunEvent, RunStatus, WorkflowManifest } from "@boardwalk-labs/workflow";
import { EngineError } from "../errors.js";
import { ulid } from "../ids.js";
import { migrate } from "./migrations.js";

// ============================================================================
// Public row shapes
// ============================================================================

// Re-exported for engine modules that already type against the store's surface.
export type { RunStatus };

/** A deployed workflow: validated manifest + bundled program source + per-deploy config. */
export interface WorkflowRow {
  id: string;
  slug: string;
  manifest: WorkflowManifest;
  program: string;
  config: Record<string, JsonValue>;
  createdAt: number;
  updatedAt: number;
}

export type TriggerKind = "cron" | "manual" | "webhook";

/** The persisted form of a run failure — mirrors `toErrorShape` in errors.ts. */
export interface RunErrorShape {
  code: string;
  message: string;
}

/** One run of a workflow, including its budget tallies and the call-tree linkage. */
export interface RunRow {
  id: string;
  workflowId: string;
  status: RunStatus;
  triggerKind: TriggerKind;
  input: unknown;
  output: JsonValue | null;
  error: RunErrorShape | null;
  parentRunId: string | null;
  idempotencyKey: string | null;
  restarts: number;
  tokensIn: number;
  tokensOut: number;
  usdMicros: number;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  /** Due time for a timed suspension (long sleep / human-input timeout); null otherwise. */
  wakeAt: number | null;
}

/** A durable-seam memoization state: `pending` (started, not yet satisfied) or `resolved`. */
export type JournalState = "pending" | "resolved";

/** The durable seams a run journals (the only ones whose results survive a resume). */
export type JournalKind = "agent" | "step" | "human_input" | "sleep" | "workflow_call";

/**
 * One memoized durable-seam call. On a resume the program re-runs from the top; each seam looks
 * up its (run_id, seq) entry and, on a `resolved` hit with a matching `fingerprint`, returns
 * `result` WITHOUT re-executing. A `pending` entry is a seam awaiting an external event (a human
 * answer / a timer); `result` then holds its wake payload or a parked-leaf checkpoint.
 */
export interface JournalRow {
  runId: string;
  seq: number;
  kind: JournalKind;
  fingerprint: string;
  label: string | null;
  state: JournalState;
  result: JsonValue | null;
  createdAt: number;
  resolvedAt: number | null;
}

/** Lifecycle of a human-in-the-loop gate. */
export type HumanInputStatus = "pending" | "resolved" | "expired" | "cancelled";

/** A pending (or resolved/expired/cancelled) human-in-the-loop request. */
export interface HumanInputRequestRow {
  id: string;
  runId: string;
  seq: number;
  key: string;
  prompt: string;
  inputSpec: JsonValue;
  assignees: string[] | null;
  status: HumanInputStatus;
  response: JsonValue | null;
  respondedBy: string | null;
  createdAt: number;
  expiresAt: number | null;
  respondedAt: number | null;
}

/** One entry in a run's append-only event log (the SDK wire format, cursor-indexed). */
export interface EventRow {
  runId: string;
  cursor: number;
  event: RunEvent;
}

/** Metadata for a file written via `artifacts.write`; `path` points into the on-disk store. */
export interface ArtifactRow {
  id: string;
  runId: string;
  name: string;
  contentType: string;
  path: string;
  size: number;
  metadata: Record<string, unknown> | null;
  createdAt: number;
}

export interface StoreOptions {
  /** Injectable time source (ms since epoch) so tests can pin timestamps. Default: Date.now. */
  now?: () => number;
}

// ============================================================================
// Column schemas — every JSON/enum column has exactly one validator
// ============================================================================

/**
 * Build a Zod enum from an exhaustive flag record. Why a Record and not a plain array: the
 * `Record<T, true>` argument makes the value list provably complete — adding a member to the
 * union type without adding it here is a compile error, so reads can never reject a value a
 * newer engine legitimately wrote.
 */
function enumFromKeys<T extends string>(flags: Record<T, true>): z.ZodType<T> {
  // Why the cast: Object.keys erases key types; the Record argument guarantees the keys are
  // exactly the members of T.
  return z.enum(Object.keys(flags) as [T, ...T[]]);
}

const runStatusSchema = enumFromKeys<RunStatus>({
  queued: true,
  pending: true,
  running: true,
  // Suspended (durable suspension): the run released its task and will resume later.
  sleeping: true,
  awaiting_input: true,
  waiting_for_child: true,
  completed: true,
  failed: true,
  cancelled: true,
  cancelling: true,
});

const triggerKindSchema = enumFromKeys<TriggerKind>({ cron: true, manual: true, webhook: true });

const runErrorSchema: z.ZodType<RunErrorShape> = z.object({
  code: z.string(),
  message: z.string(),
});

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

const configSchema = z.record(z.string(), jsonValueSchema);
const metadataSchema = z.record(z.string(), z.unknown());

const journalStateSchema: z.ZodType<JournalState> = z.enum(["pending", "resolved"]);
const journalKindSchema: z.ZodType<JournalKind> = z.enum([
  "agent",
  "step",
  "human_input",
  "sleep",
  "workflow_call",
]);
const humanInputStatusSchema: z.ZodType<HumanInputStatus> = z.enum([
  "pending",
  "resolved",
  "expired",
  "cancelled",
]);
const assigneesSchema: z.ZodType<string[]> = z.array(z.string());

// ============================================================================
// Row mapping — narrow SQLOutputValue without casts
// ============================================================================

type SqlRow = Record<string, SQLOutputValue>;

function columnError(table: string, column: string, problem: string): EngineError {
  return new EngineError("INTERNAL", `corrupt row in ${table}.${column}: ${problem}`);
}

function describeValue(value: SQLOutputValue | undefined): string {
  if (value === undefined) return "missing column";
  if (value === null) return "NULL";
  return typeof value;
}

function readText(row: SqlRow, table: string, column: string): string {
  const value = row[column];
  if (typeof value === "string") return value;
  throw columnError(table, column, `expected TEXT, got ${describeValue(value)}`);
}

function readTextOrNull(row: SqlRow, table: string, column: string): string | null {
  return row[column] === null ? null : readText(row, table, column);
}

function readInteger(row: SqlRow, table: string, column: string): number {
  const value = row[column];
  if (typeof value === "number" && Number.isInteger(value)) return value;
  // Why bigint handling: node:sqlite returns bigint for values outside the JS safe-integer
  // range. Our integers (timestamps, counters) always fit, so an overflow is corruption.
  if (typeof value === "bigint") {
    throw columnError(table, column, "INTEGER exceeds Number.MAX_SAFE_INTEGER");
  }
  throw columnError(table, column, `expected INTEGER, got ${describeValue(value)}`);
}

function readIntegerOrNull(row: SqlRow, table: string, column: string): number | null {
  return row[column] === null ? null : readInteger(row, table, column);
}

function readJson<T>(row: SqlRow, table: string, column: string, schema: z.ZodType<T>): T {
  const raw = readText(row, table, column);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw columnError(table, column, "invalid JSON");
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw columnError(table, column, `failed schema validation: ${result.error.message}`);
  }
  return result.data;
}

function readJsonOrNull<T>(
  row: SqlRow,
  table: string,
  column: string,
  schema: z.ZodType<T>,
): T | null {
  return row[column] === null ? null : readJson(row, table, column, schema);
}

function readEnum<T extends string>(
  row: SqlRow,
  table: string,
  column: string,
  schema: z.ZodType<T>,
): T {
  const raw = readText(row, table, column);
  const result = schema.safeParse(raw);
  if (!result.success) throw columnError(table, column, `unexpected value "${raw}"`);
  return result.data;
}

function mapWorkflow(row: SqlRow): WorkflowRow {
  return {
    id: readText(row, "workflows", "id"),
    slug: readText(row, "workflows", "slug"),
    manifest: readJson(row, "workflows", "manifest", workflowManifestSchema),
    program: readText(row, "workflows", "program"),
    config: readJson(row, "workflows", "config", configSchema),
    createdAt: readInteger(row, "workflows", "created_at"),
    updatedAt: readInteger(row, "workflows", "updated_at"),
  };
}

function mapRun(row: SqlRow): RunRow {
  return {
    id: readText(row, "runs", "id"),
    workflowId: readText(row, "runs", "workflow_id"),
    status: readEnum(row, "runs", "status", runStatusSchema),
    triggerKind: readEnum(row, "runs", "trigger_kind", triggerKindSchema),
    input: readJsonOrNull(row, "runs", "input", jsonValueSchema),
    output: readJsonOrNull(row, "runs", "output", jsonValueSchema),
    error: readJsonOrNull(row, "runs", "error", runErrorSchema),
    parentRunId: readTextOrNull(row, "runs", "parent_run_id"),
    idempotencyKey: readTextOrNull(row, "runs", "idempotency_key"),
    restarts: readInteger(row, "runs", "restarts"),
    tokensIn: readInteger(row, "runs", "tokens_in"),
    tokensOut: readInteger(row, "runs", "tokens_out"),
    usdMicros: readInteger(row, "runs", "usd_micros"),
    createdAt: readInteger(row, "runs", "created_at"),
    startedAt: readIntegerOrNull(row, "runs", "started_at"),
    endedAt: readIntegerOrNull(row, "runs", "ended_at"),
    wakeAt: readIntegerOrNull(row, "runs", "wake_at"),
  };
}

function mapJournal(row: SqlRow): JournalRow {
  return {
    runId: readText(row, "run_journal", "run_id"),
    seq: readInteger(row, "run_journal", "seq"),
    kind: readEnum(row, "run_journal", "kind", journalKindSchema),
    fingerprint: readText(row, "run_journal", "fingerprint"),
    label: readTextOrNull(row, "run_journal", "label"),
    state: readEnum(row, "run_journal", "state", journalStateSchema),
    result: readJsonOrNull(row, "run_journal", "result", jsonValueSchema),
    createdAt: readInteger(row, "run_journal", "created_at"),
    resolvedAt: readIntegerOrNull(row, "run_journal", "resolved_at"),
  };
}

function mapHumanInputRequest(row: SqlRow): HumanInputRequestRow {
  const t = "human_input_requests";
  return {
    id: readText(row, t, "id"),
    runId: readText(row, t, "run_id"),
    seq: readInteger(row, t, "seq"),
    key: readText(row, t, "key"),
    prompt: readText(row, t, "prompt"),
    inputSpec: readJson(row, t, "input_spec", jsonValueSchema),
    assignees: readJsonOrNull(row, t, "assignees", assigneesSchema),
    status: readEnum(row, t, "status", humanInputStatusSchema),
    response: readJsonOrNull(row, t, "response", jsonValueSchema),
    respondedBy: readTextOrNull(row, t, "responded_by"),
    createdAt: readInteger(row, t, "created_at"),
    expiresAt: readIntegerOrNull(row, t, "expires_at"),
    respondedAt: readIntegerOrNull(row, t, "responded_at"),
  };
}

function mapEvent(row: SqlRow): EventRow {
  return {
    runId: readText(row, "run_events", "run_id"),
    cursor: readInteger(row, "run_events", "cursor"),
    event: readJson(row, "run_events", "event", runEventSchema),
  };
}

function mapArtifact(row: SqlRow): ArtifactRow {
  return {
    id: readText(row, "artifacts", "id"),
    runId: readText(row, "artifacts", "run_id"),
    name: readText(row, "artifacts", "name"),
    contentType: readText(row, "artifacts", "content_type"),
    path: readText(row, "artifacts", "path"),
    size: readInteger(row, "artifacts", "size"),
    metadata: readJsonOrNull(row, "artifacts", "metadata", metadataSchema),
    createdAt: readInteger(row, "artifacts", "created_at"),
  };
}

// ============================================================================
// SQLite error classification
// ============================================================================

const SQLITE_CONSTRAINT_FOREIGNKEY = 787;
const SQLITE_CONSTRAINT_PRIMARYKEY = 1555;
const SQLITE_CONSTRAINT_UNIQUE = 2067;

function sqliteErrcode(err: unknown): number | undefined {
  if (typeof err === "object" && err !== null && "errcode" in err) {
    const code = err.errcode;
    if (typeof code === "number") return code;
  }
  return undefined;
}

function isUniqueViolation(err: unknown): boolean {
  const code = sqliteErrcode(err);
  return code === SQLITE_CONSTRAINT_PRIMARYKEY || code === SQLITE_CONSTRAINT_UNIQUE;
}

function isForeignKeyViolation(err: unknown): boolean {
  return sqliteErrcode(err) === SQLITE_CONSTRAINT_FOREIGNKEY;
}

/** Serialize a JSON column value; `undefined` stores NULL. Rejects unserializable values. */
function serializeJson(value: unknown, what: string): string | null {
  if (value === undefined) return null;
  const json: string | undefined = JSON.stringify(value);
  // Why the check: JSON.stringify returns undefined (despite its declared type) for values
  // like bare functions; storing that would write the literal string "undefined".
  if (typeof json !== "string") {
    throw new EngineError("VALIDATION", `${what} is not JSON-serializable`);
  }
  return json;
}

function assertCountInteger(value: number, what: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new EngineError(
      "VALIDATION",
      `${what} must be a non-negative integer (got ${String(value)})`,
    );
  }
}

// ============================================================================
// The Store
// ============================================================================

/**
 * The engine database. One instance per engine process; all access is synchronous and goes
 * through this class — no other module writes SQL. Opening migrates the schema to the latest
 * version, so "open the database" and "deploy the schema" are the same operation and can never
 * drift apart.
 */
export class Store {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  // Why a cache: prepared statements are compiled once and reused; event appends and run
  // polling are hot paths, and the set of distinct SQL strings in this module is small and
  // bounded, so the cache cannot grow without limit.
  private readonly statements = new Map<string, StatementSync>();
  private inTransaction = false;

  /** Open (or create) the engine database at `path` (`":memory:"` for tests) and migrate. */
  constructor(path: string, options: StoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.db = new DatabaseSync(path);
    // WAL lets readers (SSE tails, the local UI) proceed while a write is in flight. Foreign
    // keys are per-connection in SQLite and OFF by default, so enable them on every open —
    // they are what keeps an orphaned run/event/artifact row from ever existing.
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    migrate(this.db);
  }

  close(): void {
    this.statements.clear();
    this.db.close();
  }

  /**
   * Run `fn` inside a single SQLite transaction (BEGIN IMMEDIATE … COMMIT/ROLLBACK).
   * Composable: the scheduler wraps createRun + recordCronFire in one transaction so the
   * exactly-once fire record and the run it spawned commit or vanish together. Nested calls
   * join the outer transaction — an inner throw propagates and rolls back the whole thing
   * (SQLite has no real nested transactions; partial inner commits would break the outer
   * invariant anyway).
   */
  transaction<T>(fn: () => T): T {
    if (this.inTransaction) return fn();
    // Why IMMEDIATE: take the write lock up front so the transaction can never fail with
    // SQLITE_BUSY halfway through after reads have already happened.
    this.db.exec("BEGIN IMMEDIATE");
    this.inTransaction = true;
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Some SQLite errors abort the transaction themselves; the original error matters.
      }
      throw err;
    } finally {
      this.inTransaction = false;
    }
  }

  // --------------------------------------------------------------------------
  // Workflows
  // --------------------------------------------------------------------------

  /**
   * Insert a workflow or update it by slug (deploying again is always an update — the slug is
   * the user-facing identity, so the id stays stable across redeploys and existing runs keep
   * their foreign keys). `updated_at` bumps on update; `created_at` and `id` never change.
   */
  upsertWorkflow(args: {
    slug: string;
    manifest: WorkflowManifest;
    program: string;
    config?: Record<string, JsonValue>;
  }): WorkflowRow {
    // Why validate on write too: the manifest column is read back through this same schema; a
    // caller bug is better rejected here than persisted and discovered as INTERNAL on read.
    const manifest = workflowManifestSchema.safeParse(args.manifest);
    if (!manifest.success) {
      throw new EngineError(
        "VALIDATION",
        `manifest for workflow "${args.slug}" failed validation: ${manifest.error.message}`,
      );
    }
    const manifestJson = JSON.stringify(manifest.data);
    const configJson = JSON.stringify(args.config ?? {});
    return this.transaction(() => {
      const t = this.now();
      const existing = this.prepare("SELECT id FROM workflows WHERE slug = ?").get(args.slug);
      if (existing === undefined) {
        this.prepare(
          `INSERT INTO workflows (id, slug, manifest, program, config, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(ulid(t), args.slug, manifestJson, args.program, configJson, t, t);
      } else {
        this.prepare(
          "UPDATE workflows SET manifest = ?, program = ?, config = ?, updated_at = ? WHERE slug = ?",
        ).run(manifestJson, args.program, configJson, t, args.slug);
      }
      const row = this.getWorkflow(args.slug);
      if (row === null) {
        throw new EngineError("INTERNAL", `workflow "${args.slug}" vanished mid-upsert`);
      }
      return row;
    });
  }

  getWorkflow(slug: string): WorkflowRow | null {
    const row = this.prepare("SELECT * FROM workflows WHERE slug = ?").get(slug);
    return row === undefined ? null : mapWorkflow(row);
  }

  getWorkflowById(id: string): WorkflowRow | null {
    const row = this.prepare("SELECT * FROM workflows WHERE id = ?").get(id);
    return row === undefined ? null : mapWorkflow(row);
  }

  listWorkflows(): WorkflowRow[] {
    return this.prepare("SELECT * FROM workflows ORDER BY slug ASC").all().map(mapWorkflow);
  }

  // --------------------------------------------------------------------------
  // Runs
  // --------------------------------------------------------------------------

  /**
   * Create a run in status `queued`. With an `idempotencyKey` this is an atomic
   * find-or-create on (parentRunId, idempotencyKey): a restarted parent re-running the same
   * `workflows.call` site re-attaches to the child it already spawned (`created: false`)
   * instead of spawning a duplicate — the heart of restart-on-crash semantics.
   */
  createRun(args: {
    workflowId: string;
    triggerKind: TriggerKind;
    input?: unknown;
    parentRunId?: string;
    idempotencyKey?: string;
  }): { run: RunRow; created: boolean } {
    const inputJson = serializeJson(args.input, "run input");
    return this.transaction(() => {
      const parentRunId = args.parentRunId ?? null;
      if (args.idempotencyKey !== undefined) {
        // Why `IS ?`: top-level runs carry idempotency keys with a NULL parent, and `=` never
        // matches NULL. The lookup runs inside the same transaction as the insert, so the
        // find-or-create is atomic.
        const existing = this.prepare(
          "SELECT * FROM runs WHERE parent_run_id IS ? AND idempotency_key = ?",
        ).get(parentRunId, args.idempotencyKey);
        if (existing !== undefined) return { run: mapRun(existing), created: false };
      }
      // Why explicit existence checks: a bare FK violation can't say WHICH reference was bad;
      // these turn caller mistakes into precise NOT_FOUND errors.
      if (
        this.prepare("SELECT id FROM workflows WHERE id = ?").get(args.workflowId) === undefined
      ) {
        throw new EngineError("NOT_FOUND", `workflow ${args.workflowId} not found`);
      }
      if (
        parentRunId !== null &&
        this.prepare("SELECT id FROM runs WHERE id = ?").get(parentRunId) === undefined
      ) {
        throw new EngineError("NOT_FOUND", `parent run ${parentRunId} not found`);
      }
      const t = this.now();
      const id = ulid(t);
      this.prepare(
        `INSERT INTO runs (id, workflow_id, status, trigger_kind, input, parent_run_id, idempotency_key, created_at)
         VALUES (?, ?, 'queued', ?, ?, ?, ?, ?)`,
      ).run(
        id,
        args.workflowId,
        args.triggerKind,
        inputJson,
        parentRunId,
        args.idempotencyKey ?? null,
        t,
      );
      return { run: this.getRunOrThrow(id), created: true };
    });
  }

  getRun(id: string): RunRow | null {
    const row = this.prepare("SELECT * FROM runs WHERE id = ?").get(id);
    return row === undefined ? null : mapRun(row);
  }

  /** List runs newest first, optionally filtered — the shape the run-log UI and sweeps need. */
  listRuns(
    filter: {
      workflowId?: string;
      statuses?: readonly RunStatus[];
      limit?: number;
      offset?: number;
    } = {},
  ): RunRow[] {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (filter.workflowId !== undefined) {
      where.push("workflow_id = ?");
      params.push(filter.workflowId);
    }
    if (filter.statuses !== undefined) {
      if (filter.statuses.length === 0) return [];
      where.push(`status IN (${filter.statuses.map(() => "?").join(", ")})`);
      params.push(...filter.statuses);
    }
    const whereSql = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "";
    // Why the rowid tiebreak: created_at has millisecond resolution and a ULID's random tail
    // does NOT order same-millisecond inserts — rowid is the only true insertion order, and
    // "newest first" must be exact for the scheduler's oldest-first dispatch to be fair.
    // LIMIT -1 is SQLite for "no limit".
    const sql = `SELECT * FROM runs${whereSql} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`;
    return this.prepare(sql)
      .all(...params, filter.limit ?? -1, filter.offset ?? 0)
      .map(mapRun);
  }

  /**
   * Transition a run's status, optionally recording the outcome (`output` on completion,
   * `error` on failure) and lifecycle timestamps in the same write — a crash can never leave
   * a terminal status without its outcome.
   */
  updateRunStatus(
    id: string,
    status: RunStatus,
    opts: {
      error?: RunErrorShape;
      output?: JsonValue;
      startedAt?: number;
      endedAt?: number;
      /** Present ⇒ set wake_at (a number arms a timed wake; `null` clears it on resume). */
      wakeAt?: number | null;
    } = {},
  ): void {
    const sets = ["status = ?"];
    const params: SQLInputValue[] = [status];
    if (opts.error !== undefined) {
      sets.push("error = ?");
      params.push(JSON.stringify(opts.error));
    }
    if (opts.output !== undefined) {
      sets.push("output = ?");
      params.push(JSON.stringify(opts.output));
    }
    if (opts.startedAt !== undefined) {
      sets.push("started_at = ?");
      params.push(opts.startedAt);
    }
    if (opts.endedAt !== undefined) {
      sets.push("ended_at = ?");
      params.push(opts.endedAt);
    }
    // Present-key (not value) decides: { wakeAt: null } clears, absence leaves it unchanged.
    if (Object.hasOwn(opts, "wakeAt")) {
      sets.push("wake_at = ?");
      params.push(opts.wakeAt ?? null);
    }
    const result = this.prepare(`UPDATE runs SET ${sets.join(", ")} WHERE id = ?`).run(
      ...params,
      id,
    );
    if (Number(result.changes) === 0) {
      throw new EngineError("NOT_FOUND", `run ${id} not found`);
    }
  }

  /**
   * Bump the restart counter and return the new value in one statement, so the supervisor's
   * "have we exhausted restarts?" check is race-free even across its own crash-recovery.
   */
  incrementRestarts(id: string): number {
    const row = this.prepare(
      "UPDATE runs SET restarts = restarts + 1 WHERE id = ? RETURNING restarts",
    ).get(id);
    if (row === undefined) throw new EngineError("NOT_FOUND", `run ${id} not found`);
    return readInteger(row, "runs", "restarts");
  }

  /**
   * Accumulate leaf usage onto the run's tallies. Additive (not a set) because each `agent()`
   * leaf reports independently and budgets are checked against the running total.
   */
  addRunUsage(
    id: string,
    usage: { tokensIn?: number; tokensOut?: number; usdMicros?: number },
  ): void {
    const tokensIn = usage.tokensIn ?? 0;
    const tokensOut = usage.tokensOut ?? 0;
    const usdMicros = usage.usdMicros ?? 0;
    assertCountInteger(tokensIn, "tokensIn");
    assertCountInteger(tokensOut, "tokensOut");
    assertCountInteger(usdMicros, "usdMicros");
    const result = this.prepare(
      `UPDATE runs SET tokens_in = tokens_in + ?, tokens_out = tokens_out + ?, usd_micros = usd_micros + ?
       WHERE id = ?`,
    ).run(tokensIn, tokensOut, usdMicros, id);
    if (Number(result.changes) === 0) {
      throw new EngineError("NOT_FOUND", `run ${id} not found`);
    }
  }

  /** Current usage tallies for budget enforcement. Throws NOT_FOUND on an unknown run. */
  getRunUsage(id: string): { tokensIn: number; tokensOut: number; usdMicros: number } {
    const row = this.prepare("SELECT tokens_in, tokens_out, usd_micros FROM runs WHERE id = ?").get(
      id,
    );
    if (row === undefined) throw new EngineError("NOT_FOUND", `run ${id} not found`);
    return {
      tokensIn: readInteger(row, "runs", "tokens_in"),
      tokensOut: readInteger(row, "runs", "tokens_out"),
      usdMicros: readInteger(row, "runs", "usd_micros"),
    };
  }

  // --------------------------------------------------------------------------
  // Run events (append-only)
  // --------------------------------------------------------------------------

  /**
   * Append a batch of events in one transaction: all rows land or none do, so a consumer can
   * never observe a half-written batch and cursor resumption stays gap-free. A duplicate
   * cursor throws CONFLICT — the log is append-only and a cursor is never rewritten.
   */
  appendEvents(runId: string, rows: readonly { cursor: number; event: RunEvent }[]): void {
    if (rows.length === 0) return;
    for (const row of rows) {
      if (!Number.isInteger(row.cursor) || row.cursor < 1) {
        throw new EngineError(
          "VALIDATION",
          `event cursor must be a positive integer (got ${String(row.cursor)})`,
        );
      }
    }
    this.transaction(() => {
      const insert = this.prepare(
        "INSERT INTO run_events (run_id, cursor, event) VALUES (?, ?, ?)",
      );
      for (const row of rows) {
        try {
          insert.run(runId, row.cursor, JSON.stringify(row.event));
        } catch (err) {
          if (isUniqueViolation(err)) {
            throw new EngineError(
              "CONFLICT",
              `event cursor ${String(row.cursor)} already exists for run ${runId}`,
            );
          }
          if (isForeignKeyViolation(err)) {
            throw new EngineError("NOT_FOUND", `run ${runId} not found`);
          }
          throw err;
        }
      }
    });
  }

  /** Events in cursor order, optionally resuming after a cursor (SSE `Last-Event-ID`). */
  listEvents(runId: string, opts: { afterCursor?: number; limit?: number } = {}): EventRow[] {
    return this.prepare(
      "SELECT * FROM run_events WHERE run_id = ? AND cursor > ? ORDER BY cursor ASC LIMIT ?",
    )
      .all(runId, opts.afterCursor ?? 0, opts.limit ?? -1)
      .map(mapEvent);
  }

  /** The run's latest cursor, or 0 when it has no events (cursors are 1-based). */
  maxCursor(runId: string): number {
    const row = this.prepare(
      "SELECT COALESCE(MAX(cursor), 0) AS max_cursor FROM run_events WHERE run_id = ?",
    ).get(runId);
    // An aggregate always yields one row; its absence means the connection is broken.
    if (row === undefined) throw new EngineError("INTERNAL", "MAX(cursor) returned no row");
    return readInteger(row, "run_events", "max_cursor");
  }

  // --------------------------------------------------------------------------
  // Cron fires (exactly-once)
  // --------------------------------------------------------------------------

  /**
   * Record that a cron tick fired. The (workflowId, triggerIndex, fireTime) primary key is the
   * exactly-once guarantee: a scheduler that crashed after firing and restarted gets CONFLICT
   * here instead of silently double-running the workflow. Callers wrap this with createRun in
   * one {@link transaction} so the fire record and the run commit together.
   */
  recordCronFire(args: {
    workflowId: string;
    triggerIndex: number;
    fireTime: number;
    runId: string;
  }): void {
    try {
      this.prepare(
        `INSERT INTO cron_fires (workflow_id, trigger_index, fire_time, run_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(args.workflowId, args.triggerIndex, args.fireTime, args.runId, this.now());
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new EngineError(
          "CONFLICT",
          `cron fire already recorded for workflow ${args.workflowId} ` +
            `trigger ${String(args.triggerIndex)} at ${String(args.fireTime)}`,
        );
      }
      if (isForeignKeyViolation(err)) {
        throw new EngineError(
          "NOT_FOUND",
          `workflow ${args.workflowId} or run ${args.runId} not found`,
        );
      }
      throw err;
    }
  }

  /** The latest recorded fire time for a trigger, or null — the catch-up policy's anchor. */
  lastCronFire(workflowId: string, triggerIndex: number): number | null {
    const row = this.prepare(
      "SELECT MAX(fire_time) AS last_fire FROM cron_fires WHERE workflow_id = ? AND trigger_index = ?",
    ).get(workflowId, triggerIndex);
    return row === undefined ? null : readIntegerOrNull(row, "cron_fires", "last_fire");
  }

  // --------------------------------------------------------------------------
  // Artifacts
  // --------------------------------------------------------------------------

  /** Record an artifact's metadata (the bytes live on disk at `path`, never in SQLite). */
  createArtifact(args: {
    runId: string;
    name: string;
    contentType: string;
    path: string;
    size: number;
    metadata?: Record<string, unknown>;
  }): ArtifactRow {
    assertCountInteger(args.size, "artifact size");
    const metadataJson = serializeJson(args.metadata, "artifact metadata");
    const t = this.now();
    const id = ulid(t);
    try {
      this.prepare(
        `INSERT INTO artifacts (id, run_id, name, content_type, path, size, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, args.runId, args.name, args.contentType, args.path, args.size, metadataJson, t);
    } catch (err) {
      if (isForeignKeyViolation(err)) {
        throw new EngineError("NOT_FOUND", `run ${args.runId} not found`);
      }
      throw err;
    }
    const row = this.prepare("SELECT * FROM artifacts WHERE id = ?").get(id);
    if (row === undefined) throw new EngineError("INTERNAL", `artifact ${id} vanished mid-write`);
    return mapArtifact(row);
  }

  /** A run's artifacts in creation order (ULIDs sort by time). */
  listArtifacts(runId: string): ArtifactRow[] {
    return this.prepare("SELECT * FROM artifacts WHERE run_id = ? ORDER BY id ASC")
      .all(runId)
      .map(mapArtifact);
  }

  // --------------------------------------------------------------------------
  // Run journal (durable-seam memoization)
  // --------------------------------------------------------------------------

  /** The memoized entry for a seam, or null if it hasn't run yet (a replay miss). */
  getJournalEntry(runId: string, seq: number): JournalRow | null {
    const row = this.prepare("SELECT * FROM run_journal WHERE run_id = ? AND seq = ?").get(
      runId,
      seq,
    );
    return row === undefined ? null : mapJournal(row);
  }

  /**
   * Record a seam's journal entry, idempotent on (run_id, seq): if the row already exists (e.g. a
   * crash between the write and the suspend, then a replay), the EXISTING row wins and is
   * returned — a seq is memoized exactly once.
   */
  putJournalEntry(entry: {
    runId: string;
    seq: number;
    kind: JournalKind;
    fingerprint: string;
    label?: string | null;
    state: JournalState;
    result?: JsonValue | null;
  }): JournalRow {
    const resultJson = serializeJson(entry.result, "journal result");
    return this.transaction(() => {
      const existing = this.getJournalEntry(entry.runId, entry.seq);
      if (existing !== null) return existing;
      const t = this.now();
      try {
        this.prepare(
          `INSERT INTO run_journal (run_id, seq, kind, fingerprint, label, state, result, created_at, resolved_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          entry.runId,
          entry.seq,
          entry.kind,
          entry.fingerprint,
          entry.label ?? null,
          entry.state,
          resultJson,
          t,
          entry.state === "resolved" ? t : null,
        );
      } catch (err) {
        if (isForeignKeyViolation(err)) {
          throw new EngineError("NOT_FOUND", `run ${entry.runId} not found`);
        }
        throw err;
      }
      const row = this.getJournalEntry(entry.runId, entry.seq);
      if (row === null) {
        throw new EngineError(
          "INTERNAL",
          `journal entry ${entry.runId}/${String(entry.seq)} vanished mid-write`,
        );
      }
      return row;
    });
  }

  /** Resolve a pending journal entry with its memoized result (the awaited event arrived). */
  resolveJournalEntry(runId: string, seq: number, result: JsonValue): void {
    const resultJson = serializeJson(result, "journal result");
    const changed = this.prepare(
      "UPDATE run_journal SET state = 'resolved', result = ?, resolved_at = ? WHERE run_id = ? AND seq = ?",
    ).run(resultJson, this.now(), runId, seq);
    if (Number(changed.changes) === 0) {
      throw new EngineError("NOT_FOUND", `journal entry ${runId}/${String(seq)} not found`);
    }
  }

  /** A run's full journal in seq order (replay seeding + debugging). */
  listJournal(runId: string): JournalRow[] {
    return this.prepare("SELECT * FROM run_journal WHERE run_id = ? ORDER BY seq ASC")
      .all(runId)
      .map(mapJournal);
  }

  // --------------------------------------------------------------------------
  // Human-input requests (human-in-the-loop gates)
  // --------------------------------------------------------------------------

  /** Create a pending human-input request (its run_journal entry is written separately). */
  createHumanInputRequest(args: {
    runId: string;
    seq: number;
    key: string;
    prompt: string;
    inputSpec: JsonValue;
    assignees?: readonly string[] | null;
    expiresAt?: number | null;
  }): HumanInputRequestRow {
    const specJson = serializeJson(args.inputSpec, "human-input spec");
    const assigneesJson = serializeJson(
      args.assignees == null ? null : [...args.assignees],
      "human-input assignees",
    );
    const t = this.now();
    const id = ulid(t);
    try {
      this.prepare(
        `INSERT INTO human_input_requests
           (id, run_id, seq, key, prompt, input_spec, assignees, status, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      ).run(
        id,
        args.runId,
        args.seq,
        args.key,
        args.prompt,
        specJson,
        assigneesJson,
        t,
        args.expiresAt ?? null,
      );
    } catch (err) {
      if (isForeignKeyViolation(err)) {
        throw new EngineError("NOT_FOUND", `run ${args.runId} not found`);
      }
      throw err;
    }
    const row = this.prepare("SELECT * FROM human_input_requests WHERE id = ?").get(id);
    if (row === undefined) {
      throw new EngineError("INTERNAL", `human-input request ${id} vanished mid-write`);
    }
    return mapHumanInputRequest(row);
  }

  getHumanInputRequest(id: string): HumanInputRequestRow | null {
    const row = this.prepare("SELECT * FROM human_input_requests WHERE id = ?").get(id);
    return row === undefined ? null : mapHumanInputRequest(row);
  }

  /** The pending request for (run, key), or null — the respond-by-key lookup. */
  findPendingHumanInputRequest(runId: string, key: string): HumanInputRequestRow | null {
    const row = this.prepare(
      "SELECT * FROM human_input_requests WHERE run_id = ? AND key = ? AND status = 'pending' ORDER BY seq DESC",
    ).get(runId, key);
    return row === undefined ? null : mapHumanInputRequest(row);
  }

  /** List requests newest-first, optionally filtered by run and/or status (the inbox query). */
  listHumanInputRequests(
    filter: { runId?: string; statuses?: readonly HumanInputStatus[] } = {},
  ): HumanInputRequestRow[] {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (filter.runId !== undefined) {
      where.push("run_id = ?");
      params.push(filter.runId);
    }
    if (filter.statuses !== undefined) {
      if (filter.statuses.length === 0) return [];
      where.push(`status IN (${filter.statuses.map(() => "?").join(", ")})`);
      params.push(...filter.statuses);
    }
    const whereSql = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "";
    return this.prepare(
      `SELECT * FROM human_input_requests${whereSql} ORDER BY created_at DESC, rowid DESC`,
    )
      .all(...params)
      .map(mapHumanInputRequest);
  }

  /**
   * Atomically resolve a PENDING request with its validated response. Returns the updated row,
   * or null if it was no longer pending (already answered/expired/cancelled) — the caller turns
   * that into a conflict, so two responders can't both win.
   */
  resolveHumanInputRequest(
    id: string,
    response: JsonValue,
    respondedBy?: string | null,
  ): HumanInputRequestRow | null {
    const responseJson = serializeJson(response, "human-input response");
    const changed = this.prepare(
      `UPDATE human_input_requests SET status = 'resolved', response = ?, responded_by = ?, responded_at = ?
       WHERE id = ? AND status = 'pending'`,
    ).run(responseJson, respondedBy ?? null, this.now(), id);
    if (Number(changed.changes) === 0) return null;
    return this.getHumanInputRequest(id);
  }

  /** Mark a pending request expired/cancelled (timeout, or the run was cancelled). No-op otherwise. */
  closeHumanInputRequest(id: string, status: "expired" | "cancelled"): void {
    this.prepare(
      "UPDATE human_input_requests SET status = ?, responded_at = ? WHERE id = ? AND status = 'pending'",
    ).run(status, this.now(), id);
  }

  /** Cancel every pending request for a run (called when the run is cancelled). */
  cancelPendingHumanInputRequests(runId: string): void {
    this.prepare(
      "UPDATE human_input_requests SET status = 'cancelled', responded_at = ? WHERE run_id = ? AND status = 'pending'",
    ).run(this.now(), runId);
  }

  // --------------------------------------------------------------------------
  // Timed wake
  // --------------------------------------------------------------------------

  /** Suspended runs whose timed wake is due (long sleep / human-input timeout). */
  listRunsToWake(now: number): RunRow[] {
    return this.prepare(
      `SELECT * FROM runs WHERE status IN ('sleeping', 'awaiting_input') AND wake_at IS NOT NULL AND wake_at <= ?
       ORDER BY wake_at ASC`,
    )
      .all(now)
      .map(mapRun);
  }

  // --------------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------------

  private prepare(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (statement === undefined) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  private getRunOrThrow(id: string): RunRow {
    const run = this.getRun(id);
    if (run === null) throw new EngineError("INTERNAL", `run ${id} vanished mid-write`);
    return run;
  }
}

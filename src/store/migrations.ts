// SPDX-License-Identifier: Apache-2.0

// Versioned, forward-only schema migrations for the engine database.
//
// The schema version lives in SQLite's `PRAGMA user_version` (an integer in the database
// header): reading it costs nothing, needs no bookkeeping table, and — crucially — setting it
// participates in the same transaction as the migration's DDL. A crash mid-migration therefore
// leaves the database exactly at the previous version with none of the new schema applied
// (multi-row writes are transactional; a half-migrated database is a state
// the engine could not recover from).
//
// Forward-only: an older engine refuses a newer database instead of guessing what future
// columns mean. Downgrades are restore-from-backup, not code.

import type { DatabaseSync } from "node:sqlite";
import { EngineError } from "../errors.js";

export interface Migration {
  /** The schema version this migration produces — `PRAGMA user_version` after it applies. */
  readonly version: number;
  /**
   * The DDL/DML for this migration. Must not contain transaction control (BEGIN/COMMIT) —
   * {@link migrate} wraps each migration and its version bump in one transaction.
   */
  readonly sql: string;
}

// v1 — the full SPEC §4 schema. STRICT tables so SQLite enforces the declared column types
// (a TEXT primary key can never silently hold an integer; INTEGER columns reject REALs).
// All timestamps are integer milliseconds since epoch; all ids are ULIDs.
const V1_SQL = `
-- Workflows: the deployed unit. \`manifest\` is the validated JSON projection of the program's
-- pure-literal meta; \`program\` is the bundled ESM source the run host executes; \`config\` is
-- the per-deploy JSON config object.
CREATE TABLE workflows (
  id          TEXT PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  manifest    TEXT NOT NULL,
  program     TEXT NOT NULL,
  config      TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
) STRICT;

-- Runs: one row per run, owned by run-lifecycle code. \`status\` holds the SDK RunStatus values;
-- \`error\` is a JSON {code,message}; usage tallies accumulate from leaf usage reports.
CREATE TABLE runs (
  id               TEXT PRIMARY KEY,
  workflow_id      TEXT NOT NULL REFERENCES workflows (id),
  status           TEXT NOT NULL,
  trigger_kind     TEXT NOT NULL,
  input            TEXT,
  output           TEXT,
  error            TEXT,
  parent_run_id    TEXT REFERENCES runs (id),
  idempotency_key  TEXT,
  restarts         INTEGER NOT NULL DEFAULT 0,
  tokens_in        INTEGER NOT NULL DEFAULT 0,
  tokens_out       INTEGER NOT NULL DEFAULT 0,
  usd_micros       INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  started_at       INTEGER,
  ended_at         INTEGER
) STRICT;

-- The workflows.call idempotent re-attach guarantee: a restarted parent re-running the same
-- call site finds the child it already spawned instead of spawning a second one. Partial so
-- runs without a key are unconstrained.
CREATE UNIQUE INDEX runs_parent_idempotency_key
  ON runs (parent_run_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- The recovery sweep ("which runs are still running?") and per-workflow run lists.
CREATE INDEX runs_workflow_id_status ON runs (workflow_id, status);
CREATE INDEX runs_status ON runs (status);

-- Run events: the append-only event log implementing the SDK wire format. The (run_id, cursor)
-- primary key IS the append-only guarantee — a cursor can never be rewritten.
CREATE TABLE run_events (
  run_id  TEXT NOT NULL REFERENCES runs (id),
  cursor  INTEGER NOT NULL,
  event   TEXT NOT NULL,
  PRIMARY KEY (run_id, cursor)
) STRICT, WITHOUT ROWID;

-- Cron fires: the exactly-once guarantee. The scheduler records the fire in the same
-- transaction as the run it creates; a duplicate (workflow, trigger, fire-time) is a CONFLICT,
-- so a restarted scheduler can never double-fire a tick it already handled.
CREATE TABLE cron_fires (
  workflow_id    TEXT NOT NULL REFERENCES workflows (id),
  trigger_index  INTEGER NOT NULL,
  fire_time      INTEGER NOT NULL,
  run_id         TEXT NOT NULL REFERENCES runs (id),
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (workflow_id, trigger_index, fire_time)
) STRICT, WITHOUT ROWID;

-- Artifacts: metadata for files written via artifacts.write; \`path\` points into the engine's
-- content-addressed store on disk (the bytes never live in SQLite).
CREATE TABLE artifacts (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES runs (id),
  name          TEXT NOT NULL,
  content_type  TEXT NOT NULL,
  path          TEXT NOT NULL,
  size          INTEGER NOT NULL,
  metadata      TEXT,
  created_at    INTEGER NOT NULL
) STRICT;

CREATE INDEX artifacts_run_id ON artifacts (run_id);
`;

// v2 — durable suspension. The run journal memoizes durable-seam results so a resumed run
// REPLAYS them instead of recomputing; (run_id, seq) is the program's synchronous monotonic
// key. human_input_requests is a pending human-in-the-loop gate. runs.wake_at is the due time
// for a TIMED suspension (long sleep / human-input timeout), NULL otherwise — the resume sweep
// queries it.
const V2_SQL = `
ALTER TABLE runs ADD COLUMN wake_at INTEGER;

-- Run journal: one row per durable-seam call. \`state\` is pending|resolved; \`result\` is the
-- memoized JSON value once resolved (or a parked-leaf checkpoint while pending). On replay a
-- resolved hit returns \`result\` without re-executing; a \`fingerprint\` mismatch is a
-- determinism error. (run_id, seq) is the append key — a seq is written once.
CREATE TABLE run_journal (
  run_id       TEXT NOT NULL REFERENCES runs (id),
  seq          INTEGER NOT NULL,
  kind         TEXT NOT NULL,
  fingerprint  TEXT NOT NULL,
  label        TEXT,
  state        TEXT NOT NULL,
  result       TEXT,
  created_at   INTEGER NOT NULL,
  resolved_at  INTEGER,
  PRIMARY KEY (run_id, seq)
) STRICT, WITHOUT ROWID;

-- Human-input requests: a pending HITL gate. \`input_spec\` is the JSON form descriptor
-- (text|choice|multiselect); \`response\` is the validated answer once submitted. \`seq\` links
-- the request to its run_journal entry.
CREATE TABLE human_input_requests (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES runs (id),
  seq           INTEGER NOT NULL,
  key           TEXT NOT NULL,
  prompt        TEXT NOT NULL,
  input_spec    TEXT NOT NULL,
  assignees     TEXT,
  status        TEXT NOT NULL,
  response      TEXT,
  responded_by  TEXT,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER,
  responded_at  INTEGER
) STRICT;

CREATE INDEX human_input_requests_run_id ON human_input_requests (run_id);
CREATE INDEX human_input_requests_status ON human_input_requests (status);

-- Timed-wake lookup: suspended runs whose wake_at has passed.
CREATE INDEX runs_wake_at ON runs (wake_at) WHERE wake_at IS NOT NULL;
`;

/** Every migration the engine knows, ascending. Append-only — never edit a shipped entry. */
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, sql: V1_SQL },
  { version: 2, sql: V2_SQL },
];

/**
 * Bring `db` up to the latest schema version. Idempotent: already-applied versions are
 * skipped via `PRAGMA user_version`, so calling this on every open is the deployment story —
 * there is no separate "migrate" command to forget. Each pending migration applies in its own
 * transaction together with the version bump (all-or-nothing per version).
 *
 * The `migrations` parameter exists for tests; production callers use the default.
 */
export function migrate(db: DatabaseSync, migrations: readonly Migration[] = MIGRATIONS): void {
  assertWellFormed(migrations);
  const latest = migrations.at(-1)?.version ?? 0;
  const current = readUserVersion(db);
  if (current > latest) {
    throw new EngineError(
      "INTERNAL",
      `database schema version ${String(current)} is newer than this engine understands ` +
        `(latest known: ${String(latest)})`,
      "upgrade the engine, or point it at a database created by this engine version",
    );
  }
  for (const migration of migrations) {
    if (migration.version <= current) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(migration.sql);
      // Why interpolation: PRAGMA statements cannot take bound parameters. Safe — the version
      // is validated as a positive integer by assertWellFormed above.
      db.exec(`PRAGMA user_version = ${String(migration.version)}`);
      db.exec("COMMIT");
    } catch (err) {
      // Why best-effort: some SQLite errors abort the transaction themselves, making an
      // explicit ROLLBACK fail with "no transaction is active"; the original error is the one
      // that matters either way.
      try {
        db.exec("ROLLBACK");
      } catch {
        // Intentionally ignored — see above.
      }
      throw err;
    }
  }
}

// Why validate the list (it's a compile-time constant): a typo'd or reordered version number
// would silently skip or re-apply DDL on user databases — fail loudly at boot instead.
function assertWellFormed(migrations: readonly Migration[]): void {
  let previous = 0;
  for (const migration of migrations) {
    if (!Number.isInteger(migration.version) || migration.version <= previous) {
      throw new EngineError(
        "INTERNAL",
        `migration versions must be strictly ascending positive integers ` +
          `(got ${String(migration.version)} after ${String(previous)})`,
      );
    }
    previous = migration.version;
  }
}

function readUserVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get();
  const value = row?.user_version;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  throw new EngineError("INTERNAL", "could not read PRAGMA user_version from the database");
}

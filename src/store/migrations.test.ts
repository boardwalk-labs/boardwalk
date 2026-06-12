import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { EngineError } from "../errors.js";
import { MIGRATIONS, migrate, type Migration } from "./migrations.js";

const LATEST_VERSION = MIGRATIONS.at(-1)?.version ?? 0;

let openDbs: DatabaseSync[] = [];

function openDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  openDbs.push(db);
  return db;
}

afterEach(() => {
  for (const db of openDbs) {
    try {
      db.close();
    } catch {
      // Already closed by the test.
    }
  }
  openDbs = [];
});

function userVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get();
  const value = row?.user_version;
  if (typeof value !== "number") throw new Error("user_version not a number");
  return value;
}

function tableNames(db: DatabaseSync): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((row) => {
      const name = row.name;
      if (typeof name !== "string") throw new Error("table name not a string");
      return name;
    })
    .sort();
}

function expectEngineError(fn: () => unknown, code: EngineError["code"]): void {
  let thrown: unknown;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(EngineError);
  if (thrown instanceof EngineError) expect(thrown.code).toBe(code);
}

describe("migrate", () => {
  it("brings an empty database to the latest version with all v1 tables and indexes", () => {
    const db = openDb();
    migrate(db);
    expect(userVersion(db)).toBe(LATEST_VERSION);
    expect(tableNames(db)).toEqual(["artifacts", "cron_fires", "run_events", "runs", "workflows"]);
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((row) => row.name)
      .sort();
    expect(indexes).toEqual([
      "artifacts_run_id",
      "runs_parent_idempotency_key",
      "runs_status",
      "runs_workflow_id_status",
    ]);
  });

  it("is idempotent: re-running on an up-to-date database is a no-op", () => {
    const db = openDb();
    migrate(db);
    // Re-applying v1 would fail (CREATE TABLE without IF NOT EXISTS), so not throwing here
    // proves the user_version short-circuit skipped it.
    migrate(db);
    expect(userVersion(db)).toBe(LATEST_VERSION);
  });

  it("applies only migrations newer than the current version", () => {
    const db = openDb();
    const v1: Migration = { version: 1, sql: "CREATE TABLE one (id TEXT PRIMARY KEY) STRICT;" };
    const v2: Migration = { version: 2, sql: "CREATE TABLE two (id TEXT PRIMARY KEY) STRICT;" };
    migrate(db, [v1]);
    expect(userVersion(db)).toBe(1);
    migrate(db, [v1, v2]);
    expect(userVersion(db)).toBe(2);
    expect(tableNames(db)).toEqual(["one", "two"]);
  });

  it("refuses a database newer than the engine (forward-only)", () => {
    const db = openDb();
    db.exec("PRAGMA user_version = 9999");
    expectEngineError(() => migrate(db), "INTERNAL");
  });

  it("rolls back a failing migration atomically (no partial DDL, version unchanged)", () => {
    const db = openDb();
    const broken: Migration = {
      version: 1,
      sql: "CREATE TABLE good (id TEXT PRIMARY KEY) STRICT; THIS IS NOT SQL;",
    };
    expect(() => migrate(db, [broken])).toThrow();
    expect(userVersion(db)).toBe(0);
    expect(tableNames(db)).toEqual([]);
  });

  it("rejects a malformed migration list (non-ascending versions)", () => {
    const db = openDb();
    const a: Migration = { version: 2, sql: "SELECT 1;" };
    const b: Migration = { version: 1, sql: "SELECT 1;" };
    expectEngineError(() => migrate(db, [a, b]), "INTERNAL");
    expectEngineError(() => migrate(db, [{ version: 0, sql: "SELECT 1;" }]), "INTERNAL");
    expectEngineError(() => migrate(db, [{ version: 1.5, sql: "SELECT 1;" }]), "INTERNAL");
  });

  it("enforces foreign keys and the runs idempotency unique index in the v1 schema", () => {
    const db = openDb();
    migrate(db);
    // FK: a run cannot reference a missing workflow.
    expect(() =>
      db
        .prepare(
          "INSERT INTO runs (id, workflow_id, status, trigger_kind, created_at) VALUES ('r', 'nope', 'queued', 'manual', 0)",
        )
        .run(),
    ).toThrow(/FOREIGN KEY/);
    // Partial unique index: same (parent, key) twice is rejected.
    db.prepare("INSERT INTO workflows VALUES ('w', 'wf', '{}', '', '{}', 0, 0)").run();
    const insertRun = db.prepare(
      `INSERT INTO runs (id, workflow_id, status, trigger_kind, parent_run_id, idempotency_key, created_at)
       VALUES (?, 'w', 'queued', 'manual', ?, ?, 0)`,
    );
    insertRun.run("parent", null, null);
    insertRun.run("childA", "parent", "k");
    expect(() => insertRun.run("childB", "parent", "k")).toThrow(/UNIQUE/);
    // NULL keys are unconstrained (the index is partial).
    insertRun.run("childC", "parent", null);
    insertRun.run("childD", "parent", null);
  });
});

# Changelog

Notable changes to `@boardwalk-labs/engine` (and the `ghcr.io/boardwalk-labs/boardwalk` image).
Pre-1.0, changes ship as patch releases.

## 0.1.1

### Added

- **Self-host deploy: `BOARDWALK_WORKFLOWS_DIR` boot-load.** The server now deploys every built
  workflow (`.mjs`/`.js`, single-file with `@boardwalk-labs/workflow` external — what
  `boardwalk build` emits) from the workflows directory (default `<dataDir>/workflows`,
  `/data/workflows` in Docker) on boot, idempotent by manifest name. `docker run` + a mounted
  workflows dir now actually runs your workflows. A missing dir is fine; a bad file is logged and
  skipped, never fatal.

### Fixed

- `output()` declared before a program throws is now preserved on `failed` runs (the
  verdict-then-throw pattern) — it was previously dropped on the failure path.

## 0.1.0

Initial release: the single-node engine (server + embedded modes), cron scheduling, hold-and-pay
run semantics, SQLite run history, the local run log, the conformance suite, and the
`ghcr.io/boardwalk-labs/boardwalk` Docker image.

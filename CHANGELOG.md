# Changelog

Notable changes to `@boardwalk-labs/engine` (and the `ghcr.io/boardwalk-labs/boardwalk` image).
Pre-1.0, changes ship as patch releases.

## 0.1.8

### Added

- **Default-on built-in coding tools.** `agent()` ships a coding toolset by default, so `agent(prompt)`
  with nothing named can read, edit, and run commands in the run's workspace. Tier 1 (sandbox-native):
  `bash`, `read`, `write`, `edit`, `ls`, `grep`, `glob`, `apply_patch`. Tier 2 (host-backed):
  `webfetch`, `web_search`, `artifacts`. Scope them with the SDK's `builtins` option (`'all'`,
  `'read-only'`, `'none'`, or an explicit name list). The host-backed tools are served by a `ToolHost`
  backend; the single-node engine wires local defaults (in-process fetch, an env-configured search
  provider, data-dir artifacts).
- `bash` is a security boundary for autonomous runs: a command allowlist plus a denylist, refusal of
  command/process substitution and I/O redirection, per-line and per-segment allowlist checks, a
  workspace-confined working directory, and output + timeout caps.

### Changed

- Requires `@boardwalk-labs/workflow@^0.1.6` (the `builtins` option, and `tools` narrowed to inline
  ToolDefs).

## 0.1.7

### Added

- **`@boardwalk-labs/engine/core` entrypoint.** A new subpath that exports the agent execution core
  (`runAgentLeaf`, the `LeafIo` seam, the provider adapters, model resolution, and the `Redactor`)
  without the scheduler, store, or server. A separate runtime can run the same agent loop by
  supplying its own `LeafIo`, so there is one agent loop everywhere.
- **BYO Amazon Bedrock provider.** Configure a `protocol: "bedrock"` provider (region plus
  env-sourced AWS credentials) to run `agent()` against your own Bedrock account. SigV4 is
  hand-rolled on `node:crypto` (no AWS SDK) over a non-streaming `InvokeModel` call that reuses the
  Anthropic message format. Streaming is deferred.
- **Context summarization.** Long conversations are now bounded. When the running conversation
  exceeds a generous budget, the oldest middle is compacted in place into a model-written summary
  that preserves the task and the most recent turns and never splits a tool call from its result.
  The summary call is metered and redacted.

### Changed

- **The model call moved behind the `LeafIo` seam (`io.streamModel`).** The agent loop no longer
  resolves models or holds provider keys; the local engine resolves and calls providers in-process
  exactly as before, so `dev` and self-hosted behavior is unchanged. This is what lets a hosted
  runtime route the same loop's model calls through a broker.

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

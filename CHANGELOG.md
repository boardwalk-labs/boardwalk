# Changelog

Notable changes to `@boardwalk-labs/engine` (and the `ghcr.io/boardwalk-labs/boardwalk` image).
Pre-1.0, changes ship as patch releases.

## 0.1.25

### Fixed

- `budget.max_duration_seconds` now caps ACTIVE COMPUTE only — a long sleep, human-input gate, or
  child-wait that SUSPENDS (releases the process) no longer burns it. Previously the engine measured
  wall-clock from the original start, so a run that slept past its cap was budget-killed on wake
  (it now completes). This matches the hosted runtime (full parity): cumulative on-CPU time is
  tracked in a new `runs.active_ms` (migration v3) across segments + engine restarts.

### Added

- `budget.deadline_seconds` enforcement — the orthogonal WALL-CLOCK cap (start → now, suspended idle
  INCLUDED). Use it for "give up if the whole run isn't done within N real seconds" (e.g. an
  approval that legitimately waits but is stale after a day). The binding cap (sooner of compute vs
  deadline) drives the failure message. Requires `@boardwalk-labs/workflow@^0.1.13`.

## 0.1.22

### Added

- Durable child-wait release: a long-running `workflows.call` now RELEASES the parent's process
  (`waiting_for_child`) instead of holding it for the whole wait, completing the durable-suspension
  triad alongside sleep-release and human-in-the-loop. A SHORT child (one that runs straight to
  terminal) is still held in-process — cheaper than a release + replay; a LONG child (one that
  itself suspends — its own sleep, human-input gate, or child-wait) releases the parent too. The
  child's finalize wakes the parent, which re-attaches idempotently and reads the memoized output;
  a boot-recovery pass resumes any parent whose child finalized while the engine was down. The call
  is journaled (`workflow_call`), so the parent's restart/replay returns the child's output instead
  of re-spawning it.

## 0.1.17

### Changed

- Renamed the OpenAI-compatible reasoning encoder `reasoningToOpenRouter` to `reasoningToUnified`,
  and the `ChatArgs.reasoningStyle` discriminant value `"openrouter"` to `"unified"` (the managed
  lane's unified `reasoning` object). Breaking for direct callers of either symbol.

### Removed

- Dead unused exports `removeRunDir` (`run/run_dir.ts`) and `ParentToChild` (`run/ipc.ts`).

## 0.1.13

### Fixed

- A unified-diff hunk that begins with a removed line now stamps the correct new-side start in its
  `@@` header (was `+0,…` for a deletion-led hunk). The start is the first line shown on each side.

## 0.1.12

### Added

- Structured tool results for run observers. Built-in tools now publish a structured
  `tool_call_result` (`kind` + `data`) alongside the unchanged model-facing text: `bash` reports
  command/exitCode/stdout/stderr/duration, `read`/`ls`/`grep`/`glob` their captured output, and
  `write`/`edit`/`apply_patch` a unified diff with `+`/`-` counts (per file for `apply_patch`).
- Live tool output streaming via the `tool_output_delta` run-event kind: `bash` streams
  stdout/stderr chunks as they arrive, bounded per stream so a runaway command can't flood the
  event stream. Requires `@boardwalk-labs/workflow@^0.1.8`.

### Security

- The redactor deep-scrubs structured observer payloads (`Redactor.redactData`) and each streamed
  output chunk, so a tool result that inadvertently carries a known secret reaches neither the model
  nor the persisted event stream.

## 0.1.10

### Added

- **`AGENTS.md` now loads from two tiers — bundled package + workspace.** Every `agent()` leaf
  discovers `AGENTS.md` from both the deployed workflow **package** (the author's standing
  instructions, shipped alongside the program + `skills/`) and the run **workspace** (e.g. a codebase
  the run cloned). This mirrors the convention's general→specific hierarchy (Codex/opencode layer a
  standing config file over a walked repo): the **bundled tier is the single package-root file**
  (a bundled workflow has no meaningful runtime subtree — the program is one inlined module — so a
  nested `AGENTS.md` in the package would describe source that's bundled away; nested discovery is a
  workspace concern), and the **workspace tier is root plus nested** subtree files. This makes the
  bundled tier identical on every engine: one file written at the package root under `boardwalk dev`,
  one file extracted at the artifact root on the hosted platform. Blocks are concatenated
  bundled-first, then workspace (general→specific), each tagged
  `<AGENTS.md source="workflow|workspace" path="…">`. The existing caps (file count, per-file size,
  total size, truncation note) apply across the **combined** set, the bundled file claiming the
  budget first; a file reachable from both roots is **deduplicated by absolute realpath** (defensive
  — the engine always wires distinct dirs). New `ToolSetContext.programDir` (the workflow package
  root, parent of `skillsDir`) carries the bundled tier; `DeployArgs.agentsMd` ships the bundled file
  (deploy artifacts now live under a per-workflow package root, `<dataDir>/packages/<workflowId>/`,
  with `skills/` beside the bundled `AGENTS.md`). Zero new dependencies.

## 0.1.9

### Added

- **Default-on `AGENTS.md` project context.** Every `agent()` leaf auto-discovers `AGENTS.md` files in
  the run's workspace (the widely-adopted convention — the root file plus nested subtree files) and
  prepends them to the leaf's context, before skills (project rules frame the task; skills are the
  procedure). No option to set — it is on by convention, and a workspace with no `AGENTS.md` adds
  nothing. Each file is rendered as a labeled `<AGENTS.md path="…">` block tagged with its
  workspace-relative path. The walk is confined to the workspace, skips `node_modules`/`.git`/build
  dirs/dotdirs, and is bounded on file count, per-file size, and total size (truncation is noted). The
  content rides the same context channel as skills, so secret redaction already covers it. Zero new
  dependencies.
- **Engine-native LSP diagnostics — the autonomous self-correct edge.** After a successful `write` or
  `edit`, the file's language-server diagnostics (severity + line + message) are appended to the tool
  result, so an agent sees its type/lint errors and fixes them with no human in the loop. A new
  `diagnostics` built-in (in the `'read-only'` set) queries a file on demand. The engine spawns the
  language server in the run's workspace (no host backend needed), with a hand-rolled, zero-dependency
  LSP client (Content-Length framing over `node:child_process`). v1 ships TypeScript/JavaScript via
  `typescript-language-server --stdio` behind a pluggable ext→server registry; other languages drop in
  later. Best-effort: if the server binary is not on PATH, diagnostics are silently skipped (a short
  note, never an error or a hang), exactly like `grep`'s ripgrep→Node fallback. Every request is
  bounded, and language servers are shut down at run end (no leaked processes).

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

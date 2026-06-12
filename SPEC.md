# SPEC — `boardwalk` (the flagship engine)

> The open-source single-node runtime: scheduler, run engine, SQLite state, local run log. Published as `@boardwalk/engine` (npm) and `boardwalk/boardwalk` (Docker). Apache-2.0. Public in **Phase 2** — this repo never opens as an empty shell.
>
> Governing context: root [`MASTER_SPEC.md`](../MASTER_SPEC.md) §2.4 (run semantics), §3–5 (engines, permitted divergence, parity). The conformance suite lives here and is the arbiter of the parity promise.

## 1. Purpose

The engine that makes "open source" true: everything needed to schedule and run workflows on hardware the user owns, with no Boardwalk account. Two consumers, one implementation:

- **Server mode** (`boardwalk-server` binary / Docker): long-lived process — cron scheduling, webhook endpoint, SQLite run history, local run log UI.
- **Embedded mode** (consumed by `@boardwalk/cli` for `dev`): one run, in-process supervision, exit on terminal status. Same engine, no daemon.

## 2. Architecture

```
triggers (cron | manual | webhook) → scheduler → run lifecycle → program host (spawned process) → SDK host bridge
                                          │              │
                                          └── SQLite ────┘── run event log (append-only) → SSE/local UI
```

Layering (enforced; CODE_QUALITY §7.2): the scheduler knows nothing about what workflows do; run-lifecycle owns state transitions + persistence and knows nothing of HTTP; the program host executes the user's file and brokers its SDK calls; one persistence module owns all SQL.

### 2.1 Scheduler

- In-process cron (5/6-field exprs, IANA timezones — same validation as the manifest schema).
- **A due fire happens exactly once.** Fire records are written transactionally with run creation.
- **Catch-up policy on restart:** missed fires are detected and _skipped with a logged notice_ (default), per-workflow override `catch_up: "skip" | "once"` (run once for any number of missed fires). The override lives in the workflow's engine-side **deploy config**, not the manifest — the SDK manifest has no `catch_up` field; this is engine-operational policy, not workflow behavior. Never silent, never a thundering herd.
- `concurrency` manifest modes honored: `unlimited`, `serial` (queue next fire until prior run terminal), `serial_by_key`.

### 2.2 Run lifecycle

- Statuses exactly as MASTER_SPEC §2.4: `queued → pending → running → completed | failed | cancelled` (+ transitional `cancelling`).
- **One run = one spawned Node process** with an isolated working directory; the parent supervises. Liveness is the child's `exit` event (same machine — no heartbeat protocol needed; a hung program is caught by the duration budget); an engine-orphaned child exits on IPC disconnect and the boot sweep owns its restart.
- **The program arrives pre-bundled** (one ESM file, `@boardwalk/workflow` left external — the CLI bundles at deploy). The run dir carries a `node_modules/@boardwalk/workflow` symlink to the engine's own SDK install, so the program and the engine's child entry load ONE module instance (the SDK host seam is a module-level singleton) with no bundler in the engine.
- **Envelope authority is the supervisor's:** the child sends event _bodies_; the parent is the single place envelopes are stamped and cursors allocated, resuming past `maxCursor` across crash-restarts.
- **Hold-and-pay:** `sleep`/child-waits hold the child process. No checkpointing.
- **Restart-on-crash:** supervisor detects child death → run restarts from the top (bounded restarts, then `failed`). `workflows.call` children re-attach via idempotency key on the restarted pass.
- **Crash-safe state:** kill the _engine_ at any moment; on boot, a recovery sweep marks orphaned `running` rows → `pending` → restart. All multi-row writes are transactional (CODE_QUALITY §2.2).
- **Budgets enforced:** `max_duration_seconds` by supervisor timer; `max_tokens`/`max_usd` from leaf usage reports (USD via a bundled approximate rate table, documented as approximate).
- **Cancellation:** signal child (cooperative window) → kill after grace → `cancelled`.

### 2.3 The SDK host bridge (the `WorkflowHost` implementation)

| Host call                 | Local implementation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent()`                 | A real agentic loop (v1): streamed turns with **tool use** (built-in grants + program-defined `ToolDef`s executed in the program process), **MCP client** (stdio + HTTP servers from `meta.mcp`), **skills** (markdown resolved from the project's `skills/` dir), and **memory** (`opts.memory` names a directory declared in `workspace.persist`; the loop gets read/write file tools scoped there and loads its index at turn start). `schema` validates parsed JSON output; run fails on mismatch. Emits the standard turn/text/tool/usage events. A plain `agent(prompt)` with no selections is simple inference |
| model resolution          | Explicit `<provider>/<model-id>` ref → provider adapter (Anthropic / OpenAI / Google / any OpenAI-compatible `base_url`) with the key from env (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …) or engine config `providers.<name>.{base_url, api_key_env}`. Omitted model → `default_model` from engine config, else a helpful error                                                                                                                                                                                                                                                                                       |
| `secrets.get`             | Environment / `.env`; name must be in `meta.secrets`; missing → error naming the variable and where to set it. **Values never logged, never in `agent()` context** (redaction scrubs known secret values from prompts/results before the model call)                                                                                                                                                                                                                                                                                                                                                                  |
| `workflows.call/run`      | Child run rows in the same SQLite DB; idempotent re-attach by key                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `artifacts.write`         | Content-addressed files under the data dir; `url` = local file URL (server mode: served over the local UI)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `input`/`output`/`config` | Trigger payload / result column (validated against schemas) / per-deploy config in SQLite                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| workspace                 | Run working dir. `workspace.persist` (`true` or a directory list): declared dirs are **hydrated** from the engine's durable store at run start and **persisted back at successful run end** (local: per-workflow dirs under the data dir). Mid-run writes lost on crash are re-created by the restarted pass. Concurrent runs sharing a persistent dir are last-writer-wins — workflows using persistence/memory should prefer `concurrency: serial`; the validator warns on the combination                                                                                                                          |
| events                    | Append-only event log table implementing the wire format (envelope + run-global cursor)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

### 2.4 Server surface

- **Webhook trigger endpoint** (`POST /hooks/<workflow>/<trigger-id>`) with `token` or `signature` (HMAC) auth per the manifest. `<trigger-id>` is the trigger's zero-based index in `meta.triggers`.
- **Webhook auth scheme (v0 — this engine's answer to MASTER_SPEC §10's open question):** credentials live in _server_ environment variables named after the workflow (`<NAME>` = workflow name upper-cased, `-` → `_`). `auth: "token"` compares `Authorization: Bearer <token>` (constant-time) against `BOARDWALK_WEBHOOK_TOKEN__<NAME>`; `auth: "signature"` verifies `X-Boardwalk-Signature: sha256=<hex>` as HMAC-SHA256 over the raw request body keyed by `BOARDWALK_WEBHOOK_SECRET__<NAME>`. An unset variable fails closed (503, hint names the exact variable); a bad credential is 401.
- **Local run log UI + SSE tail** (resume by cursor) and a minimal JSON API (list workflows/runs, trigger manual run, cancel). The SSE endpoint implements **channel subscriptions** (SDK kind→channel mapping, filtered server-side): `?channels=phase,output` for a quiet tail, `?verbose=true` for everything; default `lifecycle + phase + output`. Bound to localhost by default; binding wider is an explicit flag with a warning (no auth story in v1 beyond webhook auth).
- Config via **environment variables** in v0 (`BOARDWALK_` prefix; a `boardwalk.toml` file is deferred — Node has no TOML built-in and the zero-dependency rule wins): data dir (`BOARDWALK_DATA_DIR`), bind address (`BOARDWALK_HOST` / `BOARDWALK_PORT`), default model (`BOARDWALK_DEFAULT_MODEL`), provider table (`BOARDWALK_PROVIDERS`, a JSON object `{"<name>": {"base_url": "…", "api_key_env": "…", "protocol": "openai" | "anthropic"}}` — e.g. `BOARDWALK_PROVIDERS='{"ollama":{"base_url":"http://localhost:11434/v1"}}'`), and the secret/`.env` source (`BOARDWALK_ENV_FILE`, default `<data-dir>/.env` when present).

### 2.5 What is **not** in this engine

No accounts/orgs/billing, no machine classes (`runs_on` ignored with a warning), no automatic model routing (MASTER*SPEC §6.1 — omitted model uses the \_configured default*, never a router), no egress policy enforcement, no Platform-extension manifest capabilities. Programs needing absent capabilities fail loudly at validation (capability-presence rule, §4). Note `tools`/`mcp`/`skills`/`memory` are **not** in this list — the full `agent()` capability set is core, implemented here.

## 3. The conformance suite

Lives in `conformance/`: small workflows + a harness that runs them against any engine and asserts observable behavior — sleep-through-engine-restart, crash-restart from the top, `workflows.call` idempotent re-attach, budget termination, secret redaction (a canary secret must not appear in any model request — asserted via a recording provider adapter; covers tool results, MCP traffic, skill and memory content), cancellation grace, event-stream shape + cursor resume + channel filtering, agent capability selection (undeclared tool/MCP/skill names and undeclared/escaping `memory` paths rejected at validation), program-defined tool round-trip, persistent-directory hydration + persistence across runs (including a memory dir written by one run and read by the next), concurrency modes, catch-up policy. CI runs it on every PR here; the Boardwalk platform runs the same suite against its engine, and a platform divergence is a platform bug.

## 4. Persistence (SQLite)

Tables: `workflows` (manifest + program ref + config), `runs` (status, timestamps, input/output, budget tallies), `run_events` (append-only, cursor-indexed), `cron_fires`, `artifacts`. ULIDs, integer-ms timestamps, Zod-validated JSON columns, WAL mode, transactional multi-row writes. Schema migrations ship with the engine and run on boot (versioned, forward-only).

## 5. Distribution

- `@boardwalk/engine` (the library: embedded mode + host implementation) and a thin `boardwalk-server` bin.
- Docker image `boardwalk/boardwalk`: server mode, volume-mounted data dir, sensible defaults. `docker run -v ./data:/data -p 8080:8080 boardwalk/boardwalk` is the README quickstart.
- Node 24 LTS floor.

## 6. Testing

Beyond the conformance suite: kill-and-restart property tests on the lifecycle (CODE_QUALITY §4.2), scheduler clock tests (fires, timezones, DST, catch-up), host-bridge unit tests with fake providers, webhook auth cases, migration tests on seeded older DBs.

## 7. Ready to go public when

The Phase 2 gates (MASTER_SPEC §9), restated as this repo's checklist:

1. Docker quickstart on a clean host: cron workflow scheduled, fired, visible in run history + local log UI — no account.
2. Survives: engine kill mid-run, child kill mid-run, multi-minute sleep, `workflows.call` chain — all per conformance.
3. Full conformance suite green in CI; every `boardwalk-examples` template passes under this engine.
4. `@boardwalk/cli dev` runs on the published `@boardwalk/engine`.
5. Publication checklist (MASTER_SPEC §8) passes.

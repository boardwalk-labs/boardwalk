# boardwalk

**The control plane for agent workflows, open source.** A Boardwalk workflow is a typed
TypeScript function — `export default async function run(input, context)` — plus a small
`workflow.jsonc` descriptor: schedule it, call LLM agents from it, sleep durably, compose
workflows out of workflows. Any trigger, any model, on infrastructure you own. Audit everything,
self-host it, leave anytime.

This repo is the **engine** that runs those workflows: the open-source, single-node core with
cron scheduling, durable run semantics, SQLite run history, and a local run log, on hardware you
own with no account. Same engine and same run semantics as the hosted Boardwalk platform; this is
the part you run yourself.

> **Status: pre-1.0.** Published and usable today — the engine ships as
> [`@boardwalk-labs/engine`](https://www.npmjs.com/package/@boardwalk-labs/engine) and the
> `ghcr.io/boardwalk-labs/boardwalk` Docker image. The contracts it implements are stable (see
> [`@boardwalk-labs/workflow`](https://www.npmjs.com/package/@boardwalk-labs/workflow)); APIs may
> still change before 1.0, and changes ship as patch releases (see [`CHANGELOG.md`](./CHANGELOG.md)).
> See [`SPEC.md`](./SPEC.md) for the architecture.

## What it is

The engine runs a workflow two ways:

- **Server mode** — `docker run ghcr.io/boardwalk-labs/boardwalk`: a long-lived process that schedules cron
  workflows, accepts webhooks, keeps run history in SQLite, and serves a local run log.
- **Embedded mode** — `@boardwalk-labs/engine` as a library: one run, in-process supervision, for
  hosts that embed the engine in their own process.

Same engine, same semantics as the Boardwalk platform: one run = one process, `sleep` holds the
process, a crash restarts the run from the top, `workflows.call` re-attaches idempotently.
The conformance suite in this repo tests that parity.

Reach for it when you want to run an AI agent on a schedule ("check the news every day at
9am"), respond to webhooks with an agent, or keep a background agent loop working toward a goal,
without hand-rolling cron plus a script plus retry logic. The [examples
repo](https://github.com/boardwalk-labs/examples) has copyable templates for each of those
shapes.

## Quickstart

Run the server with Docker — run history and state live in the mounted data dir:

```sh
docker run -v ./data:/data -p 8080:8080 ghcr.io/boardwalk-labs/boardwalk
```

Then open `http://localhost:8080` for the run log, or hit the JSON API
(`/api/workflows`, `/api/runs`). Webhook triggers land on `/hooks/<workflow>/<trigger-index>`.

### Deploying a workflow

A workflow deploys as a **package directory** in the engine's **workflows directory** — deployed
on boot (re-synced every boot; idempotent by slug, and an unchanged package doesn't bump the
workflow's version):

```
data/workflows/my-routine/
  workflow.jsonc     # the descriptor: slug, triggers, permissions, budget
  index.mjs          # the built entry, default-exporting run() (what `boardwalk build` emits)
  skills/            # optional — per-agent skills, deployed wholesale
  AGENTS.md          # optional — standing instructions every agent() reads
```

```sh
npx @boardwalk-labs/cli build --out ./data/workflows/my-routine/
docker run -v ./data:/data -p 8080:8080 ghcr.io/boardwalk-labs/boardwalk
```

The default workflows directory is `<data-dir>/workflows` (`/data/workflows` in Docker); override
it with `BOARDWALK_WORKFLOWS_DIR`. The entry is single-file built JavaScript with
`@boardwalk-labs/workflow` left external; the descriptor names another entry file via `entry` if
you don't use `index.mjs`. From there the descriptor's triggers take over: cron fires on schedule,
`POST /api/workflows/<slug>/runs` triggers a manual run, and webhooks land on
`/hooks/<workflow>/<trigger-index>`.

### Configuration

All configuration is environment variables (a `boardwalk.toml` file is deferred — see
[`SPEC.md`](./SPEC.md) §2.4):

| Variable                  | Default                                    | What it does                                                                                 |
| ------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `BOARDWALK_DATA_DIR`      | `/data` in Docker, else `./boardwalk-data` | Where everything lives: SQLite DB, run dirs, artifacts                                       |
| `BOARDWALK_WORKFLOWS_DIR` | `<data-dir>/workflows`                     | Directory of built workflows (`.mjs`/`.js`) deployed on boot                                 |
| `BOARDWALK_HOST`          | `127.0.0.1` (`0.0.0.0` in Docker)          | Bind address — this surface has no auth beyond webhook auth, so binding wider logs a warning |
| `BOARDWALK_PORT`          | `8080`                                     | Listen port (`0` picks a free port)                                                          |
| `BOARDWALK_DEFAULT_MODEL` | —                                          | Model used when `agent()` omits one, e.g. `anthropic/claude-sonnet-4-5`                      |
| `BOARDWALK_PROVIDERS`     | —                                          | JSON provider table, e.g. `{"ollama":{"base_url":"http://localhost:11434/v1"}}`              |
| `BOARDWALK_ENV_FILE`      | `<data-dir>/.env`, if it exists            | `.env` file backing `secrets.get` and provider API keys                                      |

Provider API keys come from the environment (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`GEMINI_API_KEY` for the built-ins; `api_key_env` names the variable for custom providers).

### Embedded mode

The same engine as a library — construct, run, close, all in your own process:

```ts
import { Engine } from "@boardwalk-labs/engine";

const engine = new Engine({ dataDir: "./boardwalk-data" });
const run = await engine.runOnce({
  descriptor: `{ "slug": "hello", "triggers": [{ "kind": "manual" }] }`,
  program: `export default async function run(input) { return { got: input }; }`,
  input: { n: 7 },
});
console.log(run.status, run.output);
engine.close();
```

`engine.deployWorkflowDir(dir)` deploys an on-disk package directory (the same shape the
workflows directory holds).

For OAuth-protected MCP servers an `agent()` call connects to, `engine.authorizeMcpServer(url, { onAuthorizationUrl })` performs the one-time interactive grant; after that, runs use (and silently refresh) the stored token headlessly — see [SPEC.md §2.3](./SPEC.md).

## The Boardwalk repos

- [`sdk-typescript`](https://github.com/boardwalk-labs/sdk-typescript) — `@boardwalk-labs/workflow`, the TypeScript API a workflow program imports.
- [`cli`](https://github.com/boardwalk-labs/cli) — `boardwalk`: scaffold, validate, run locally, deploy.
- [`examples`](https://github.com/boardwalk-labs/examples) — copyable workflow templates (`boardwalk init --template`).
- [`plugins`](https://github.com/boardwalk-labs/plugins) — coding-agent skills (Claude Code, Codex, Cursor, OpenClaw, OpenCode) + a control-plane MCP server.
- [`runner`](https://github.com/boardwalk-labs/runner) — self-hosted runner: your machines execute hosted-scheduled runs.
- [`runner-images`](https://github.com/boardwalk-labs/runner-images) — reproducible base images hosted runners execute in.

Hosted platform and docs: [boardwalk.sh](https://boardwalk.sh).

## License

Apache-2.0 — see [LICENSE](./LICENSE).

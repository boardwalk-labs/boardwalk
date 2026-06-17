# boardwalk

**The control plane for agent workflows, open source.** A Boardwalk workflow is a plain
TypeScript program: schedule it, call LLM agents from it, sleep durably, compose workflows out of
workflows. Any trigger, any model, on infrastructure you own. Audit everything, self-host it,
leave anytime.

This repo is the **engine** that runs those workflows: the open-source, single-node core with
cron scheduling, durable run semantics, SQLite run history, and a local run log, on hardware you
own with no account. Same engine and same run semantics as the hosted Boardwalk platform; this is
the part you run yourself.

> **Status: pre-release.** This repo is being built in the open ahead of its first published
> release. The contracts it implements are stable (see [`@boardwalk-labs/workflow`](https://www.npmjs.com/package/@boardwalk-labs/workflow));
> the engine itself is under active construction. See [`SPEC.md`](./SPEC.md) for the
> architecture and the definition of done.

## What it is

The engine runs a workflow two ways:

- **Server mode** — `docker run ghcr.io/boardwalk-labs/boardwalk`: a long-lived process that schedules cron
  workflows, accepts webhooks, keeps run history in SQLite, and serves a local run log.
- **Embedded mode** — `@boardwalk-labs/engine` as a library: one run, in-process supervision; this is
  what `boardwalk dev` uses.

Same engine, same semantics as the Boardwalk platform: one run = one process, `sleep` holds the
process, a crash restarts the run from the top, `workflows.call` re-attaches idempotently.
The conformance suite in this repo tests that parity.

## Quickstart

Run the server with Docker — run history and state live in the mounted data dir:

```sh
docker run -v ./data:/data -p 8080:8080 ghcr.io/boardwalk-labs/boardwalk
```

Then open `http://localhost:8080` for the run log, or hit the JSON API
(`/api/workflows`, `/api/runs`). Webhook triggers land on `/hooks/<workflow>/<trigger-id>`.

### Deploying a workflow

Build your workflow to a single file and drop it in the engine's **workflows directory** — it's
deployed on boot (re-synced every boot; idempotent by manifest name):

```sh
npx @boardwalk-labs/cli build index.ts --out ./data/workflows/my-routine.mjs
docker run -v ./data:/data -p 8080:8080 ghcr.io/boardwalk-labs/boardwalk
```

The default workflows directory is `<data-dir>/workflows` (`/data/workflows` in Docker); override
it with `BOARDWALK_WORKFLOWS_DIR`. Each `.mjs`/`.js` file is one workflow — single-file, with
`@boardwalk-labs/workflow` left external (exactly what `boardwalk build` emits). From there the
manifest's triggers take over: cron fires on schedule, `POST /api/workflows/<name>/runs` triggers
a manual run, and webhooks land on `/hooks/<workflow>/<trigger-id>`.

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

The same engine as a library — this is what `boardwalk dev` does:

```ts
import { Engine } from "@boardwalk-labs/engine";

const engine = new Engine({ dataDir: "./boardwalk-data" });
const run = await engine.runOnce({ program: bundledProgramSource });
console.log(run.status, run.output);
engine.close();
```

For OAuth-protected MCP servers an `agent()` call connects to, `engine.authorizeMcpServer(url, { onAuthorizationUrl })` performs the one-time interactive grant; after that, runs use (and silently refresh) the stored token headlessly — see [SPEC.md §2.3](./SPEC.md).

## License

Apache-2.0 — see [LICENSE](./LICENSE).

# boardwalk

The open-source single-node engine for Boardwalk workflows: cron scheduling, durable run
semantics, SQLite run history, and a local run log — on hardware you own, with no account.

> **Status: pre-release.** This repo is being built in the open ahead of its first published
> release. The contracts it implements are stable (see [`@boardwalk/workflow`](https://www.npmjs.com/package/@boardwalk/workflow));
> the engine itself is under active construction. See [`SPEC.md`](./SPEC.md) for the
> architecture and the definition of done.

## What it is

A workflow is a plain TypeScript program. This engine runs it:

- **Server mode** — `docker run boardwalk/boardwalk`: a long-lived process that schedules cron
  workflows, accepts webhooks, keeps run history in SQLite, and serves a local run log.
- **Embedded mode** — `@boardwalk/engine` as a library: one run, in-process supervision; this is
  what `boardwalk dev` uses.

Same engine, same semantics as the Boardwalk platform: one run = one process, `sleep` holds the
process, a crash restarts the run from the top, `workflows.call` re-attaches idempotently.
The conformance suite in this repo is the arbiter of that parity promise.

## Quickstart

Run the server with Docker — run history and state live in the mounted data dir:

```sh
docker run -v ./data:/data -p 8080:8080 boardwalk/boardwalk
```

Then open `http://localhost:8080` for the run log, or hit the JSON API
(`/api/workflows`, `/api/runs`). Webhook triggers land on `/hooks/<workflow>/<trigger-id>`.

### Configuration

All configuration is environment variables (a `boardwalk.toml` file is deferred — see
[`SPEC.md`](./SPEC.md) §2.4):

| Variable                  | Default                                    | What it does                                                                                 |
| ------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `BOARDWALK_DATA_DIR`      | `/data` in Docker, else `./boardwalk-data` | Where everything lives: SQLite DB, run dirs, artifacts                                       |
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
import { Engine } from "@boardwalk/engine";

const engine = new Engine({ dataDir: "./boardwalk-data" });
const run = await engine.runOnce({ program: bundledProgramSource });
console.log(run.status, run.output);
engine.close();
```

## License

Apache-2.0 — see [LICENSE](./LICENSE).

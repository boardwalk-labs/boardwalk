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

Coming with the first release:

```sh
docker run -v ./data:/data -p 8080:8080 boardwalk/boardwalk
```

## License

Apache-2.0 — see [LICENSE](./LICENSE).

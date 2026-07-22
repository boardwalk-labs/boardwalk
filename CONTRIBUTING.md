# Contributing to @boardwalk-labs/engine

Thanks for helping build the Boardwalk engine — the single-node runtime behind `boardwalk dev`
and the self-hosted server. It implements the run semantics every Boardwalk engine must honor,
so changes here are measured against the contract, not just the diff.

## Ground rules

- **Parity is the product.** A workflow file must behave identically under `dev`, the self-hosted
  server, and hosted Boardwalk (modulo the documented engine-dependent resolution). Any change to
  run semantics ships with a [conformance test](./conformance) — that suite is the parity
  authority, and the hosted platform runs it too.
- **The SDK owns the contract.** The manifest schema, run-event wire format, and primitive
  semantics live in [`@boardwalk-labs/workflow`](https://github.com/boardwalk-labs/sdk-typescript). The
  engine consumes them; it does not fork or redefine them.
- **The open-core line is hard.** The Auto-lane router (model selection, route-mix policy,
  calibration) lives in hosted Boardwalk and must never appear here — this engine _forwards_ to
  the managed gateway, it does not route. No private infrastructure details, account ids, or
  internal hostnames in code, comments, or fixtures.
- **The secrets invariant.** Secret values stay out of logs, run-event streams, error messages,
  and `agent()` context. If you touch the agent leaf, the child host, or error reporting, keep
  the redaction tests green and add to them.
- **Trust boundaries are parsed, not cast.** Everything crossing IPC, the wire, or disk is
  Zod-validated; `unknown` is narrowed with predicates/schemas, never `as`. No `any`.
- **Spec before code.** [`SPEC.md`](./SPEC.md) is the architecture contract; a behavior change
  PRs the spec change alongside it.

## Workflow

```sh
pnpm install
pnpm test          # vitest (unit + conformance)
pnpm lint          # eslint, zero warnings
pnpm typecheck     # src + conformance
pnpm format        # prettier
pnpm build
```

All of these must pass; CI runs exactly them, with coverage thresholds enforced. Every behavior
change ships with tests in the same PR.

## Reporting

Bugs and proposals via GitHub issues (templates provided). Security reports: see
[SECURITY.md](./SECURITY.md) — never a public issue.

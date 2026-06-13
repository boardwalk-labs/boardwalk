# Security

The engine executes workflow programs and resolves real credentials, so we treat security
reports with urgency.

## Reporting a vulnerability

**Please do not open a public issue for a security vulnerability.**

- Preferred: use GitHub's private vulnerability reporting ("Report a vulnerability" under the
  Security tab of this repository).
- Or email **security@boardwalk.sh**.

Include what you found, a reproduction, and the impact you believe it has. You'll get an
acknowledgement within 72 hours and a status update at least weekly until resolution.

## Scope notes

- Secret values must never appear in logs, run-event streams, error messages, or `agent()`
  context (the secrets invariant — exercised by the conformance suite). Anything that makes them
  do so is a vulnerability — report it.
- A workflow program is the operator's own trusted code, run in a per-run working directory.
  Reports should concern the engine's boundaries (secret handling, redaction, run isolation,
  the MCP token store, the SDK-resolution symlink), not what a program can do to its own
  workspace.
- Self-hosting runs on your own hardware with your own keys; deployment hardening of the box the
  engine runs on is the operator's responsibility.

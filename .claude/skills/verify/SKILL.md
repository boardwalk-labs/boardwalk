---
name: verify
description: Drive a real agent() loop against the LOCAL engine build to observe runtime behavior — no credentials needed. Use when verifying changes to src/agent/ (the leaf, compaction, tools) or the server.
---

# Verifying an engine change by running it

The surface is **`bin/boardwalk-server.js`** — the self-hosted single-node server. It runs your
LOCAL `dist/` build, so it actually exercises your diff. The installed `boardwalk` CLI does NOT: it
only drives remote engines, so it verifies nothing about local changes.

## The credential problem, and the way around it

The managed lane wants `BOARDWALK_API_KEY` and hits the real gateway. You usually don't have one,
and hunting for stored CLI tokens is both blocked and wrong.

Instead use a **local OpenAI-compatible provider** — an explicitly supported config path
(`{"ollama":{"base_url":"http://localhost:11434/v1"}}`). Point it at a scripted endpoint you write.
This is a test double at a genuine network boundary, not a unit test: the real server, real HTTP,
real tool execution, real loop. It also lets you control `prompt_tokens`, which matters because
that number feeds the leaf's context calibration.

## Recipe

```bash
npm run build          # server runs dist/, so ALWAYS rebuild after editing src/

# 1. scripted model on :8099 speaking SSE chat-completions (see the pattern below)
node fake_model.mjs &

# 2. the real engine server, pointed at it
BOARDWALK_PORT=8081 \
BOARDWALK_DATA_DIR=$V/data \
BOARDWALK_WORKFLOWS_DIR=$V/data/workflows \
BOARDWALK_PROVIDERS='{"fake":{"base_url":"http://localhost:8099/v1","protocol":"openai"}}' \
node bin/boardwalk-server.js &

# 3. drive it — routes are /api/..., NOT /v1/...
curl -s localhost:8081/api/workflows
curl -s -X POST localhost:8081/api/workflows/<slug>/runs -H 'content-type: application/json' -d '{}'
curl -s localhost:8081/api/runs/<runId>          # status, tokensIn/Out, error
```

The workflow file goes in `$BOARDWALK_WORKFLOWS_DIR/<slug>.mjs` and imports from
`@boardwalk-labs/workflow`. It is deployed automatically at server boot (watch the log).

## Gotchas that cost time

- **Routes are `/api/*`.** `/v1/*` returns `NOT_FOUND` (that's the hosted API's shape).
- **The workspace is per-run** (`$DATA_DIR/runs/<id>/workspace`) and the program's **cwd is the
  workspace**. Write `"big.txt"`, not `"/workspace/big.txt"` — `/workspace` is the hosted (fleet)
  convention and does not exist locally.
- **`read`'s `offset` is 1-based.** Passing `offset: 0` errors; it does not mean "start".
- **The stall guard is real.** A scripted model that emits the _identical_ tool call every turn trips
  "stuck repeating the same tool call(s)" after 5 in a 6-turn window. Vary the arguments (e.g. a
  moving `offset`) or your loop dies before it gets long.
- **Run output is a child process** — its stderr is NOT in the server log. To observe engine
  internals, append to a file from inside the loop (temporarily) rather than writing to stderr.

## Scripted model shape

Stream SSE: a `tool_calls` delta + `finish_reason: "tool_calls"` to continue the loop, or a `content`
delta + `finish_reason: "stop"` to end it, then a final chunk carrying
`usage: { prompt_tokens, completion_tokens }`. Decide from `messages.filter(m => m.role === "tool").length`
how far in you are. Scaling the reported `prompt_tokens` is the lever for testing context/calibration
behavior — report 3x and the leaf should compact ~3x earlier.

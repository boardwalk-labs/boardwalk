# Changelog

Notable changes to `@boardwalk-labs/engine` (and the `ghcr.io/boardwalk-labs/boardwalk` image).
Pre-1.0, changes ship as patch releases.

## 0.2.8

Programmatic tool calling and progressive tool disclosure — two levers for a leaf that carries many
tools or makes many tool calls.

### Added (progressive tool disclosure for large MCP tool sets)

A leaf given a large MCP tool set paid its full schema on every turn — a single GitHub/Slack server
can bring dozens of tools and tens of thousands of tokens of definitions, re-sent each turn (the loop
is append-only, so that cost compounds). The model also had to disambiguate among all of them at once,
which degrades tool selection.

MCP tools are now deferred behind a compact catalog (name + one-line description) and a built-in
`find_tools` search tool: the model searches by keyword to load the few schemas it needs, which then
join the advertised set for the rest of the run. Mirrors the `skill` progressive-disclosure pattern.

Deferral is **automatic and size-gated** (no `AgentOptions` field, no SDK change): it engages only
when the MCP set clears both a count and a combined-schema-size threshold (`TOOL_DEFER_MIN_COUNT` /
`TOOL_DEFER_MIN_CHARS`), so a normal leaf — built-ins plus a couple of MCP tools — is completely
unchanged, standing context and cache prefix identical. Only **MCP** tools are deferred; the core
coding built-ins and the call's own inline tools are always advertised. Execution is unchanged: the
loop advertises the active subset but still executes against the full set, so a tool the model calls
before searching still runs (find_tools just reveals the schema so the arguments are correct). See
`src/agent/tool_search.ts`.

### Added (`run_code` — programmatic tool calling)

A fat leaf that makes dozens of tool calls pays for every intermediate result on every append-only
turn, and drowns in its own transcript. The new default-on `run_code` tool lets the model write a
JavaScript snippet that orchestrates its OTHER tools in code — the leaf's tools are bound as async
functions on a `tools` object (`await tools.read({ path })`, `await tools.<server>__<tool>({...})`,
plus a `call(name, input)` escape hatch) — and only what the snippet `console.log`s or `return`s
enters model context. The individual tool results it loops over, filters, and aggregates never do.
This is the one lever that improves accuracy AND cost together; it works on the managed `auto` lane
and every BYO provider (it is a native tool, not Anthropic's server-side PTC beta).

It composes with progressive disclosure: the snippet can call deferred MCP tools too (deferral hides
the schema from advertising, never from execution). Default-on under `builtins: "all"` (like
`bash`/`subagent`), off for `"none"`/`"read-only"`.

The snippet runs in-process and is exactly as privileged as the already-default-on `bash` (the run's
isolation boundary is the per-run microVM, not the JS realm); what it returns is redacted like any
tool result, so secrets can't reach the model. A wall-clock timeout and an output cap bound it; a
purely synchronous infinite loop is bounded by the run duration budget (a child-process bridge is the
hardening follow-up). See `src/agent/tools/run_code.ts`.

Two refinements ship alongside it. A **sub-agent** can now be granted `run_code` (it re-assembles its
own over exactly the tools it was granted), so delegated work gets the same lever. And each inner tool
call the snippet makes is **traced to the run's live view** (`» read({...})`) so a viewer can watch
what the code is doing — the trace goes only to the activity stream, never into the model's result, so
it costs no context.

## 0.2.7

### Fixed (a validation error states the fix once, not twice)

0.2.5–0.2.6 inlined the fix into the error **message** because a hosted run dropped `hint` on the
floor — the runner's failure contract was `{ code, message }`, so the actionable half never reached
the author. Runner 0.2.8 now preserves `hint` end to end, and both the run page and
`boardwalk runs <id>` render it, which turned that workaround into visible noise: the same sentence
twice, once as the message's tail and once as the hint.

The split is restored, and now it holds — **message says what is WRONG, hint says what to DO**, and
neither restates the other:

```
Error  agent() got a string ("bash") in `tools`, which takes inline tool definitions, not names.
Hint   Built-in tools are ON by default — "bash" needs no declaration at all. To restrict this leaf
       to a subset of built-ins, write `builtins: ["bash"]`; `tools` is only for tools you define
       inline.
```

`builtins: "bash"` likewise moves its "Did you mean `builtins: ["bash"]`?" back to the hint. Requires
runner ≥ 0.2.8 to see the hint on a hosted run; on an older runner the message still names the
mistake, it just won't say what to type.

## 0.2.6

Finishes the 0.2.5 pass: the remaining untrusted `AgentOptions` field, and getting the fix in front
of the person who needs it.

### Fixed (`attachments` — a wrong shape billed five model calls)

`agent({ attachments })` was the one field 0.2.5 missed (it is consumed in the leaf, not in tool-set
assembly), and it failed worse than the rest. `attachments: {}` or `"x"` died with
`TypeError: attachments.map is not a function`; `[null]` crashed reading `mimeType`. Worst,
`attachments: [{}]` sailed past the engine to the **provider**, failed there, and the leaf **retried
the doomed request five times** before surfacing an internal
`Cannot read properties of undefined (reading 'startsWith')` — a wrong shape billed five model calls
to produce an error that named nothing.

Attachments are now shape-checked beside the tool set, so every sync check on untrusted options
completes before an MCP server spawns or a single model call is billed: a bad shape costs zero.
`data`/`url` are enforced as exactly-one (the SDK documented it; nothing checked it).

### Fixed (the actionable half of a validation error now reaches the author)

A hosted run reports a failure as `{ code, message }` — the runner's contract carries no `hint` — so
on the one path where these mistakes actually bite, `hint` is invisible. Every engine hint has always
been dropped there, not just the new ones. Anything the author must _do_ therefore moved into the
message:

```
agent() got a string ("bash") in `tools`, which takes inline tool definitions, not names.
Built-in tools are ON by default, so "bash" needs no declaration at all — drop it, or write
`builtins: ["bash"]` to restrict this leaf to a subset.

agent() `builtins` must be "all", "read-only", "none", or an array of built-in names — got a
string ("bash"). Did you mean `builtins: ["bash"]`?
```

`hint` remains the fuller elaboration for the paths that surface it.

## 0.2.5

### Fixed (a wrong-shaped `agent()` option names the mistake instead of crashing)

`agent("...", { tools: ["bash"] })` deployed cleanly and then died at run time with a bare
`TypeError: Cannot read properties of undefined (reading 'length')`, naming nothing. The line that
threw _was_ the validation guard: it read `def.name` without first checking `def` was a tool object,
so a wrong-shaped input crashed the guard rather than being caught by it.

Nothing catches this earlier, by contract: author programs are never type-checked before they run
(the deploy gate is syntax-only; bundlers strip types without checking them). So **every
`AgentOptions` field is untrusted runtime input** — the TS types are author-side ergonomics, not a
runtime guarantee. Every field is now shape-validated at the boundary, and the message names the
field and the fix rather than restating the rule.

- **`tools` given a built-in name is called out by name.** `tools` is only for tools you define
  inline; built-ins are default-on and scoped with `builtins`. Because naming built-ins in `tools`
  is the mistake authors actually make, that exact case now says what to type instead: built-ins
  are on by default, so `"bash"` needs no declaration at all, and a leaf is narrowed to a subset
  with `builtins: ["bash"]`. `builtins: "bash"` gets the mirror-image hint (it used to iterate the
  string's _characters_ and report `Built-in tool "b" is not available`).
- **Two silent failures now fail loudly.** `skills: {}` dropped every pinned skill and ran on
  without complaint (`({}).length > 0` is false) — the exact silent degrade the capability-presence
  rule forbids. A tool with a non-string `name` was advertised to the provider as-is.
- **`builtins` / `skills` / `memory` / `mcp` / `tools` all reject wrong shapes** with a `VALIDATION`
  error instead of a `TypeError` from deep inside assembly. A malformed `mcp` ref no longer crashes
  while formatting its own error message.

Validation never reshapes what it validates: a tool's `execute` stays the same closure and its
`inputSchema` reaches the provider byte-identical. Echoed values are clipped, so a validation error
can't become a channel for dumping a huge value into run events.

## 0.2.2

### Fixed (agent context is budgeted in tokens; a long loop no longer outgrows its model)

The `agent()` compaction budget was 600,000 **characters**, justified as "roughly 150k tokens" on a
flat ~4-chars-per-token assumption. Measured against `o200k_base`, that assumption is inverted for
real agent traffic: prose is 4.02 chars/token and TypeScript source 4.13, but **JSON tool results
are 2.87** — and a tool loop's conversation is mostly JSON tool I/O. The trigger therefore fired at
**~209k tokens**, past a 200k-window model and far past any 128k one, so a long loop could exceed
its model's context before compaction ever ran. It is a quality problem before a cost one: accuracy
degrades steeply with context length well before the window fills.

- **The budget is now `DEFAULT_COMPACTION_BUDGET_TOKENS = 100_000`**, and the estimator buckets by
  how content actually tokenizes (prose for user/assistant text, the denser JSON ratio for tool
  results and serialized tool-call inputs). Long loops now compact earlier and stay well inside
  every supported model's window.
- **The estimate self-calibrates against the provider.** Each turn reports what the request really
  cost (`usage.input_tokens` / `prompt_tokens`), so the leaf compares its prediction to reality and
  scales future estimates. No tokenizer dependency and no per-model table — which matters because
  the leaf cannot know its model (resolution lives behind the `streamModel` seam). A model whose
  tokenizer is denser than these constants protects itself automatically.
- **Tool output caps drop at source**, where capping costs no prompt cache (unlike retroactive
  eviction, which rewrites history): `read` 100k → **40k chars**, `bash` 64k → **32k bytes per
  stream**. Page a large file with `offset`/`limit`, or locate with `grep`.
- **`bash` now keeps the head AND the tail of output**, eliding the middle. It previously kept only
  the head, which discarded the part that matters — a build or test run puts its verdict at the end.

The 100k target is a considered default, not a measured optimum.

## 0.2.0

### Changed (breaking — the journal is deleted; waits hold in-process)

The North Star deletion (Phase D). The journal/replay/fingerprint supervisor machinery is gone;
on this engine — which has no snapshot substrate — every wait now HOLDS the run's process, so
locals survive trivially and nothing ever replays. Requires `@boardwalk-labs/workflow` ≥ 0.2.0
(which drops durable `now()`/`random()`/`uuid()`, `step`, and the `/lint` module).

- **`sleep` holds** for its whole duration (any length; chunked past setTimeout's cap). No
  `sleeping` status, no timed-wake sweep. A held wait burns `max_duration_seconds` — on a
  non-snapshot engine, waiting occupies the process ("pay idle"); prefer a cron topology for
  long waits.
- **`humanInput()` holds**: the gate is a blocking `human_input` host call; the run sits in
  `awaiting_input` with its process alive, and the validated answer is delivered to the live
  call. The `human_input_requests` row is the durable answer slot — a crash-restarted program
  re-reaching the same key gets the stored answer instead of re-asking.
- **The in-leaf `human_input` tool holds the leaf mid-loop**: the transcript stays in memory;
  the answer re-enters the leaf via `LeafResume` in the same process. Answers accumulate across
  parks, so a turn with several gates converges.
- **`workflows.call` holds until the child run is terminal.** The child's run row is the durable
  memo — a restarted parent re-attaches via the idempotency key; the journal memoization is
  redundant. `waiting_for_child` remains as the observable status while the call is in flight.
- **Crash/restart semantics unchanged and now uniform**: restart-from-top, side effects re-run,
  no replay suppression (console output streams once because the process never re-runs).
- **Deleted**: the `run_journal` table (forward migration v4, with `runs.wake_at` and its
  index), `journal_get`/`journal_put` IPC, the seam sequencer + fingerprint + determinism
  error, the replay frontier + console suppression, the scheduler's wake pass, and
  `SuspendSignal`/the `suspend` child message. `isSuspended` is renamed `isHeld`.
- Held statuses (`awaiting_input`, `waiting_for_child`) now count as ACTIVE for the `serial`
  concurrency gate — a held run occupies its process, so a serial workflow won't dispatch a
  second run beside it.

## 0.1.35

`agent({ cwd })` plus three self-correction improvements drawn from auditing a production run
whose agents burned turns on path guessing and ambiguous patches:

### Added

- **`agent({ cwd })` — the workspace-relative directory a leaf works from** (SDK ≥ 0.1.29).
  Re-roots the leaf's working view of the workspace: the built-in file tools resolve and confine
  their paths under the `cwd`, `bash` starts there, the `<env>` workspace orientation describes it,
  and the workspace-tier `AGENTS.md` is discovered from it — so a run driving several agents in
  different checkouts gives each one clean repo-relative paths. The `cwd` must be an existing
  directory inside the workspace (an absent path or an escape fails loudly before any model call —
  never a silent fallback to the root). `memory` deliberately stays workspace-ROOT-relative (a
  memory dir is a stable cross-run identity, not a working location), and a `subagent` inherits its
  parent's `cwd`. Scoping and ergonomics, not a security boundary — the run's sandbox remains the
  isolation boundary.
- **"Did you mean" path hints on not-found errors.** When `read`/`edit`/`ls`/`grep`/`apply_patch`
  reject a path that doesn't exist, the error now suggests up to three near-miss workspace paths —
  path-suffix matches first (the repo-cloned-into-a-subdirectory case, where a model cites
  repo-relative paths), then same-basename matches. A bounded scan, a hint only: the strict-match
  contract is unchanged and nothing is ever edited at a guessed path.
- **Workspace orientation in the `<env>` block.** A leaf with filesystem tools now sees a capped
  listing of the workspace root's top-level entries (directories marked `/`) plus "file paths in
  tool calls are workspace-relative" — so its first paths are grounded instead of guessed. Same
  cache-safe placement as the date line (built once at leaf start; `ls` is the live source);
  pure-inference and inline-tools-only leaves are unchanged.
- **`@@` anchors in `apply_patch`.** Trailing text on a hunk's `@@` header (Codex-style
  `@@ function name()`) now scopes an ambiguous hunk: the anchor names a line at or above the
  target, and each anchor occurrence claims the nearest match at/after itself — exactly one
  distinct claim applies; anything else still fails loudly (the anchor narrows, it never guesses).
  The ambiguity error teaches the syntax.

## 0.1.32

### Added

- **Multimodal image content through the managed lane.** The neutral conversation model gains a
  `ContentPart` union (`text | image`), and user + tool-result content widen to
  `string | ContentPart[]` — a bare string is exactly one text part, so text-only callers are
  unchanged. Both adapters render images: Anthropic emits native `image` blocks in user messages AND
  inside `tool_result`; the OpenAI-compatible adapter emits `image_url` data URLs in user messages
  and, because a `tool` message is text-only there, re-emits a tool-result image as a trailing `user`
  message (the tool block stays contiguous after the assistant's tool calls). `RichToolResult` gains
  an optional `content` channel so a tool (e.g. a `screenshot`) can return an image, not just
  `llmText`. Secret redaction scrubs text parts and passes image bytes through; context compaction
  accounts for image parts. Assistant messages stay text-only (a model never emits an image).

## 0.1.31

### Added

- **`McpServerRef.excludeTools`** is honored — named tools are pruned from what an `agent({ mcp })`
  leaf sees, so an MCP server's arbitrary-code tools can be hidden from the model.

## 0.1.30

### Added

- **Base tool-use conventions** are now prepended to every tool-bearing `agent()` leaf — a thin,
  generic preamble (batch independent tool calls in parallel, reuse context instead of re-reading,
  make targeted edits and fully implement them, verify with evidence, track multi-step work, stop
  when done). It's the most-general block, ordered ahead of `AGENTS.md` so an author's project rules
  override it; it's tool-conditional (a read-only or pure-inference leaf only sees the lines that
  apply); and it addresses the model behaviors — one-edit-per-turn, redundant re-reads — that no
  prompt was previously counteracting. Synthesized from the convergent practice across OSS harnesses.

### Changed

- **The `agent()` loop is now unbounded by default.** The fixed 25-tool-iteration cap is gone: a
  leaf runs until the model stops calling tools, bounded by the run budget (usage is reported after
  every model call), the repetition guard, and cancellation. A legitimately long task (a many-file
  edit, a multi-repo pass) no longer hard-fails with `exceeded 25 tool iterations` — the common
  cause of failed runs that had already done real work.
- **Optional `AgentOptions.maxIterations` (soft cap).** A leaf whose scope you know can set a
  ceiling; it does NOT hard-fail. On the turn past the ceiling the model is asked once more with its
  tools withheld, so it must produce a final answer from the work done. Omit for no cap; a
  non-integer or `< 1` value is ignored. (Requires the SDK build that surfaces the field for typed
  authoring; the engine reads it defensively, so it is honored regardless of SDK version.)
- **Wrap-up hints.** As tool-calling turns pile up, the model gets a periodic reminder to conclude
  if it already can (a concrete countdown as a set `maxIterations` nears). Append-only, so the
  prompt cache stays warm.
- **`grep` and `ls` accept multiple paths.** `path` may now be a single string OR an array of
  strings, so a model searching/listing several paths in one call succeeds instead of failing when
  it passes more than one. Each path is still sandbox-checked individually.
- **`apply_patch` tolerates whitespace/indentation drift.** A hunk's context/removed lines are now
  matched exact → ignoring trailing whitespace → ignoring a **uniform** leading-indentation
  difference (with the replacement re-indented to match, so it never de-indents the result). Each
  tier still requires a UNIQUE match — a tolerant tier never silently edits the wrong place, and
  non-uniform drift still fails loudly. This recovers the most common cause of a correct patch being
  rejected. (Whitespace-structural only; deliberately NOT similarity/edit-distance fuzzing, which
  Aider shipped then disabled for silently mis-applying.)
- **Richer edit-failure messages, so fewer turns are lost to recoverable mistakes.** `edit`'s
  "text not found" now flags an **already-applied** edit (the replacement is already present) and
  points at the **closest lines** in the file (whitespace-drift "did you mean?"); its ambiguous-match
  error **names the distinct line numbers**. `apply_patch`'s ambiguous-hunk error names the matching
  line numbers; `grep`'s missing-path error points at the array form. (`edit` stays strict
  exact-unique — the hints steer the retry, they never change what matches.)
- **Consecutive-error guard.** A run of turns whose every tool call fails now nudges the model to
  change approach, then ends the run — instead of spinning on failing calls until the budget.
  Complements the repetition guard (which only catches identical/alternating calls); any successful
  tool result resets it.
- **Compaction digest preserves more state.** The summary that replaces old turns on overflow now
  explicitly retains the plan/todo status, per-file changes, verified-vs-unverified state, and the
  in-progress step — so a compacted run is less likely to redo finished work.

## 0.1.28

### Changed

- Agent-loop token-efficiency + performance pass. `read` now caps an unbounded read
  (2000 lines / 100K chars; page with `offset`/`limit`), applied at read time so it
  never rewrites history. Context compaction dedupes stale duplicate file reads (no
  model call) before summarizing, and the summary call reuses the loop's prefix so it
  reads the prompt cache instead of reprocessing the transcript (with a minimum-reclaim
  gate, a shrink guard, and a structured digest). `agent({ schema })` recovers JSON
  wrapped in code fences or prose before failing. A repetition guard ends a run that
  loops on identical tool calls instead of burning every iteration.

## 0.1.27

### Changed

- Bump `@boardwalk-labs/workflow` to ^0.1.15 (the `budget.deadline_seconds` type fix). Additive;
  no engine behavior change.

## 0.1.26

### Changed

- Bump `@boardwalk-labs/workflow` to ^0.1.14 (the `workflow_run` trigger). Additive; the engine
  accepts manifests declaring it.

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

- Renamed the OpenAI-compatible reasoning encoder to `reasoningToUnified`, and the
  `ChatArgs.reasoningStyle` discriminant value to `"unified"` (the managed lane's unified
  `reasoning` object). Breaking for direct callers of either symbol.

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

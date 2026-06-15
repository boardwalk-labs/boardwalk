// SPDX-License-Identifier: Apache-2.0

// GET / — the local run-log page (SPEC §2.4): one self-contained HTML document, no build
// step, no external assets. It is a log viewer, not a console: list workflows, list recent
// runs, click a run to tail it over the SSE endpoint. All rendering uses textContent — no
// markup is ever built from API data, so nothing a workflow prints can inject into the page.

import type { RouteContext } from "./router.js";

export function handleUiPage(ctx: RouteContext): void {
  ctx.res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  ctx.res.end(RUN_LOG_PAGE);
}

const RUN_LOG_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Boardwalk run log</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; margin: 0; display: grid; grid-template-columns: 17rem 1fr; height: 100vh; }
  aside { border-right: 1px solid #8884; padding: 1rem; overflow-y: auto; }
  main { padding: 1rem; overflow-y: auto; display: flex; flex-direction: column; gap: 1rem; }
  h1 { font-size: 1rem; margin: 0 0 0.75rem; }
  h2 { font-size: 0.8rem; margin: 0 0 0.5rem; text-transform: uppercase; letter-spacing: 0.05em; opacity: 0.7; }
  button.row { display: block; width: 100%; text-align: left; background: none; border: none; padding: 0.3rem 0.4rem; cursor: pointer; border-radius: 0.25rem; font: inherit; }
  button.row:hover { background: #8882; }
  #log { font-family: ui-monospace, monospace; font-size: 0.8rem; white-space: pre-wrap; flex: 1; border: 1px solid #8884; border-radius: 0.25rem; padding: 0.5rem; overflow-y: auto; min-height: 10rem; }
  .muted { opacity: 0.6; }
</style>
</head>
<body>
<aside>
  <h1>boardwalk</h1>
  <h2>Workflows</h2>
  <div id="workflows" class="muted">loading…</div>
</aside>
<main>
  <section>
    <h2>Recent runs</h2>
    <div id="runs" class="muted">loading…</div>
  </section>
  <section style="display: flex; flex-direction: column; flex: 1;">
    <h2 id="tail-title">Run log</h2>
    <div id="log" class="muted">select a run to tail it</div>
  </section>
</main>
<script>
"use strict";
let source = null;
let selectedWorkflow = null;
const el = (id) => document.getElementById(id);

async function getJson(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(path + " -> " + res.status);
  return res.json();
}

function rowButton(label, onClick) {
  const button = document.createElement("button");
  button.className = "row";
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

async function loadWorkflows() {
  const { workflows } = await getJson("/api/workflows");
  const box = el("workflows");
  box.replaceChildren();
  box.className = "";
  if (workflows.length === 0) {
    box.className = "muted";
    box.textContent = "none deployed";
    return;
  }
  box.append(rowButton("all workflows", () => { selectedWorkflow = null; loadRuns(); }));
  for (const workflow of workflows) {
    box.append(rowButton(workflow.slug, () => { selectedWorkflow = workflow.slug; loadRuns(); }));
  }
}

async function loadRuns() {
  const filter = selectedWorkflow === null ? "" : "&workflow=" + encodeURIComponent(selectedWorkflow);
  const { runs } = await getJson("/api/runs?limit=50" + filter);
  const box = el("runs");
  box.replaceChildren();
  box.className = runs.length === 0 ? "muted" : "";
  if (runs.length === 0) box.textContent = "no runs yet";
  for (const run of runs) {
    const when = new Date(run.createdAt).toLocaleString();
    box.append(rowButton(run.status + " · " + when + " · " + run.id, () => tail(run.id)));
  }
}

function describeEvent(event) {
  if (event.kind === "run_status") {
    return "status: " + event.status + (event.error ? " (" + event.error.code + ": " + event.error.message + ")" : "");
  }
  if (event.kind === "phase") return "phase: " + event.name;
  if (event.kind === "output") return "output: " + JSON.stringify(event.value);
  if (event.kind === "program_output") return "[" + event.stream + "] " + event.text.replace(/\\n$/, "");
  return event.kind;
}

function tail(runId) {
  if (source !== null) source.close();
  el("tail-title").textContent = "Run " + runId;
  const log = el("log");
  log.replaceChildren();
  log.className = "";
  source = new EventSource("/api/runs/" + encodeURIComponent(runId) + "/stream?verbose=true");
  source.onmessage = (message) => log.append(describeEvent(JSON.parse(message.data)) + "\\n");
  source.onerror = () => log.append("(stream interrupted; retrying)\\n");
}

loadWorkflows();
loadRuns();
setInterval(loadRuns, 5000);
</script>
</body>
</html>
`;

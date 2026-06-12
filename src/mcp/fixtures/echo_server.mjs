// Test fixture: a minimal MCP server speaking newline-delimited JSON-RPC over stdio.
// Plain .mjs so it runs straight off `process.execPath` with no compile step (tsc ignores
// .mjs under src/, so `pnpm build` neither compiles nor ships it); tests reference it by
// absolute path. Implements just initialize / tools/list / tools/call for one "echo" tool.

import { createInterface } from "node:readline";

const PREFIX = process.env.ECHO_PREFIX ?? "echo";
const TOOLS = [
  {
    name: "echo",
    description: "Echoes text back",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: msg.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "echo-fixture", version: "1.0.0" },
      },
    });
  } else if (msg.method === "notifications/initialized") {
    // notification — no reply
  } else if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS } });
  } else if (msg.method === "tools/call") {
    const { name, arguments: args } = msg.params;
    if (name === "echo") {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          content: [{ type: "text", text: `${PREFIX}: ${String(args.text)}` }],
          isError: false,
        },
      });
    } else {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          content: [{ type: "text", text: `unknown tool ${String(name)}` }],
          isError: true,
        },
      });
    }
  } else if (msg.id !== undefined && msg.id !== null) {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
  }
});

// Exercises the stderr-passthrough path: this line must land in the run log, never on stdout.
process.stderr.write("echo-server fixture started\n");

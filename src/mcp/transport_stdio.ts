// MCP stdio transport: spawn the server command and speak newline-delimited JSON over its
// stdin/stdout (the MCP stdio framing). Runs in the RUN PROCESS — the program is the trusted
// layer, so its inline `command`/`env` are honored as-is; the server's stderr is inherited so
// its diagnostics land in the run log like any other program output.

import { spawn, type ChildProcess } from "node:child_process";
import { EngineError } from "../errors.js";
import type { JsonRpcOutbound, McpTransport } from "./jsonrpc.js";

export interface StdioTransportOptions {
  /** The MCP server's name from the agent() call — names the process in every error. */
  serverName: string;
  command: string;
  args?: readonly string[] | undefined;
  /** Layered over process.env (the program supplies credentials here directly). */
  env?: Record<string, string> | undefined;
}

export class StdioTransport implements McpTransport {
  private readonly serverName: string;
  private readonly child: ChildProcess;
  private messageCb: ((message: unknown) => void) | null = null;
  private closeCb: ((err: Error) => void) | null = null;
  /** Set once the transport failed or was closed — later sends must fail fast, not hang. */
  private dead: Error | null = null;
  private closedDeliberately = false;
  private stdoutBuffer = "";

  constructor(opts: StdioTransportOptions) {
    this.serverName = opts.serverName;
    this.child = spawn(opts.command, [...(opts.args ?? [])], {
      env: { ...process.env, ...opts.env },
      // stderr is inherited: it flows into THIS process's stderr, which the supervisor already
      // captures as run-log program output — MCP server diagnostics need no extra plumbing.
      stdio: ["pipe", "pipe", "inherit"],
    });

    this.child.stdout?.on("data", (chunk: Buffer) => {
      this.stdoutBuffer += chunk.toString("utf8");
      let newline = this.stdoutBuffer.indexOf("\n");
      while (newline >= 0) {
        const line = this.stdoutBuffer.slice(0, newline).trim();
        this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
        if (line.length > 0) this.deliverLine(line);
        newline = this.stdoutBuffer.indexOf("\n");
      }
    });

    this.child.on("error", (err) => {
      // Spawn failure (ENOENT et al.) — the most common misconfiguration; name the command.
      this.die(
        new EngineError(
          "PROVIDER_ERROR",
          `MCP server "${this.serverName}": failed to spawn "${opts.command}": ${err.message}.`,
          "Check that the command exists on this machine's PATH (stdio MCP servers run locally).",
        ),
      );
    });

    this.child.on("exit", (code, signal) => {
      if (this.closedDeliberately) return;
      this.die(
        new EngineError(
          "PROVIDER_ERROR",
          `MCP server "${this.serverName}" exited unexpectedly ` +
            `(${signal !== null ? `signal ${signal}` : `code ${String(code)}`}).`,
          "Its stderr is in the run log — check there for the server's own error output.",
        ),
      );
    });
  }

  send(message: JsonRpcOutbound): Promise<void> {
    if (this.dead !== null) return Promise.reject(this.dead);
    const stdin = this.child.stdin;
    if (stdin === null || !stdin.writable) {
      return Promise.reject(
        new EngineError("PROVIDER_ERROR", `MCP server "${this.serverName}": stdin is closed.`),
      );
    }
    return new Promise((resolve, reject) => {
      stdin.write(`${JSON.stringify(message)}\n`, (err) => {
        if (err !== null && err !== undefined) reject(err);
        else resolve();
      });
    });
  }

  onMessage(cb: (message: unknown) => void): void {
    this.messageCb = cb;
  }

  onClose(cb: (err: Error) => void): void {
    this.closeCb = cb;
    // The process may have already died (spawn errors race subscription) — deliver late.
    if (this.dead !== null && !this.closedDeliberately) cb(this.dead);
  }

  /** Kill the server process. Deliberate teardown — no error is surfaced for the exit. */
  close(): Promise<void> {
    this.closedDeliberately = true;
    this.dead ??= new EngineError(
      "PROVIDER_ERROR",
      `MCP server "${this.serverName}": connection closed.`,
    );
    this.child.kill("SIGTERM");
    return Promise.resolve();
  }

  private deliverLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return; // a non-JSON stdout line is server noise, not a protocol failure
    }
    this.messageCb?.(message);
  }

  private die(err: Error): void {
    if (this.dead !== null) return;
    this.dead = err;
    this.closeCb?.(err);
  }
}

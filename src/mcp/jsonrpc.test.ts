// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { EngineError } from "../errors.js";
import { JsonRpcClient, type JsonRpcOutbound, type McpTransport } from "./jsonrpc.js";

/** An in-memory transport the test scripts: records sends, lets the test inject inbound frames. */
function fakeTransport(): {
  transport: McpTransport;
  sent: JsonRpcOutbound[];
  inject: (message: unknown) => void;
  die: (err: Error) => void;
} {
  const sent: JsonRpcOutbound[] = [];
  let messageCb: ((message: unknown) => void) | null = null;
  let closeCb: ((err: Error) => void) | null = null;
  return {
    transport: {
      send: (message) => {
        sent.push(message);
        return Promise.resolve();
      },
      onMessage: (cb) => {
        messageCb = cb;
      },
      onClose: (cb) => {
        closeCb = cb;
      },
      close: () => Promise.resolve(),
    },
    sent,
    inject: (message) => messageCb?.(message),
    die: (err) => closeCb?.(err),
  };
}

describe("JsonRpcClient", () => {
  it("correlates out-of-order responses by id", async () => {
    const { transport, sent, inject } = fakeTransport();
    const client = new JsonRpcClient(transport, { label: "srv" });

    const first = client.request("alpha");
    const second = client.request("beta");
    expect(sent).toHaveLength(2);
    const firstId = sent[0] !== undefined && "id" in sent[0] ? sent[0].id : -1;
    const secondId = sent[1] !== undefined && "id" in sent[1] ? sent[1].id : -1;

    // Answer the SECOND request first — each promise must get its own result.
    inject({ jsonrpc: "2.0", id: secondId, result: "beta-result" });
    inject({ jsonrpc: "2.0", id: firstId, result: "alpha-result" });
    await expect(second).resolves.toBe("beta-result");
    await expect(first).resolves.toBe("alpha-result");
  });

  it("rejects on a JSON-RPC error response, naming the method and server", async () => {
    const { transport, sent, inject } = fakeTransport();
    const client = new JsonRpcClient(transport, { label: "github" });
    const pending = client.request("tools/call");
    const id = sent[0] !== undefined && "id" in sent[0] ? sent[0].id : -1;
    inject({ jsonrpc: "2.0", id, error: { code: -32602, message: "bad params" } });
    await expect(pending).rejects.toThrow(/"github".*"tools\/call" failed: bad params.*-32602/);
  });

  it("times out a request the server never answers, with a clear error", async () => {
    const { transport } = fakeTransport();
    const client = new JsonRpcClient(transport, { label: "slow", timeoutMs: 30 });
    await expect(client.request("tools/list")).rejects.toThrow(/timed out after 0\.03s/);
  });

  it("drops malformed and unknown-id frames without disturbing real pending requests", async () => {
    const { transport, sent, inject } = fakeTransport();
    const client = new JsonRpcClient(transport, { label: "srv" });
    const pending = client.request("alpha");
    inject("not even an object");
    inject({ jsonrpc: "1.0", id: 1, result: "wrong version" });
    inject({ jsonrpc: "2.0", id: 999, result: "unknown id" });
    inject({ jsonrpc: "2.0", id: "string-id", result: "not our id space" });
    const id = sent[0] !== undefined && "id" in sent[0] ? sent[0].id : -1;
    inject({ jsonrpc: "2.0", id, result: "real" });
    await expect(pending).resolves.toBe("real");
  });

  it("answers a server-initiated request with method-not-found and drops notifications", () => {
    const { transport, sent, inject } = fakeTransport();
    new JsonRpcClient(transport, { label: "srv" });
    inject({ jsonrpc: "2.0", id: "srv-1", method: "sampling/createMessage", params: {} });
    inject({ jsonrpc: "2.0", method: "notifications/progress", params: {} });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ id: "srv-1", error: { code: -32601 } });
  });

  it("notify() sends without an id and resolves immediately", async () => {
    const { transport, sent } = fakeTransport();
    const client = new JsonRpcClient(transport, { label: "srv" });
    await client.notify("notifications/initialized");
    expect(sent).toEqual([{ jsonrpc: "2.0", method: "notifications/initialized" }]);
  });

  it("rejects everything pending when the transport dies, and refuses new requests after close", async () => {
    const { transport, die } = fakeTransport();
    const client = new JsonRpcClient(transport, { label: "srv" });
    const pending = client.request("alpha");
    die(new EngineError("PROVIDER_ERROR", "process exited"));
    await expect(pending).rejects.toThrow(/process exited/);

    await client.close();
    await expect(client.request("beta")).rejects.toThrow(/connection is closed/);
  });

  it("rejects the request when the transport's send itself fails", async () => {
    const sentError = new EngineError("PROVIDER_ERROR", "stdin is closed");
    const transport: McpTransport = {
      send: () => Promise.reject(sentError),
      onMessage: () => undefined,
      onClose: () => undefined,
      close: () => Promise.resolve(),
    };
    const client = new JsonRpcClient(transport, { label: "srv" });
    await expect(client.request("alpha")).rejects.toThrow(/stdin is closed/);
  });
});

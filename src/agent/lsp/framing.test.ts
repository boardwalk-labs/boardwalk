// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { encodeFrame, FrameDecoder } from "./framing.js";

describe("encodeFrame", () => {
  it("prefixes a Content-Length header counting the JSON BYTE length", () => {
    const frame = encodeFrame({ jsonrpc: "2.0", id: 1, method: "ping" });
    const text = frame.toString("utf8");
    const [header, body] = text.split("\r\n\r\n");
    expect(header).toBe(`Content-Length: ${String(Buffer.byteLength(body ?? "", "utf8"))}`);
    expect(JSON.parse(body ?? "")).toEqual({ jsonrpc: "2.0", id: 1, method: "ping" });
  });

  it("counts BYTES, not characters, for a multibyte payload", () => {
    const frame = encodeFrame({ text: "héllo — 文字" });
    const headerEnd = frame.indexOf("\r\n\r\n");
    const bodyBytes = frame.length - (headerEnd + 4);
    const declared = Number(/Content-Length: (\d+)/.exec(frame.toString("ascii"))?.[1]);
    expect(declared).toBe(bodyBytes);
  });
});

describe("FrameDecoder", () => {
  it("decodes a single complete frame", () => {
    const decoder = new FrameDecoder();
    const out = decoder.push(encodeFrame({ id: 7, result: "ok" }));
    expect(out).toEqual([{ id: 7, result: "ok" }]);
  });

  it("reassembles a frame split across many chunks (header + body both split)", () => {
    const decoder = new FrameDecoder();
    const full = encodeFrame({ id: 1, result: { value: "split-me" } });
    // Feed one byte at a time — the worst case for an incremental parser.
    const results = [];
    for (const byte of full) {
      results.push(...decoder.push(Buffer.from([byte])));
    }
    expect(results).toEqual([{ id: 1, result: { value: "split-me" } }]);
  });

  it("decodes multiple frames delivered in one chunk", () => {
    const decoder = new FrameDecoder();
    const combined = Buffer.concat([
      encodeFrame({ id: 1, result: "a" }),
      encodeFrame({ id: 2, result: "b" }),
      encodeFrame({ method: "notify" }),
    ]);
    expect(decoder.push(combined)).toEqual([
      { id: 1, result: "a" },
      { id: 2, result: "b" },
      { method: "notify" },
    ]);
  });

  it("handles a multibyte body without under-reading", () => {
    const decoder = new FrameDecoder();
    const out = decoder.push(encodeFrame({ message: "café — 漢字 ✅" }));
    expect(out).toEqual([{ message: "café — 漢字 ✅" }]);
  });

  it("drops a non-JSON body rather than throwing, and recovers on the next frame", () => {
    const decoder = new FrameDecoder();
    const garbageBody = Buffer.from("not json", "utf8");
    const garbage = Buffer.concat([
      Buffer.from(`Content-Length: ${String(garbageBody.length)}\r\n\r\n`, "ascii"),
      garbageBody,
    ]);
    expect(decoder.push(garbage)).toEqual([]);
    expect(decoder.push(encodeFrame({ id: 9, result: "recovered" }))).toEqual([
      { id: 9, result: "recovered" },
    ]);
  });

  it("skips a header with no parseable Content-Length without wedging the stream", () => {
    const decoder = new FrameDecoder();
    const bad = Buffer.from("X-Bogus: 1\r\n\r\n", "ascii");
    expect(decoder.push(bad)).toEqual([]);
    expect(decoder.push(encodeFrame({ id: 1, result: "after-bad-header" }))).toEqual([
      { id: 1, result: "after-bad-header" },
    ]);
  });
});

// SPDX-License-Identifier: Apache-2.0

// LSP base-protocol framing: a message is `Content-Length: N\r\n\r\n<json>`, where N counts the
// UTF-8 bytes of the JSON payload (LSP §Base Protocol). This is the ONLY wire difference from the
// newline-delimited MCP stdio transport — the JSON-RPC 2.0 payload above it is identical. We
// hand-roll the parser/serializer rather than pull a framing dependency (the zero-new-dep rule).

/** Serialize a JSON-RPC frame into an LSP-framed buffer (header + body, byte-counted). */
export function encodeFrame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.from(`Content-Length: ${String(body.length)}\r\n\r\n`, "ascii");
  return Buffer.concat([header, body]);
}

/**
 * An incremental Content-Length reader: feed it stdout chunks, get back each complete JSON payload.
 * Stateful by design — a single frame can split across many `data` events, so the buffer carries
 * partial bytes between calls. Header parsing is byte-exact (the length is in BYTES, not chars), so
 * a multibyte payload never under-reads.
 */
export class FrameDecoder {
  // Typed as the broad Buffer so a child-stdout chunk (Buffer<ArrayBufferLike>) and a Buffer.concat
  // result (Buffer<ArrayBuffer>) are both assignable without a cast.
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  /** Bytes of the body still owed for the frame whose header we've already consumed, or null. */
  private expected: number | null = null;

  /** Append a stdout chunk and return every JSON payload that completed (parsed, still untrusted). */
  push(chunk: Buffer): unknown[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const out: unknown[] = [];
    for (;;) {
      if (this.expected === null) {
        const headerEnd = this.buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) break; // header still incomplete — wait for more bytes
        const header = this.buffer.subarray(0, headerEnd).toString("ascii");
        const length = parseContentLength(header);
        // A header with no parseable Content-Length is corrupt; skip past it rather than wedge
        // the stream forever waiting on a body whose size we never learned.
        this.buffer = this.buffer.subarray(headerEnd + 4);
        if (length === null) continue;
        this.expected = length;
      }
      if (this.buffer.length < this.expected) break; // body not all here yet
      const bodyBytes = this.buffer.subarray(0, this.expected);
      this.buffer = this.buffer.subarray(this.expected);
      this.expected = null;
      const payload = tryParse(bodyBytes);
      if (payload !== undefined) out.push(payload);
    }
    return out;
  }
}

/** Pull the byte count out of an LSP header block (other header fields are ignored). */
function parseContentLength(header: string): number | null {
  for (const line of header.split("\r\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    if (line.slice(0, colon).trim().toLowerCase() !== "content-length") continue;
    const value = Number.parseInt(line.slice(colon + 1).trim(), 10);
    return Number.isInteger(value) && value >= 0 ? value : null;
  }
  return null;
}

/** Parse a body; `undefined` (never a thrown error) for non-JSON noise so one bad frame can't crash the stream. */
function tryParse(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

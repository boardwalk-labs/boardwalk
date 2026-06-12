// Server-Sent Events parsing, shared by the provider adapters (streamed model turns) and the
// MCP streamable-HTTP transport (a server may answer any POST with an SSE stream). One parser
// so the two consumers can't drift on framing edge cases (CRLF, split chunks, [DONE]).

/** Iterate the `data:` payloads of an SSE response body. */
export async function* sseDataLines(response: Response): AsyncGenerator<string> {
  const body = response.body;
  if (body === null) return;
  const decoder = new TextDecoder();
  let buffer = "";
  // Why the explicit AsyncIterable<unknown>: undici types the stream's chunks as `any`;
  // narrowing each chunk keeps the no-unsafe rules honest.
  const chunks: AsyncIterable<unknown> = body;
  for await (const chunk of chunks) {
    if (!(chunk instanceof Uint8Array)) continue;
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trimEnd();
      buffer = buffer.slice(newline + 1);
      if (line.startsWith("data:")) {
        const data = line.slice(5).trim();
        if (data.length > 0 && data !== "[DONE]") yield data;
      }
      newline = buffer.indexOf("\n");
    }
  }
}

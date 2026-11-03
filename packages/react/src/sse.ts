export interface SseEvent {
  event: string;
  data: unknown;
}

function parseData(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return data;
  }
}

/**
 * Parse a server-sent event byte stream. Chunks can split anywhere, including
 * inside a multi-byte character or a CRLF, so nothing is assumed about where
 * they end.
 */
export async function* readSseStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<SseEvent, void, undefined> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "message";
  let dataLines: string[] = [];

  function takeEvent(): SseEvent | undefined {
    const parsed = dataLines.length
      ? { event, data: parseData(dataLines.join("\n")) }
      : undefined;
    event = "message";
    dataLines = [];
    return parsed;
  }

  function* drain(final: boolean): Generator<SseEvent> {
    while (true) {
      const match = /\r\n|\n|\r/.exec(buffer);
      if (!match) return;
      // A trailing CR may be the first half of a CRLF split across chunks.
      if (match[0] === "\r" && match.index === buffer.length - 1 && !final) return;

      const line = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);

      if (line === "") {
        const parsed = takeEvent();
        if (parsed) yield parsed;
        continue;
      }
      if (line.startsWith(":")) continue;

      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);

      if (field === "event") event = value;
      else if (field === "data") dataLines.push(value);
    }
  }

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      yield* drain(false);
    }
    buffer += decoder.decode();
    // Treat the end of the stream as ending the last line and event, in case the
    // server closed without a final blank line.
    buffer += "\n\n";
    yield* drain(true);
  } finally {
    // Closes the connection if the caller stopped reading early. Rejects if the
    // stream has already errored, which no longer matters here.
    void reader.cancel().catch(() => {});
  }
}

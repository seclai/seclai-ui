import { describe, expect, it } from "vitest";
import { readSseStream, type SseEvent } from "../src/sse";
import { streamOf } from "./helpers";

async function collect(stream: ReadableStream<Uint8Array>) {
  const events: SseEvent[] = [];
  for await (const event of readSseStream(stream)) events.push(event);
  return events;
}

describe("readSseStream", () => {
  it("parses events and JSON data", async () => {
    expect(
      await collect(streamOf('event: init\ndata: {"run_id":"r"}\n\nevent: done\ndata: {"a":1}\n\n')),
    ).toEqual([
      { event: "init", data: { run_id: "r" } },
      { event: "done", data: { a: 1 } },
    ]);
  });

  it("reassembles events split across every possible chunk boundary", async () => {
    const text = 'event: stream_token\ndata: {"token":"hi"}\n\n';
    for (let i = 1; i < text.length; i++) {
      expect(await collect(streamOf(text.slice(0, i), text.slice(i)))).toEqual([
        { event: "stream_token", data: { token: "hi" } },
      ]);
    }
  });

  it("keeps a multi-byte character split across chunks", async () => {
    const bytes = new TextEncoder().encode('event: t\ndata: {"token":"é✓"}\n\n');
    const split = bytes.indexOf(0xc3) + 1;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, split));
        controller.enqueue(bytes.slice(split));
        controller.close();
      },
    });
    expect(await collect(stream)).toEqual([{ event: "t", data: { token: "é✓" } }]);
  });

  it("handles CRLF, including one split across chunks", async () => {
    expect(await collect(streamOf("event: a\r\ndata: 1\r", "\n\r\n"))).toEqual([
      { event: "a", data: 1 },
    ]);
  });

  it("ignores keepalive comments", async () => {
    expect(await collect(streamOf(": keepalive\n\nevent: a\ndata: 1\n\n: keepalive\n\n"))).toEqual([
      { event: "a", data: 1 },
    ]);
  });

  it("joins multiple data lines and falls back to the raw string", async () => {
    expect(await collect(streamOf("event: a\ndata: one\ndata: two\n\n"))).toEqual([
      { event: "a", data: "one\ntwo" },
    ]);
  });

  it("defaults the event name to message", async () => {
    expect(await collect(streamOf("data: 1\n\n"))).toEqual([{ event: "message", data: 1 }]);
  });

  it("delivers a last event with no trailing blank line", async () => {
    expect(await collect(streamOf("event: a\ndata: 1"))).toEqual([{ event: "a", data: 1 }]);
  });
});

/** One SSE frame, as the handlers send it. */
export function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

export function sseResponse(...chunks: string[]): Response {
  return new Response(streamOf(...chunks), {
    headers: { "content-type": "text/event-stream" },
  });
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/**
 * A run response the test feeds by hand. Like a real fetch body, it errors when
 * the request's signal aborts.
 */
export function controlledResponse(signal: AbortSignal | null | undefined) {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  signal?.addEventListener("abort", () => {
    controller.error(new DOMException("Aborted", "AbortError"));
  });
  return {
    response: new Response(body),
    push: (text: string) => controller.enqueue(encoder.encode(text)),
    close: () => controller.close(),
  };
}

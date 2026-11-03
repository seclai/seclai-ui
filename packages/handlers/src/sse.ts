import type { AgentRunEvent } from "@seclai/sdk";
import { streamErrorMessage } from "./errors";

/**
 * The SDK's parser drops the API's keepalive comments, so the relay has to send
 * its own or a platform may cut the connection during a long silent step. The
 * interval matches the API's.
 */
export const KEEPALIVE_INTERVAL_MS = 15_000;

export const SSE_HEADERS: HeadersInit = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  // Stops nginx-style proxies from buffering the whole stream.
  "x-accel-buffering": "no",
};

const encoder = new TextEncoder();

function frame(event: string, data: unknown): Uint8Array {
  // JSON.stringify never emits a raw newline, so one `data:` line is enough.
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Re-emit an agent run's events as an SSE byte stream.
 *
 * @param first - The event already read from `events`. Reading it first lets the
 *   caller report a rejected run as an HTTP error instead of a 200 stream.
 * @param events - The rest of the run's events.
 * @param abort - Stops the upstream request when the browser disconnects.
 */
export function relayRunEvents(
  first: AgentRunEvent | undefined,
  events: AsyncGenerator<AgentRunEvent, void, undefined>,
  abort: () => void,
): ReadableStream<Uint8Array> {
  let closed = false;
  let keepalive: ReturnType<typeof setInterval> | undefined;

  const finish = () => {
    closed = true;
    clearInterval(keepalive);
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (!first) {
        finish();
        controller.close();
        return;
      }
      controller.enqueue(frame(first.event, first.data));
      keepalive = setInterval(() => {
        if (!closed) controller.enqueue(encoder.encode(": keepalive\n\n"));
      }, KEEPALIVE_INTERVAL_MS);
    },
    async pull(controller) {
      if (closed) return;
      try {
        const next = await events.next();
        if (closed) return;
        if (next.done) {
          finish();
          controller.close();
          return;
        }
        controller.enqueue(frame(next.value.event, next.value.data));
      } catch (err) {
        if (closed) return;
        finish();
        controller.enqueue(frame("error", { error: streamErrorMessage(err) }));
        controller.close();
      }
    },
    cancel() {
      finish();
      abort();
      // Not awaited: return() queues behind any next() still in flight.
      void events.return().catch(() => {});
    },
  });
}

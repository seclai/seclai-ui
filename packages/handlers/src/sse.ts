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

/** Why a relayed stream stopped. */
export type RunCloseReason =
  /** The upstream ended. */
  | "end"
  /** The browser cancelled the stream. */
  | "cancel"
  /** An observer hook threw. */
  | "error";

/** Where an event passed to {@link RunStreamObserver.onEvent} came from. */
export type RunEventSource =
  /** The API sent it. */
  | "upstream"
  /** The relay made it, in place of the events still to come, because the upstream connection failed. */
  | "connection-lost";

/** Hooks into {@link relayRunEvents}. Each is awaited before the relay goes on. */
export interface RunStreamObserver {
  /** Each event, in order, before it is relayed. */
  onEvent(event: AgentRunEvent, source: RunEventSource): void | Promise<void>;
  /**
   * Called on cancel with the event read before the stream started, if it was
   * never relayed. It was not passed to `onEvent`, but the observer may want to
   * note what it says, such as the run's id.
   */
  onUnrelayed?(event: AgentRunEvent): void;
  /**
   * Called once when the stream stops, whatever the reason, before it closes.
   * After a terminal event this is just the end of the stream.
   */
  onClose(reason: RunCloseReason): void | Promise<void>;
  /** Called with whatever `onEvent` or `onClose` threw. */
  onError(err: unknown): void;
}

/** The `error` frame sent in place of an event when an observer hook throws. */
export const OBSERVER_ERROR_MESSAGE = "The server could not process the run.";

/**
 * Re-emit an agent run's events as an SSE byte stream.
 *
 * With an `observer`, each event is relayed only once `observer.onEvent` has
 * resolved for it. If a hook throws, the event isn't relayed: the upstream is
 * closed and the stream ends with an `error` frame instead. A cancel waits for
 * a hook that is still running before it reports the close.
 *
 * @param first - The event already read from `events`. Reading it first lets the
 *   caller report a rejected run as an HTTP error instead of a 200 stream.
 * @param events - The rest of the run's events.
 * @param abort - Stops the upstream request when the browser disconnects.
 * @param observer - Sees each event before it is relayed, and how the stream stopped.
 */
export function relayRunEvents(
  first: AgentRunEvent | undefined,
  events: AsyncGenerator<AgentRunEvent, void, undefined>,
  abort: () => void,
  observer?: RunStreamObserver,
): ReadableStream<Uint8Array> {
  let pending = first;
  /** Nothing more is read from upstream or relayed. */
  let closed = false;
  /** The browser cancelled: the controller can no longer be used. */
  let cancelled = false;
  /** The close as reported to the observer, once it has been. */
  let closeReport: Promise<boolean> | undefined;
  /** The observer work of a `pull` still in progress, which `cancel` waits for. */
  let inflight: Promise<void> | undefined;
  let keepalive: ReturnType<typeof setInterval> | undefined;

  const finish = () => {
    closed = true;
    clearInterval(keepalive);
  };

  const stopUpstream = () => {
    abort();
    // Not awaited: return() queues behind any next() still in flight.
    void events.return().catch(() => {});
  };

  /** Run an observer hook. Resolves to false if it threw. */
  const call = async (hook: () => void | Promise<void>): Promise<boolean> => {
    try {
      await hook();
      return true;
    } catch (err) {
      try {
        observer?.onError(err);
      } catch {
        // Nothing left to report it to.
      }
      return false;
    }
  };

  /** Report the close once. Later calls get the first report's result. */
  const reportClose = (reason: RunCloseReason): Promise<boolean> => {
    if (!observer) return Promise.resolve(true);
    return (closeReport ??= call(() => observer.onClose(reason)));
  };

  const end = (controller: ReadableStreamDefaultController<Uint8Array>, last?: Uint8Array) => {
    if (cancelled) return;
    if (last) controller.enqueue(last);
    controller.close();
  };

  /** Stop after an observer hook threw. */
  const fail = async (controller: ReadableStreamDefaultController<Uint8Array>) => {
    finish();
    stopUpstream();
    await reportClose("error");
    end(controller, frame("error", { error: OBSERVER_ERROR_MESSAGE }));
  };

  /** Pass one event to the observer, then to the browser. */
  const relay = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    event: AgentRunEvent,
    source: RunEventSource = "upstream",
  ): Promise<void> => {
    const work = (async () => {
      if (observer && !(await call(() => observer.onEvent(event, source)))) {
        if (!closed) await fail(controller);
        return;
      }
      if (closed) return;
      controller.enqueue(frame(event.event, event.data));
    })();
    inflight = work;
    return work;
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      keepalive = setInterval(() => {
        if (!closed) controller.enqueue(encoder.encode(": keepalive\n\n"));
      }, KEEPALIVE_INTERVAL_MS);
    },
    async pull(controller) {
      if (closed) return;
      if (pending) {
        const event = pending;
        pending = undefined;
        await relay(controller, event);
        return;
      }

      let next: IteratorResult<AgentRunEvent, void>;
      try {
        next = await events.next();
      } catch (err) {
        if (closed) return;
        await relay(
          controller,
          { event: "error", data: { error: streamErrorMessage(err) } },
          "connection-lost",
        );
        if (closed) return;
        finish();
        await reportClose("end");
        end(controller);
        return;
      }
      if (closed) return;
      if (next.done) {
        finish();
        const ok = await reportClose("end");
        end(controller, ok ? undefined : frame("error", { error: OBSERVER_ERROR_MESSAGE }));
        return;
      }
      await relay(controller, next.value);
    },
    async cancel() {
      cancelled = true;
      finish();
      stopUpstream();
      const unrelayed = pending;
      pending = undefined;
      if (unrelayed && observer?.onUnrelayed) {
        await call(() => observer.onUnrelayed!(unrelayed));
      }
      // A pull may still be inside an observer hook. Its event belongs in the
      // outcome, and the close must not be reported alongside it. A pull
      // waiting on the upstream doesn't count: the abort above ends that wait.
      await inflight;
      await reportClose("cancel");
    },
  });
}

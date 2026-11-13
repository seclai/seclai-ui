import type { RunRequestBody } from "./handlers";
import { OBSERVER_ERROR_MESSAGE, type RunEventSource, type RunStreamObserver } from "./sse";

/** One event of the run stream, as the API sent it. `data` is the parsed JSON. */
export interface RunEvent {
  event: string;
  data: unknown;
}

/** What the run callbacks get besides the event or outcome. The same object for the whole run. */
export interface RunCallbackContext {
  /** The validated body of the `run` request. */
  body: RunRequestBody;
  /** The browser's request to the `run` handler. */
  request: Request;
}

export type RunOutcomeStatus = "completed" | "failed" | "cancelled";

/** A file the run produced, as stored with the outcome. Fetch it with the `download` handler. */
export interface RunOutcomeAttachment {
  id: string;
  name: string | null;
  mime: string;
}

/** How a run ended, as reported to `onRunEnd`. */
export interface RunOutcome {
  /** From `init` or `done`. `null` if the stream ended before either. */
  runId: string | null;
  /**
   * `cancelled` means the browser went away before the run ended. The run
   * itself may still finish on Seclai.
   */
  status: RunOutcomeStatus;
  /** The run's output when it completed, otherwise the text streamed so far. */
  output: string;
  /** Files from `done`. Empty unless the run sent `done`. */
  attachments: RunOutcomeAttachment[];
  /** Why the run failed. `null` unless `status` is `failed`. */
  error: string | null;
}

export type RunEventCallback = (event: RunEvent, ctx: RunCallbackContext) => void | Promise<void>;
export type RunEndCallback = (outcome: RunOutcome, ctx: RunCallbackContext) => void | Promise<void>;

const NO_RESULT_MESSAGE = "The stream ended without a result.";
const TIMEOUT_MESSAGE = "Stopped waiting for the run. It may still finish on Seclai.";
const FAILED_MESSAGE = "The run failed.";

interface RunSnapshot {
  run_id?: unknown;
  status?: unknown;
  output?: unknown;
  attachments?: unknown;
  attempts?: unknown;
}

function lastAttemptError(run: RunSnapshot): string | null {
  if (!Array.isArray(run.attempts)) return null;
  for (let i = run.attempts.length - 1; i >= 0; i--) {
    const error = (run.attempts[i] as { error?: unknown } | null)?.error;
    if (typeof error === "string" && error) return error;
  }
  return null;
}

function toAttachments(raw: unknown): RunOutcomeAttachment[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item: { id?: unknown; name?: unknown; mime?: unknown } | null) =>
    typeof item?.id === "string"
      ? [
          {
            id: item.id,
            name: typeof item.name === "string" ? item.name : null,
            mime: typeof item.mime === "string" ? item.mime : "application/octet-stream",
          },
        ]
      : [],
  );
}

/**
 * Turn the `onEvent` and `onRunEnd` options into an observer for
 * `relayRunEvents`. `onRunEnd` gets exactly one outcome: on `done`, `error` or
 * `timeout`, or when the stream ends, is cancelled or fails without one.
 */
export function createRunObserver(
  callbacks: { onEvent?: RunEventCallback; onRunEnd?: RunEndCallback },
  ctx: RunCallbackContext,
  { keepReading = false }: { keepReading?: boolean } = {},
): RunStreamObserver {
  const { onEvent, onRunEnd } = callbacks;
  /**
   * Whether the browser leaving stopped the upstream. When the relay keeps
   * reading after a disconnect it doesn't, so a lost connection or a quiet end
   * is a real failure, not the browser leaving.
   */
  const browserStoppedUpstream = () => !keepReading && !!ctx.request.signal?.aborted;
  let runId: string | null = null;
  let text = "";
  /** How the run ended, once an event has said so. Not reported until its `onEvent` resolves. */
  let terminal: RunOutcome | undefined;
  let ended = false;

  const outcome = (o: Omit<RunOutcome, "runId" | "attachments"> & Partial<RunOutcome>): RunOutcome => ({
    runId,
    attachments: [],
    ...o,
  });

  const end = async (o: RunOutcome) => {
    if (ended) return;
    // Set before awaiting, so a cancel that lands meanwhile can't report again.
    ended = true;
    await onRunEnd?.(o, ctx);
  };

  const failed = (error: string) => outcome({ status: "failed", output: text, error });
  const cancelled = () => outcome({ status: "cancelled", output: text, error: null });

  /**
   * Note what an event says about the run. Runs before the user's `onEvent` is
   * awaited, so the outcome is complete however a cancel is timed.
   */
  const record = (event: RunEvent, source: RunEventSource) => {
    const payload = (
      typeof event.data === "object" && event.data !== null ? event.data : {}
    ) as Record<string, unknown>;
    if (typeof payload.run_id === "string" && runId === null) runId = payload.run_id;
    if (terminal) return;

    switch (event.event) {
      case "stream_token":
        if (typeof payload.token === "string") text += payload.token;
        return;
      case "done": {
        const run = payload as RunSnapshot;
        if (typeof run.run_id === "string") runId = run.run_id;
        const attachments = toAttachments(run.attachments);
        // A failed run's `output` can hold text that failed validation, so
        // the streamed text is kept instead.
        terminal =
          run.status === "failed"
            ? outcome({
                status: "failed",
                output: text,
                attachments,
                error: lastAttemptError(run) ?? FAILED_MESSAGE,
              })
            : outcome({
                status: "completed",
                // Agents with no streaming step send no tokens, so `output`
                // may be the only text.
                output: (typeof run.output === "string" && run.output) || text,
                attachments,
                error: null,
              });
        return;
      }
      case "error":
        // On some runtimes the request's signal fires before the stream is
        // cancelled. The aborted upstream then looks like a lost connection,
        // but it was the browser leaving. An `error` from the API is a real
        // failure either way.
        terminal =
          source === "connection-lost" && browserStoppedUpstream()
            ? cancelled()
            : failed(typeof payload.error === "string" && payload.error ? payload.error : FAILED_MESSAGE);
        return;
      case "timeout":
        terminal = failed(TIMEOUT_MESSAGE);
        return;
    }
  };

  return {
    async onEvent(event, source) {
      record(event, source);
      await onEvent?.(event, ctx);
      if (terminal) await end(terminal);
    },

    onUnrelayed(event) {
      record(event, "upstream");
    },

    async onClose(reason) {
      switch (reason) {
        case "end":
          // See `record`: an upstream aborted by the browser can end quietly too.
          return end(terminal ?? (browserStoppedUpstream() ? cancelled() : failed(NO_RESULT_MESSAGE)));
        case "error":
          return end(failed(OBSERVER_ERROR_MESSAGE));
        case "cancel":
          return end(terminal ?? cancelled());
      }
    },

    onError(err) {
      // The browser only sees a generic error, so this is the one place the
      // cause shows up.
      console.error("@seclai/handlers: an onEvent or onRunEnd callback threw.", err);
    },
  };
}

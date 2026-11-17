import type { AgentRunEvent } from "@seclai/sdk";
import { errorLogFields } from "./errors";
import { lastAttemptError } from "./run-callbacks";
import type { SeclaiLogFields, SeclaiLogger } from "./logger";
import type { RunCloseReason, RunEventSource } from "./sse";

/** How often a progress line is logged while tokens stream. */
export const PROGRESS_INTERVAL_MS = 5_000;

export const ZERO_TOKENS_MESSAGE =
  "no tokens streamed: the agent's result step may be `display_result` rather than `streaming_result`";

/** Logs one run's lifecycle. Every method is safe to call: the logger never throws. */
export interface RunLog {
  /** The upstream sent its first event, or ended without one. */
  opened(empty: boolean): void;
  /** The API rejected the run, or couldn't be reached, before the stream started. */
  rejected(err: unknown, status: number): void;
  /** The browser left. Logged once, and only if the run's end wasn't logged first. */
  disconnected(): void;
  /**
   * The browser left and the run is being read on in the background
   * (`keepReadingAfterDisconnect`). Its end is still logged when it comes.
   */
  readingOn(): void;
  /** Each event, as it arrives. `done`, `error` and `timeout` are only logged at debug here. */
  event(event: AgentRunEvent): void;
  /**
   * A `done`, `error` or `timeout` event, once the callbacks have handled it,
   * so the line matches the outcome `onRunEnd` got. Only the first is logged.
   */
  result(event: AgentRunEvent, source: RunEventSource): void;
  /** What the upstream threw. Logged with the `connection-lost` error event that follows. */
  connectionError(err: unknown): void;
  keepalive(): void;
  /** The stream stopped. Called once the callbacks have handled the stop. */
  close(reason: RunCloseReason): void;
  callbackError(err: unknown): void;
}

export interface RunLogStart {
  sessionId?: string;
  uploads: number;
  inputChars: number;
  /** Whether the browser has left. Checked when the upstream fails. */
  disconnected: () => boolean;
}

/**
 * Start logging a run: logs `run starting` now, and the rest as the handler
 * and the relay report it. `logger` must already be wrapped by `safeLogger`.
 */
export function startRunLog(log: SeclaiLogger, start: RunLogStart): RunLog {
  const startedAt = Date.now();
  let runId: string | null = null;
  let tokens = 0;
  let chars = 0;
  let firstTokenAt: number | null = null;
  let lastProgressAt = 0;
  let lastStep: string | null = null;
  /** The run's end, or the browser's departure, was logged. */
  let ended = false;
  /** Why the upstream failed, from {@link RunLog.connectionError}. */
  let cause: SeclaiLogFields | undefined;

  const ms = () => Date.now() - startedAt;
  const ctx = (fields?: SeclaiLogFields): SeclaiLogFields => ({
    run_id: runId ?? undefined,
    session_id: start.sessionId,
    ...fields,
  });

  const disconnected = () => {
    if (ended) return;
    ended = true;
    log.info("browser disconnected; the run continues on Seclai", ctx({ tokens, ms: ms() }));
  };

  log.info("run starting", {
    session_id: start.sessionId,
    uploads: start.uploads,
    input_chars: start.inputChars,
  });

  return {
    opened(empty) {
      if (empty) log.info("stream open", ctx({ ms: ms(), empty: true }));
      else log.info("stream open", ctx({ ms: ms() }));
    },

    disconnected,

    readingOn() {
      if (ended) return;
      log.info("browser left; reading the rest of the run in the background", ctx({ tokens, ms: ms() }));
    },

    rejected(err, status) {
      log.error("run rejected", ctx({ status, ...errorLogFields(err), ms: ms() }));
    },

    event({ event, data }) {
      const payload = (typeof data === "object" && data !== null ? data : {}) as Record<
        string,
        unknown
      >;
      if (runId === null && typeof payload.run_id === "string") runId = payload.run_id;

      switch (event) {
        case "init":
          log.debug("event", ctx({ event }));
          log.info("run started", ctx());
          return;

        case "step_progress": {
          log.debug("event", ctx({ event }));
          const step =
            typeof payload.step_name === "string" && payload.step_name
              ? payload.step_name
              : String(payload.step_id ?? "?");
          const message = typeof payload.message === "string" ? payload.message : "";
          const key = `${step}\n${message}`;
          if (key === lastStep) return;
          lastStep = key;
          log.info("step", ctx({ step, message: message || undefined }));
          return;
        }

        case "stream_token": {
          const length = typeof payload.token === "string" ? payload.token.length : 0;
          tokens += 1;
          chars += length;
          log.debug("token", ctx({ n: tokens, chars: length }));
          const now = Date.now();
          if (firstTokenAt === null) {
            firstTokenAt = now;
            lastProgressAt = now;
            log.info("first token", ctx({ ms: now - startedAt }));
          } else if (now - lastProgressAt >= PROGRESS_INTERVAL_MS) {
            lastProgressAt = now;
            log.info("streaming", ctx({ tokens, chars, ms: now - startedAt }));
          }
          return;
        }

        case "done":
          if (typeof payload.run_id === "string") runId = payload.run_id;
          log.debug("event", ctx({ event }));
          return;

        default:
          log.debug("event", ctx({ event }));
      }
    },

    result({ event, data }, source) {
      if (ended) return;
      const payload = (typeof data === "object" && data !== null ? data : {}) as Record<
        string,
        unknown
      >;

      switch (event) {
        case "done": {
          ended = true;
          const output = typeof payload.output === "string" ? payload.output : "";
          const fields = ctx({
            status: payload.status,
            attachments: Array.isArray(payload.attachments) ? payload.attachments.length : 0,
            tokens,
            output_chars: output.length || chars,
            ms: ms(),
          });
          if (payload.status === "failed") {
            log.warn("run failed", { ...fields, error: lastAttemptError(payload) ?? undefined });
            return;
          }
          log.info("run done", fields);
          if (tokens === 0) log.warn(ZERO_TOKENS_MESSAGE, ctx());
          return;
        }

        case "error":
          if (source === "connection-lost" && start.disconnected()) {
            // The upstream was aborted because the browser left.
            disconnected();
            return;
          }
          ended = true;
          log.error(
            "stream error",
            ctx({
              error: payload.error,
              ...(source === "connection-lost" ? cause : undefined),
              tokens,
              ms: ms(),
            }),
          );
          return;

        case "timeout":
          ended = true;
          log.error("run timed out", ctx({ tokens, ms: ms() }));
          return;
      }
    },

    connectionError(err) {
      const { error, upstream_status } = errorLogFields(err);
      cause = { cause: error, upstream_status };
    },

    keepalive() {
      log.debug("keepalive", ctx({ ms: ms() }));
    },

    close(reason) {
      if (ended) {
        log.debug("stream closed", ctx({ reason, ms: ms() }));
        return;
      }
      switch (reason) {
        case "cancel":
          disconnected();
          return;
        case "end":
          // An upstream aborted by the browser can end quietly too.
          if (start.disconnected()) disconnected();
          else {
            ended = true;
            log.warn("stream ended without a result", ctx({ tokens, ms: ms() }));
          }
          return;
        case "error":
          ended = true;
          log.error("run failed: a callback threw", ctx({ status: "failed", tokens, ms: ms() }));
          return;
      }
    },

    callbackError(err) {
      log.error("an onEvent or onRunEnd callback threw", ctx({ error: err }));
    },
  };
}

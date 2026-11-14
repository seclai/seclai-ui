import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createEndpoints, readErrorMessage, type AgentEndpoints } from "./endpoints";
import { readSseStream, type SseEvent } from "./sse";
import type {
  AgentAttachment,
  AgentEndpointOptions,
  AgentRunStatus,
  AgentRunStep,
  RunFile,
  RunSnapshot,
} from "./types";

export interface AgentRunState {
  status: AgentRunStatus;
  /** Streamed tokens while running; the run's final `output` once it completes. */
  text: string;
  /** Latest progress per step, in the order the steps started. */
  steps: AgentRunStep[];
  attachments: AgentAttachment[];
  error: string | null;
  runId: string | null;
  /**
   * When the current run started, from `Date.now()`. Kept once the run ends, so
   * a UI can show how long it took. `null` until `start` is called, and again
   * after `reset`.
   */
  startedAt: number | null;
}

/** One event from the run stream: the SSE event name and its parsed JSON data. */
export type AgentRunEvent = SseEvent;

export interface UseAgentRunOptions extends AgentEndpointOptions {
  /**
   * Called with each event read from the run stream, in order, as the hook
   * applies it to the state. The latest callback is always used, so it can be
   * an inline function. Events from a cancelled, reset or superseded run are
   * not passed on. If it throws, the error is logged with `console.error` and
   * the run carries on.
   */
  onEvent?(event: AgentRunEvent): void;
}

export interface StartRunOptions {
  input?: string;
  uploadIds?: string[];
  /** Keys a conversation: sent to the agent as `metadata.session_id`. */
  sessionId?: string;
}

export interface UseAgentRunResult extends AgentRunState {
  /**
   * Start a run, cancelling any run in progress. Resolves with the final state
   * and never rejects: failures are reported through `status` and `error`.
   */
  start(options: StartRunOptions): Promise<AgentRunState>;
  /**
   * Stop streaming this run. This closes the connection but does not cancel the
   * run on Seclai, which may carry on and use credits.
   */
  cancel(): void;
  /**
   * Return to `idle` and clear the state, stopping any stream in progress as
   * `cancel` does. Like `cancel`, it doesn't stop the run on Seclai. A pending
   * `start` still resolves, with `status: "cancelled"` and the run's last
   * `text`, `runId` and `startedAt`, while the hook itself shows `idle`.
   */
  reset(): void;
}

const IDLE: AgentRunState = {
  status: "idle",
  text: "",
  steps: [],
  attachments: [],
  error: null,
  runId: null,
  startedAt: null,
};

function toAttachments(
  files: RunFile[] | undefined,
  runId: string | undefined,
  endpoints: AgentEndpoints,
): AgentAttachment[] {
  if (!files || !runId) return [];
  // Not the API's `download_url`: that host needs the key the browser doesn't have.
  return files.map(({ id, name, mime, bytes }) => ({
    id,
    name,
    mime,
    bytes,
    url: endpoints.download(runId, id, name),
  }));
}

function lastAttemptError(run: RunSnapshot): string | null {
  for (const attempt of [...(run.attempts ?? [])].reverse()) {
    if (attempt.error) return attempt.error;
  }
  return null;
}

/** Apply one event from the run stream. Unknown events leave the state unchanged. */
function applyEvent(
  state: AgentRunState,
  { event, data }: SseEvent,
  endpoints: AgentEndpoints,
): AgentRunState {
  const payload = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;

  switch (event) {
    case "init":
      return { ...state, runId: typeof payload.run_id === "string" ? payload.run_id : state.runId };

    case "stream_token":
      return typeof payload.token === "string"
        ? { ...state, text: state.text + payload.token }
        : state;

    case "step_progress": {
      if (typeof payload.step_id !== "string") return state;
      const step: AgentRunStep = {
        id: payload.step_id,
        name: typeof payload.step_name === "string" ? payload.step_name : payload.step_id,
        message: typeof payload.message === "string" ? payload.message : "",
      };
      const known = state.steps.some((s) => s.id === step.id);
      return {
        ...state,
        steps: known ? state.steps.map((s) => (s.id === step.id ? step : s)) : [...state.steps, step],
      };
    }

    case "done": {
      const run = payload as RunSnapshot;
      const runId = run.run_id ?? state.runId ?? undefined;
      const attachments = toAttachments(run.attachments, runId, endpoints);
      // Check status first: a failed run's `output` can hold raw text that failed
      // validation, so it isn't shown as the result.
      if (run.status === "failed") {
        return {
          ...state,
          status: "failed",
          runId: runId ?? null,
          attachments,
          error: lastAttemptError(run) ?? "The run failed.",
        };
      }
      return {
        ...state,
        status: "completed",
        runId: runId ?? null,
        attachments,
        // `output` wins over the tokens, which are only a progress channel. Agents
        // with no streaming step send no tokens, so this is their only text.
        text: run.output || state.text,
      };
    }

    case "error":
      return {
        ...state,
        status: "failed",
        error: typeof payload.error === "string" ? payload.error : "The run failed.",
      };

    case "timeout":
      return {
        ...state,
        status: "failed",
        error: "Stopped waiting for the run. It may still finish on Seclai.",
      };

    default:
      return state;
  }
}

/** Run an agent through the handlers' `run` endpoint and track the event stream. */
export function useAgentRun(options: UseAgentRunOptions = {}): UseAgentRunResult {
  const { basePath, agentId, onEvent } = options;
  const endpoints = useMemo(() => createEndpoints({ basePath, agentId }), [basePath, agentId]);
  const [state, setState] = useState<AgentRunState>(IDLE);
  const active = useRef<AbortController | null>(null);
  // Read at each event, so a new callback takes effect without restarting the run.
  const onEventRef = useRef(onEvent);
  useEffect(() => {
    onEventRef.current = onEvent;
  });

  // Stop streaming when the component goes away.
  useEffect(() => () => active.current?.abort(), []);

  const start = useCallback(
    async ({ input, uploadIds, sessionId }: StartRunOptions): Promise<AgentRunState> => {
      active.current?.abort();
      const controller = new AbortController();
      active.current = controller;

      let current: AgentRunState = { ...IDLE, status: "running", startedAt: Date.now() };
      // A superseded run must not write over the one that replaced it.
      const update = (next: AgentRunState) => {
        current = next;
        if (active.current === controller) setState(next);
      };
      update(current);

      try {
        const res = await fetch(endpoints.run, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ input, uploadIds, sessionId }),
          signal: controller.signal,
        });
        if (!res.ok) {
          update({ ...current, status: "failed", error: await readErrorMessage(res) });
          return current;
        }
        if (!res.body) {
          update({ ...current, status: "failed", error: "The response had no body to stream." });
          return current;
        }

        for await (const event of readSseStream(res.body)) {
          // An event already buffered when the run was stopped is dropped.
          if (controller.signal.aborted) break;
          update(applyEvent(current, event, endpoints));
          try {
            onEventRef.current?.(event);
          } catch (err) {
            // The caller's bug shouldn't fail the run.
            console.error("useAgentRun: onEvent threw", err);
          }
          if (current.status !== "running") break;
        }

        if (controller.signal.aborted) {
          if (current.status === "running") update({ ...current, status: "cancelled" });
        } else if (current.status === "running") {
          update({
            ...current,
            status: "failed",
            error: "The connection closed before the run finished.",
          });
        }
      } catch (err) {
        if (controller.signal.aborted) {
          update({ ...current, status: "cancelled" });
        } else {
          update({
            ...current,
            status: "failed",
            error: err instanceof Error ? err.message : "The run failed.",
          });
        }
      }
      return current;
    },
    [endpoints],
  );

  const cancel = useCallback(() => active.current?.abort(), []);

  const reset = useCallback(() => {
    // Clearing `active` first stops the aborted run from writing to the state.
    const controller = active.current;
    active.current = null;
    controller?.abort();
    setState(IDLE);
  }, []);

  return { ...state, start, cancel, reset };
}

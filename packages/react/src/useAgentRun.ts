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
}

const IDLE: AgentRunState = {
  status: "idle",
  text: "",
  steps: [],
  attachments: [],
  error: null,
  runId: null,
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
export function useAgentRun(options: AgentEndpointOptions = {}): UseAgentRunResult {
  const { basePath, agentId } = options;
  const endpoints = useMemo(() => createEndpoints({ basePath, agentId }), [basePath, agentId]);
  const [state, setState] = useState<AgentRunState>(IDLE);
  const active = useRef<AbortController | null>(null);

  // Stop streaming when the component goes away.
  useEffect(() => () => active.current?.abort(), []);

  const start = useCallback(
    async ({ input, uploadIds, sessionId }: StartRunOptions): Promise<AgentRunState> => {
      active.current?.abort();
      const controller = new AbortController();
      active.current = controller;

      let current: AgentRunState = { ...IDLE, status: "running" };
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
          update(applyEvent(current, event, endpoints));
          if (current.status !== "running") break;
        }

        if (current.status === "running") {
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

  return { ...state, start, cancel };
}

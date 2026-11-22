import { useEffect, useState, type ReactNode } from "react";
import type { AgentRunState } from "./useAgentRun";

/**
 * Whole seconds since `startedAt` (a `Date.now()` value, such as `useAgentRun`'s
 * `startedAt`), updated every second while `running`. It's 0 when `startedAt` is
 * `null`, and on the first render, so server and client render the same markup;
 * the real value follows in an effect. When `running` turns false it keeps its
 * last value and stops the timer.
 */
export function useElapsed(startedAt: number | null, running: boolean): number {
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    if (!running || startedAt === null) return;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const time = Date.now();
      setNow(time);
      // Wait for the next whole second of the run, so the clock doesn't lag.
      const into = (((time - startedAt) % 1000) + 1000) % 1000;
      timer = setTimeout(tick, 1000 - into);
    };
    tick();
    return () => clearTimeout(timer);
  }, [running, startedAt]);

  if (startedAt === null || now === null) return 0;
  return Math.max(0, Math.floor((now - startedAt) / 1000));
}

/** The fields `RunProgress` reads. A `useAgentRun` result fits, as does a plain object. */
export type RunProgressRun = Pick<AgentRunState, "status" | "steps" | "startedAt">;

export interface RunProgressProps {
  run: RunProgressRun;
  /** Show the step list. Defaults to true. */
  showSteps?: boolean;
  /**
   * A note shown next to the clock, or a function of the seconds elapsed, for a
   * note that changes as the run goes on. It's read out when it changes, so
   * don't put the seconds in it.
   */
  message?: ReactNode | ((seconds: number) => ReactNode);
  className?: string;
}

function formatClock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function spokenDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (minutes === 0) return unit(rest, "second");
  return rest === 0 ? unit(minutes, "minute") : `${unit(minutes, "minute")} ${unit(rest, "second")}`;
}

/**
 * A running run's steps and elapsed time. Renders nothing unless
 * `run.status` is `"running"`.
 */
export function RunProgress({ run, showSteps = true, message, className }: RunProgressProps) {
  const running = run.status === "running";
  const seconds = useElapsed(run.startedAt, running);
  if (!running) return null;

  const note = typeof message === "function" ? message(seconds) : message;
  const last = run.steps.length - 1;

  return (
    <div
      className={className ? `seclai-run-progress ${className}` : "seclai-run-progress"}
      aria-live="polite"
    >
      {showSteps &&
        (run.steps.length === 0 ? (
          <p className="seclai-notice">Starting the run…</p>
        ) : (
          <ol className="seclai-steps">
            {run.steps.map((step, i) => (
              <li key={step.id}>
                <span className="seclai-step-marker" aria-hidden="true">
                  {i === last ? "●" : "✓"}
                </span>
                <span className="seclai-sr-only">{i === last ? "In progress: " : "Done: "}</span>
                <span>
                  <span className="seclai-step-name">{step.name}</span>
                  {step.message && <span className="seclai-step-message"> · {step.message}</span>}
                </span>
              </li>
            ))}
          </ol>
        ))}
      <div className="seclai-run-progress-note">
        <span className="seclai-run-progress-pulse" aria-hidden="true" />
        {note != null && note !== false && note !== "" && (
          <span className="seclai-run-progress-message">{note}</span>
        )}
        {/* A timer isn't announced, so the region doesn't read out every tick. */}
        <span
          className="seclai-run-progress-clock"
          role="timer"
          aria-live="off"
          aria-label={`${spokenDuration(seconds)} elapsed`}
        >
          {formatClock(seconds)}
        </span>
      </div>
    </div>
  );
}

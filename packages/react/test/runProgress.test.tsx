import { act, render, renderHook, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunProgress, useElapsed, type RunProgressRun } from "../src";

const START = new Date("2026-01-01T12:00:00Z").getTime();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});

afterEach(() => {
  vi.useRealTimers();
});

const running = (steps: RunProgressRun["steps"] = []): RunProgressRun => ({
  status: "running",
  steps,
  startedAt: START,
});

describe("useElapsed", () => {
  it("is 0 without a start time, and sets no timer", () => {
    const { result } = renderHook(() => useElapsed(null, true));
    expect(result.current).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("counts whole seconds while running", async () => {
    const { result } = renderHook(() => useElapsed(START, true));
    expect(result.current).toBe(0);
    await act(() => vi.advanceTimersByTimeAsync(999));
    expect(result.current).toBe(0);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(result.current).toBe(1);
    await act(() => vi.advanceTimersByTimeAsync(41_000));
    expect(result.current).toBe(42);
  });

  it("catches up to a run that started before it mounted", () => {
    vi.setSystemTime(START + 90_500);
    const { result } = renderHook(() => useElapsed(START, true));
    expect(result.current).toBe(90);
  });

  it("stops ticking when the run stops", async () => {
    const { result, rerender } = renderHook(({ on }) => useElapsed(START, on), {
      initialProps: { on: true },
    });
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(result.current).toBe(5);

    rerender({ on: false });
    expect(vi.getTimerCount()).toBe(0);
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(result.current).toBe(5);
  });

  it("sets no timer when not running", () => {
    renderHook(() => useElapsed(START, false));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("renders 0 on the server, so hydration matches", () => {
    vi.setSystemTime(START + 30_000);
    function Clock() {
      return <span>{useElapsed(START, true)}</span>;
    }
    expect(renderToString(<Clock />)).toBe("<span>0</span>");
  });
});

describe("RunProgress", () => {
  it.each(["idle", "completed", "failed", "cancelled"] as const)("renders nothing when %s", (status) => {
    const { container } = render(
      <RunProgress run={{ status, steps: [{ id: "s", name: "Think", message: "" }], startedAt: START }} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("says the run is starting before the first step", () => {
    render(<RunProgress run={running()} />);
    expect(screen.getByText("Starting the run…")).toBeTruthy();
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("lists the steps, marking the last one as current", () => {
    render(
      <RunProgress
        run={running([
          { id: "a", name: "Plan", message: "done" },
          { id: "b", name: "Draw", message: "image 2 of 4" },
        ])}
      />,
    );
    const list = screen.getByRole("list");
    expect(list.tagName).toBe("OL");
    const items = screen.getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual([
      "✓Done: Plan · done",
      "●In progress: Draw · image 2 of 4",
    ]);
    for (const marker of list.querySelectorAll(".seclai-step-marker")) {
      expect(marker.getAttribute("aria-hidden")).toBe("true");
    }
    expect(screen.queryByText("Starting the run…")).toBeNull();
  });

  it("leaves out a step's empty message", () => {
    render(<RunProgress run={running([{ id: "a", name: "Plan", message: "" }])} />);
    expect(screen.getByRole("listitem").textContent).toBe("●In progress: Plan");
  });

  it("hides the steps when showSteps is false", () => {
    render(<RunProgress run={running([{ id: "a", name: "Plan", message: "" }])} showSteps={false} />);
    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.queryByText("Starting the run…")).toBeNull();
    expect(screen.getByRole("timer")).toBeTruthy();
  });

  it("shows a clock with a spoken label, outside the announcements", async () => {
    const { container } = render(<RunProgress run={running()} />);
    const clock = screen.getByRole("timer");
    expect(clock.textContent).toBe("0:00");
    expect(clock.getAttribute("aria-live")).toBe("off");
    expect(container.firstElementChild!.getAttribute("aria-live")).toBe("polite");

    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(clock.textContent).toBe("0:05");
    expect(clock.getAttribute("aria-label")).toBe("5 seconds elapsed");

    await act(() => vi.advanceTimersByTimeAsync(145_000));
    expect(clock.textContent).toBe("2:30");
    expect(clock.getAttribute("aria-label")).toBe("2 minutes 30 seconds elapsed");

    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(clock.getAttribute("aria-label")).toBe("3 minutes elapsed");
  });

  it("says 1 second, not 1 seconds", async () => {
    render(<RunProgress run={running()} />);
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(screen.getByRole("timer").getAttribute("aria-label")).toBe("1 second elapsed");
  });

  it("shows a message", () => {
    render(<RunProgress run={running()} message="Usually takes a minute." />);
    expect(screen.getByText("Usually takes a minute.")).toBeTruthy();
  });

  it("passes the seconds elapsed to a message function", async () => {
    const message = vi.fn((seconds: number) => (seconds < 150 ? "A minute or two." : "Still working…"));
    render(<RunProgress run={running()} message={message} />);
    expect(screen.getByText("A minute or two.")).toBeTruthy();
    expect(message).toHaveBeenLastCalledWith(0);

    await act(() => vi.advanceTimersByTimeAsync(150_000));
    expect(message).toHaveBeenLastCalledWith(150);
    expect(screen.getByText("Still working…")).toBeTruthy();
  });

  it("goes away when the run ends", async () => {
    const { container, rerender } = render(<RunProgress run={running()} />);
    rerender(<RunProgress run={{ ...running(), status: "completed" }} />);
    expect(container.innerHTML).toBe("");
    expect(vi.getTimerCount()).toBe(0);
  });
});

import { act, renderHook, waitFor } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAgentRun, type AgentRunEvent } from "../src";
import { controlledResponse, jsonResponse, sse, sseResponse } from "./helpers";

const RUN = "3f2b8c1e-7a4d-4e9b-9c11-0d5e6f7a8b9c";

/**
 * A run response that, unlike `controlledResponse`, keeps delivering after the
 * request is aborted, to stand in for events already in flight.
 */
function lateResponse() {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    response: new Response(body),
    push: (text: string) => controller.enqueue(encoder.encode(text)),
    close: () => controller.close(),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => impl(url, init));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("useAgentRun", () => {
  it("posts the run to the mounted endpoint", async () => {
    const fetchMock = stubFetch(() => sseResponse(sse("done", { status: "completed" })));
    const { result } = renderHook(() => useAgentRun({ basePath: "/custom/", agentId: "a 1" }));

    await act(() => result.current.start({ input: "hi", uploadIds: ["u"], sessionId: "s" }));

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/custom/a%201/run");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({ input: "hi", uploadIds: ["u"], sessionId: "s" });
  });

  it("defaults to /api/seclai", async () => {
    const fetchMock = stubFetch(() => sseResponse(sse("done", { status: "completed" })));
    const { result } = renderHook(() => useAgentRun());
    await act(() => result.current.start({ input: "hi" }));
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/seclai/run");
  });

  it("streams tokens as they arrive, then takes the final output and attachments", async () => {
    let feed!: ReturnType<typeof controlledResponse>;
    stubFetch((_url, init) => {
      feed = controlledResponse(init?.signal);
      return feed.response;
    });
    const { result } = renderHook(() => useAgentRun());

    let finished!: Promise<unknown>;
    act(() => {
      finished = result.current.start({ input: "hi" });
    });
    expect(result.current.status).toBe("running");

    await act(async () => {
      feed.push(sse("init", { run_id: RUN }));
      feed.push(sse("step_progress", { step_id: "s1", step_name: "Think", message: "started" }));
      feed.push(sse("stream_token", { token: "Hel" }));
    });
    await waitFor(() => expect(result.current.text).toBe("Hel"));
    expect(result.current.runId).toBe(RUN);

    await act(async () => {
      feed.push(sse("stream_token", { token: "lo" }));
      feed.push(sse("step_progress", { step_id: "s1", step_name: "Think", message: "completed" }));
    });
    await waitFor(() => expect(result.current.text).toBe("Hello"));
    expect(result.current.steps).toEqual([{ id: "s1", name: "Think", message: "completed" }]);

    await act(async () => {
      feed.push(
        sse("done", {
          run_id: RUN,
          status: "completed",
          output: "Final",
          attachments: [
            {
              id: "file-1",
              name: "a b.png",
              mime: "image/png",
              bytes: 3,
              download_url: "https://api.seclai.com/v2/secret-host",
            },
          ],
        }),
      );
      feed.close();
      await finished;
    });

    expect(result.current.status).toBe("completed");
    expect(result.current.text).toBe("Final");
    expect(result.current.attachments).toEqual([
      {
        id: "file-1",
        name: "a b.png",
        mime: "image/png",
        bytes: 3,
        url: `/api/seclai/download?runId=${RUN}&attachmentId=file-1&name=a+b.png`,
      },
    ]);
  });

  it("falls back to the done output when the agent sends no tokens", async () => {
    stubFetch(() =>
      sseResponse(sse("init", { run_id: RUN }), sse("done", { status: "completed", output: "All at once" })),
    );
    const { result } = renderHook(() => useAgentRun());
    await act(() => result.current.start({ input: "hi" }));
    expect(result.current.text).toBe("All at once");
  });

  it("keeps the streamed text if done has no output", async () => {
    stubFetch(() =>
      sseResponse(sse("stream_token", { token: "kept" }), sse("done", { status: "completed", output: null })),
    );
    const { result } = renderHook(() => useAgentRun());
    await act(() => result.current.start({ input: "hi" }));
    expect(result.current.text).toBe("kept");
  });

  it("does not present a failed run's output as the result", async () => {
    stubFetch(() =>
      sseResponse(
        sse("done", {
          status: "failed",
          output: "raw text that failed validation",
          attempts: [{ error: "first" }, { error: "Validation failed" }, { error: null }],
        }),
      ),
    );
    const { result } = renderHook(() => useAgentRun());
    await act(() => result.current.start({ input: "hi" }));

    expect(result.current.status).toBe("failed");
    expect(result.current.error).toBe("Validation failed");
    expect(result.current.text).toBe("");
  });

  it.each([
    ["error", { run_id: RUN, error: "boom" }, "boom"],
    ["timeout", { run_id: RUN }, "may still finish"],
  ])("fails on a %s event", async (event, data, message) => {
    stubFetch(() => sseResponse(sse("stream_token", { token: "partial" }), sse(event, data)));
    const { result } = renderHook(() => useAgentRun());
    await act(() => result.current.start({ input: "hi" }));

    expect(result.current.status).toBe("failed");
    expect(result.current.error).toContain(message);
    expect(result.current.text).toBe("partial");
  });

  it("fails when the stream ends without done", async () => {
    stubFetch(() => sseResponse(sse("init", { run_id: RUN })));
    const { result } = renderHook(() => useAgentRun());
    await act(() => result.current.start({ input: "hi" }));

    expect(result.current.status).toBe("failed");
    expect(result.current.error).toContain("closed");
  });

  it("reports an HTTP error from the handler", async () => {
    stubFetch(() => jsonResponse({ error: "photo needs at least 1 file", status: 400 }, 400));
    const { result } = renderHook(() => useAgentRun());
    await act(() => result.current.start({ input: "hi" }));

    expect(result.current.status).toBe("failed");
    expect(result.current.error).toBe("photo needs at least 1 file");
  });

  it("reports a network failure, and start resolves rather than rejects", async () => {
    stubFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    const { result } = renderHook(() => useAgentRun());

    let final: Awaited<ReturnType<typeof result.current.start>> | undefined;
    await act(async () => {
      final = await result.current.start({ input: "hi" });
    });

    expect(final?.status).toBe("failed");
    expect(result.current.error).toBe("Failed to fetch");
  });

  it("cancels, keeping the text so far", async () => {
    let feed!: ReturnType<typeof controlledResponse>;
    stubFetch((_url, init) => {
      feed = controlledResponse(init?.signal);
      return feed.response;
    });
    const { result } = renderHook(() => useAgentRun());

    let finished!: Promise<unknown>;
    act(() => {
      finished = result.current.start({ input: "hi" });
    });
    await act(async () => feed.push(sse("stream_token", { token: "partial" })));
    await waitFor(() => expect(result.current.text).toBe("partial"));

    await act(async () => {
      result.current.cancel();
      await finished;
    });

    expect(result.current.status).toBe("cancelled");
    expect(result.current.text).toBe("partial");
    expect(result.current.error).toBeNull();
  });

  it("does not let a superseded run overwrite the new one", async () => {
    const feeds: ReturnType<typeof controlledResponse>[] = [];
    stubFetch((_url, init) => {
      const feed = controlledResponse(init?.signal);
      feeds.push(feed);
      return feed.response;
    });
    const { result } = renderHook(() => useAgentRun());

    let first!: Promise<unknown>;
    act(() => {
      first = result.current.start({ input: "one" });
    });
    await waitFor(() => expect(feeds).toHaveLength(1));

    let second!: Promise<unknown>;
    act(() => {
      second = result.current.start({ input: "two" });
    });
    await first;
    expect(result.current.status).toBe("running");

    await act(async () => {
      await waitFor(() => expect(feeds).toHaveLength(2));
      feeds[1]!.push(sse("done", { status: "completed", output: "second" }));
      feeds[1]!.close();
      await second;
    });
    expect(result.current.text).toBe("second");
  });

  it("aborts the request on unmount", async () => {
    let signal: AbortSignal | null | undefined;
    stubFetch((_url, init) => {
      signal = init?.signal;
      return controlledResponse(signal).response;
    });
    const { result, unmount } = renderHook(() => useAgentRun());

    await act(async () => {
      void result.current.start({ input: "hi" });
    });
    await waitFor(() => expect(signal).toBeDefined());

    unmount();
    expect(signal?.aborted).toBe(true);
  });

  describe("reset", () => {
    it("is a no-op while idle", () => {
      const { result } = renderHook(() => useAgentRun());
      act(() => result.current.reset());
      expect(result.current).toMatchObject({
        status: "idle",
        text: "",
        steps: [],
        attachments: [],
        error: null,
        runId: null,
        startedAt: null,
      });
    });

    it("clears a finished run", async () => {
      stubFetch(() =>
        sseResponse(
          sse("init", { run_id: RUN }),
          sse("step_progress", { step_id: "s1", step_name: "Think", message: "done" }),
          sse("done", {
            run_id: RUN,
            status: "completed",
            output: "Final",
            attachments: [{ id: "f", name: "a.png", mime: "image/png", bytes: 1 }],
          }),
        ),
      );
      const { result } = renderHook(() => useAgentRun());
      await act(() => result.current.start({ input: "hi" }));
      expect(result.current.status).toBe("completed");
      expect(result.current.attachments).toHaveLength(1);

      act(() => result.current.reset());
      expect(result.current).toMatchObject({
        status: "idle",
        text: "",
        steps: [],
        attachments: [],
        error: null,
        runId: null,
        startedAt: null,
      });
    });

    it("clears a failed run's error", async () => {
      stubFetch(() => sseResponse(sse("error", { error: "boom" })));
      const { result } = renderHook(() => useAgentRun());
      await act(() => result.current.start({ input: "hi" }));
      expect(result.current.error).toBe("boom");

      act(() => result.current.reset());
      expect(result.current.status).toBe("idle");
      expect(result.current.error).toBeNull();
    });

    it("stops streaming a run in progress", async () => {
      let signal: AbortSignal | null | undefined;
      let feed!: ReturnType<typeof controlledResponse>;
      stubFetch((_url, init) => {
        signal = init?.signal;
        feed = controlledResponse(signal);
        return feed.response;
      });
      const { result } = renderHook(() => useAgentRun());

      let finished!: Promise<unknown>;
      act(() => {
        finished = result.current.start({ input: "hi" });
      });
      await act(async () => feed.push(sse("stream_token", { token: "partial" })));
      await waitFor(() => expect(result.current.text).toBe("partial"));

      await act(async () => {
        result.current.reset();
        await finished;
      });

      expect(signal?.aborted).toBe(true);
      expect(result.current.status).toBe("idle");
      expect(result.current.text).toBe("");
      expect(result.current.startedAt).toBeNull();
    });

    it("ignores events that arrive after it", async () => {
      const onEvent = vi.fn();
      let feed!: ReturnType<typeof lateResponse>;
      stubFetch(() => {
        feed = lateResponse();
        return feed.response;
      });
      const { result } = renderHook(() => useAgentRun({ onEvent }));

      let finished!: Promise<unknown>;
      act(() => {
        finished = result.current.start({ input: "hi" });
      });
      await act(async () => feed.push(sse("init", { run_id: RUN })));
      await waitFor(() => expect(result.current.runId).toBe(RUN));

      act(() => result.current.reset());
      await act(async () => {
        feed.push(sse("stream_token", { token: "late" }));
        feed.push(sse("done", { run_id: RUN, status: "completed", output: "late" }));
        feed.close();
        await finished;
      });

      expect(result.current.status).toBe("idle");
      expect(result.current.text).toBe("");
      expect(result.current.runId).toBeNull();
      expect(onEvent).toHaveBeenCalledTimes(1);
    });

    it("leaves the hook ready for another run", async () => {
      stubFetch(() => sseResponse(sse("done", { status: "completed", output: "again" })));
      const { result } = renderHook(() => useAgentRun());
      await act(() => result.current.start({ input: "hi" }));
      act(() => result.current.reset());
      await act(() => result.current.start({ input: "hi" }));
      expect(result.current.status).toBe("completed");
      expect(result.current.text).toBe("again");
    });
  });

  it("does not apply an event that arrives after cancel", async () => {
    let feed!: ReturnType<typeof lateResponse>;
    stubFetch(() => {
      feed = lateResponse();
      return feed.response;
    });
    const { result } = renderHook(() => useAgentRun());

    let finished!: Promise<unknown>;
    act(() => {
      finished = result.current.start({ input: "hi" });
    });
    await waitFor(() => expect(feed).toBeDefined());

    await act(async () => {
      result.current.cancel();
      feed.push(sse("done", { status: "completed", output: "late" }));
      feed.close();
      await finished;
    });

    expect(result.current.status).toBe("cancelled");
    expect(result.current.text).toBe("");
  });

  describe("startedAt", () => {
    it("is set when start begins and kept after the run ends", async () => {
      vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
      let feed!: ReturnType<typeof controlledResponse>;
      stubFetch((_url, init) => {
        feed = controlledResponse(init?.signal);
        return feed.response;
      });
      const { result } = renderHook(() => useAgentRun());
      expect(result.current.startedAt).toBeNull();

      let finished!: Promise<unknown>;
      act(() => {
        finished = result.current.start({ input: "hi" });
      });
      expect(result.current.startedAt).toBe(1_700_000_000_000);

      vi.spyOn(Date, "now").mockReturnValue(1_700_000_042_000);
      await act(async () => {
        feed.push(sse("done", { status: "completed", output: "ok" }));
        feed.close();
        await finished;
      });
      expect(result.current.status).toBe("completed");
      expect(result.current.startedAt).toBe(1_700_000_000_000);

      act(() => result.current.reset());
      expect(result.current.startedAt).toBeNull();
    });

    it("is kept after a failure and is in the state start resolves with", async () => {
      vi.spyOn(Date, "now").mockReturnValue(5);
      stubFetch(() => jsonResponse({ error: "nope" }, 400));
      const { result } = renderHook(() => useAgentRun());

      let final: Awaited<ReturnType<typeof result.current.start>> | undefined;
      await act(async () => {
        final = await result.current.start({ input: "hi" });
      });
      expect(final?.startedAt).toBe(5);
      expect(result.current.status).toBe("failed");
      expect(result.current.startedAt).toBe(5);
    });

    it("is renewed by the next start", async () => {
      stubFetch(() => sseResponse(sse("done", { status: "completed" })));
      const { result } = renderHook(() => useAgentRun());
      vi.spyOn(Date, "now").mockReturnValue(1);
      await act(() => result.current.start({ input: "one" }));
      vi.spyOn(Date, "now").mockReturnValue(2);
      await act(() => result.current.start({ input: "two" }));
      expect(result.current.startedAt).toBe(2);
    });
  });

  describe("onEvent", () => {
    it("receives every event in order, alongside the state", async () => {
      const events: AgentRunEvent[] = [];
      stubFetch(() =>
        sseResponse(
          sse("init", { run_id: RUN }),
          sse("stream_token", { token: "a" }),
          sse("unknown_event", { x: 1 }),
          sse("done", { run_id: RUN, status: "completed", output: "a" }),
        ),
      );
      const { result } = renderHook(() =>
        useAgentRun({ onEvent: (event) => events.push(event) }),
      );
      await act(() => result.current.start({ input: "hi" }));

      expect(events).toEqual([
        { event: "init", data: { run_id: RUN } },
        { event: "stream_token", data: { token: "a" } },
        { event: "unknown_event", data: { x: 1 } },
        { event: "done", data: { run_id: RUN, status: "completed", output: "a" } },
      ]);
      // The reducer still runs.
      expect(result.current.status).toBe("completed");
      expect(result.current.text).toBe("a");
    });

    it("uses the latest callback after a rerender, without restarting the run", async () => {
      let feed!: ReturnType<typeof controlledResponse>;
      const fetchMock = stubFetch((_url, init) => {
        feed = controlledResponse(init?.signal);
        return feed.response;
      });
      const first = vi.fn();
      const second = vi.fn();
      const { result, rerender } = renderHook(
        ({ onEvent }: { onEvent: (event: AgentRunEvent) => void }) => useAgentRun({ onEvent }),
        { initialProps: { onEvent: first } },
      );

      let finished!: Promise<unknown>;
      act(() => {
        finished = result.current.start({ input: "hi" });
      });
      await act(async () => feed.push(sse("stream_token", { token: "a" })));
      await waitFor(() => expect(first).toHaveBeenCalledTimes(1));

      rerender({ onEvent: second });
      await act(async () => {
        feed.push(sse("stream_token", { token: "b" }));
        feed.push(sse("done", { status: "completed" }));
        feed.close();
        await finished;
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(first).toHaveBeenCalledTimes(1);
      expect(second.mock.calls.map(([e]) => e.event)).toEqual(["stream_token", "done"]);
      expect(result.current.text).toBe("ab");
    });

    it("logs a throwing callback and carries on with the run", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      const boom = new Error("handler bug");
      const onEvent = vi.fn(() => {
        throw boom;
      });
      stubFetch(() =>
        sseResponse(
          sse("stream_token", { token: "a" }),
          sse("done", { status: "completed", output: "done" }),
        ),
      );
      const { result } = renderHook(() => useAgentRun({ onEvent }));
      await act(() => result.current.start({ input: "hi" }));

      expect(onEvent).toHaveBeenCalledTimes(2);
      expect(consoleError).toHaveBeenCalledTimes(2);
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("onEvent"), boom);
      expect(result.current.status).toBe("completed");
      expect(result.current.text).toBe("done");
      expect(result.current.error).toBeNull();
    });
  });

  it("renders on the server", () => {
    function Component() {
      return <span>{useAgentRun().status}</span>;
    }
    expect(renderToString(<Component />)).toContain("idle");
  });
});

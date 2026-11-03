import { act, renderHook, waitFor } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { useAgentRun } from "../src";
import { controlledResponse, jsonResponse, sse, sseResponse } from "./helpers";

const RUN = "3f2b8c1e-7a4d-4e9b-9c11-0d5e6f7a8b9c";

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

  it("renders on the server", () => {
    function Component() {
      return <span>{useAgentRun().status}</span>;
    }
    expect(renderToString(<Component />)).toContain("idle");
  });
});

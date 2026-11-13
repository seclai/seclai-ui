import { SeclaiAPIStatusError, SeclaiStreamingError, type AgentRunEvent } from "@seclai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSeclaiHandlers,
  type RunCallbackContext,
  type RunEvent,
  type RunOutcome,
  type SeclaiHandlersOptions,
} from "../src";
import { createRunObserver } from "../src/run-callbacks";
import { KEEPALIVE_INTERVAL_MS, relayRunEvents } from "../src/sse";

const client = vi.hoisted(() => ({
  getAgentAttachmentReferences: vi.fn(),
  uploadAgentInput: vi.fn(),
  runStreamingAgent: vi.fn(),
  downloadAgentRunAttachment: vi.fn(),
}));
const constructed = vi.hoisted(() => vi.fn());

vi.mock("@seclai/sdk", async (importActual) => {
  const actual = await importActual<typeof import("@seclai/sdk")>();
  return {
    ...actual,
    Seclai: class {
      getAgentAttachmentReferences = client.getAgentAttachmentReferences;
      uploadAgentInput = client.uploadAgentInput;
      runStreamingAgent = client.runStreamingAgent;
      downloadAgentRunAttachment = client.downloadAgentRunAttachment;
      constructor(options: unknown) {
        constructed(options);
      }
    },
  };
});

const AGENT = "agent-1";
const RUN = "3f2b8c1e-7a4d-4e9b-9c11-0d5e6f7a8b9c";
const URL_BASE = "https://app.test/api/seclai";

const handlers = () => createSeclaiHandlers({ apiKey: "secret-key", agentId: AGENT });

function statusError(statusCode: number, responseText = "") {
  return new SeclaiAPIStatusError({
    message: `Request failed with status ${statusCode}`,
    statusCode,
    method: "POST",
    url: "https://api.test",
    responseText,
  });
}

function runRequest(body: unknown, init?: RequestInit) {
  return new Request(`${URL_BASE}/run`, {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...init,
  });
}

async function* eventsOf(...events: AgentRunEvent[]) {
  yield* events;
}

beforeEach(() => vi.clearAllMocks());

describe("createSeclaiHandlers", () => {
  it("pins a dated API version at or above the minimum by default", () => {
    handlers();
    expect(constructed.mock.calls[0]![0]).toMatchObject({
      apiKey: "secret-key",
      apiVersion: "2026-10-28",
    });
  });

  it("accepts a newer API version", () => {
    createSeclaiHandlers({ apiKey: "k", agentId: AGENT, apiVersion: "2026-10-21" });
    expect(constructed.mock.calls[0]![0]).toMatchObject({ apiVersion: "2026-10-21" });
  });

  it("rejects an API version below the minimum", () => {
    expect(() =>
      createSeclaiHandlers({ apiKey: "k", agentId: AGENT, apiVersion: "2026-10-13" }),
    ).toThrow(/2026-10-16/);
  });

  it("requires an api key and agent id", () => {
    expect(() => createSeclaiHandlers({ apiKey: "", agentId: AGENT })).toThrow(/apiKey/);
    expect(() => createSeclaiHandlers({ apiKey: "k", agentId: "" })).toThrow(/agentId/);
  });

  it("calls the global fetch through a wrapper, keeping `this` valid on Workers", async () => {
    const original = globalThis.fetch;
    const fetchMock = vi.fn(async () => new Response());
    globalThis.fetch = fetchMock as typeof fetch;
    try {
      handlers();
      const { fetch: wrapped } = constructed.mock.calls[0]![0] as { fetch: typeof fetch };
      expect(wrapped).not.toBe(fetchMock);
      await wrapped.call({}, "https://api.test");
      expect(fetchMock).toHaveBeenCalledWith("https://api.test", undefined);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("attachmentReferences", () => {
  it("returns the agent's references", async () => {
    const refs = { requires_uploads: true, accepted_attachments: [{ name: "photo", min: 1 }] };
    client.getAgentAttachmentReferences.mockResolvedValue(refs);

    const res = await handlers().attachmentReferences(new Request(`${URL_BASE}/refs`));

    expect(client.getAgentAttachmentReferences).toHaveBeenCalledWith(AGENT);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(refs);
  });

  it("rejects other methods", async () => {
    const res = await handlers().attachmentReferences(
      new Request(`${URL_BASE}/refs`, { method: "POST" }),
    );
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET");
  });
});

describe("error mapping", () => {
  const refs = () => handlers().attachmentReferences(new Request(`${URL_BASE}/refs`));

  it("passes through a 4xx with the API's message", async () => {
    client.getAgentAttachmentReferences.mockRejectedValue(
      statusError(404, JSON.stringify({ detail: "Agent not found" })),
    );
    const res = await refs();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Agent not found", status: 404 });
  });

  it("reads the nested error message on a 402", async () => {
    client.getAgentAttachmentReferences.mockRejectedValue(
      statusError(402, JSON.stringify({ error: { code: "x", message: "Out of credits" } })),
    );
    const res = await refs();
    expect(res.status).toBe(402);
    expect((await res.json()).error).toBe("Out of credits");
  });

  it("does not relay a non-JSON error body", async () => {
    client.getAgentAttachmentReferences.mockRejectedValue(statusError(400, "<html>nope</html>"));
    const body = await (await refs()).json();
    expect(JSON.stringify(body)).not.toContain("html");
  });

  it.each([401, 403, 500, 503])("reports upstream %i as a 502", async (code) => {
    client.getAgentAttachmentReferences.mockRejectedValue(statusError(code));
    expect((await refs()).status).toBe(502);
  });

  it("reports network failures as a 502 without leaking the key", async () => {
    client.getAgentAttachmentReferences.mockRejectedValue(new Error("secret-key exploded"));
    const res = await refs();
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain("secret-key");
  });
});

describe("upload", () => {
  const uploadRequest = (form: FormData) =>
    new Request(`${URL_BASE}/upload`, { method: "POST", body: form });

  it("uploads the file and returns its id", async () => {
    client.uploadAgentInput.mockResolvedValue({
      id: "up-1",
      status: "ready",
      filename: "a.txt",
      content_type: "text/plain",
      file_size: 5,
    });
    const form = new FormData();
    form.set("file", new File(["hello"], "a.txt", { type: "text/plain" }));

    const res = await handlers().upload(uploadRequest(form));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: "up-1",
      status: "ready",
      filename: "a.txt",
      content_type: "text/plain",
      file_size: 5,
    });
    const [agentId, opts] = client.uploadAgentInput.mock.calls[0]!;
    expect(agentId).toBe(AGENT);
    expect(opts.fileName).toBe("a.txt");
    expect(opts.mimeType).toMatch(/^text\/plain/);
    expect(await opts.file.text()).toBe("hello");
  });

  it("rejects a missing or text-only file field", async () => {
    const form = new FormData();
    form.set("file", "not a file");
    expect((await handlers().upload(uploadRequest(form))).status).toBe(400);
    expect((await handlers().upload(uploadRequest(new FormData()))).status).toBe(400);
    expect(client.uploadAgentInput).not.toHaveBeenCalled();
  });

  it("rejects a body that is not form data", async () => {
    const res = await handlers().upload(
      new Request(`${URL_BASE}/upload`, { method: "POST", body: "{}" }),
    );
    expect(res.status).toBe(400);
  });
});

describe("run", () => {
  it("sends input and upload ids together, with the session id in metadata", async () => {
    client.runStreamingAgent.mockReturnValue(eventsOf({ event: "done", data: {} }));

    await handlers().run(runRequest({ input: "hi", uploadIds: ["a", "b"], sessionId: "s1" }));

    const [agentId, body, opts] = client.runStreamingAgent.mock.calls[0]!;
    expect(agentId).toBe(AGENT);
    expect(body).toEqual({
      input: "hi",
      input_upload_ids: ["a", "b"],
      metadata: { session_id: "s1" },
    });
    // Must be well above the SDK's 60s default.
    expect(opts.timeoutMs).toBeGreaterThan(600_000);
  });

  it("omits fields that were not given", async () => {
    client.runStreamingAgent.mockReturnValue(eventsOf({ event: "done", data: {} }));
    await handlers().run(runRequest({ input: "hi", uploadIds: [] }));
    expect(client.runStreamingAgent.mock.calls[0]![1]).toEqual({ input: "hi" });
  });

  it("honours runTimeoutMs", async () => {
    client.runStreamingAgent.mockReturnValue(eventsOf({ event: "done", data: {} }));
    await createSeclaiHandlers({ apiKey: "k", agentId: AGENT, runTimeoutMs: 5 }).run(
      runRequest({ input: "hi" }),
    );
    expect(client.runStreamingAgent.mock.calls[0]![2].timeoutMs).toBe(5);
  });

  it("re-emits every event as SSE in order", async () => {
    client.runStreamingAgent.mockReturnValue(
      eventsOf(
        { event: "init", data: { run_id: RUN } },
        { event: "step_progress", data: { step_id: "s", step_name: "n", message: "started" } },
        { event: "stream_token", data: { token: "line\nbreak" } },
        { event: "done", data: { run_id: RUN, status: "completed", output: "ok" } },
      ),
    );

    const res = await handlers().run(runRequest({ input: "hi" }));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("cache-control")).toContain("no-transform");
    expect(await res.text()).toBe(
      [
        `event: init\ndata: {"run_id":"${RUN}"}\n\n`,
        `event: step_progress\ndata: {"step_id":"s","step_name":"n","message":"started"}\n\n`,
        `event: stream_token\ndata: {"token":"line\\nbreak"}\n\n`,
        `event: done\ndata: {"run_id":"${RUN}","status":"completed","output":"ok"}\n\n`,
      ].join(""),
    );
  });

  it("returns a real HTTP error when the run is rejected up front", async () => {
    client.runStreamingAgent.mockImplementation(async function* () {
      throw statusError(400, JSON.stringify({ detail: "photo needs at least 1 file" }));
    });

    const res = await handlers().run(runRequest({ input: "hi" }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "photo needs at least 1 file", status: 400 });
  });

  it("sends an error frame when the stream fails midway", async () => {
    client.runStreamingAgent.mockImplementation(async function* () {
      yield { event: "init", data: { run_id: RUN } };
      throw new SeclaiStreamingError("Timed out");
    });

    const res = await handlers().run(runRequest({ input: "hi" }));

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("event: init");
    expect(text).toContain("event: error\ndata: ");
    expect(text).toContain("Timed out waiting");
  });

  it("closes cleanly when the upstream sends nothing", async () => {
    client.runStreamingAgent.mockReturnValue(eventsOf());
    const res = await handlers().run(runRequest({ input: "hi" }));
    expect(await res.text()).toBe("");
  });

  it.each([
    ["not JSON", "{nope"],
    ["an array", []],
    ["neither input nor uploads", {}],
    ["empty input and uploads", { input: "", uploadIds: [] }],
    ["a non-string input", { input: 1 }],
    ["non-string upload ids", { input: "x", uploadIds: [1] }],
    ["an empty session id", { input: "x", sessionId: "" }],
  ])("rejects %s", async (_label, body) => {
    const res = await handlers().run(runRequest(body));
    expect(res.status).toBe(400);
    expect(client.runStreamingAgent).not.toHaveBeenCalled();
  });

  it("rejects other methods", async () => {
    const res = await handlers().run(new Request(`${URL_BASE}/run`));
    expect(res.status).toBe(405);
  });

  describe("with an open stream", () => {
    afterEach(() => vi.useRealTimers());

    /** A run that yields `init`, then stays silent until its signal aborts. */
    function hangingRun() {
      client.runStreamingAgent.mockImplementation(async function* (
        _agentId: string,
        _body: unknown,
        opts: { signal: AbortSignal },
      ) {
        yield { event: "init", data: { run_id: RUN } };
        await new Promise((_resolve, reject) => {
          opts.signal.addEventListener("abort", () => reject(new Error("aborted")));
        });
      });
    }

    it("aborts upstream when the browser cancels the stream", async () => {
      hangingRun();
      const res = await handlers().run(runRequest({ input: "hi" }));
      const { signal } = client.runStreamingAgent.mock.calls[0]![2];

      expect(signal.aborted).toBe(false);
      await res.body!.cancel();
      expect(signal.aborted).toBe(true);
    });

    it("aborts upstream when the request's signal fires", async () => {
      hangingRun();
      const browser = new AbortController();
      const res = await handlers().run(runRequest({ input: "hi" }, { signal: browser.signal }));
      const { signal } = client.runStreamingAgent.mock.calls[0]![2];

      browser.abort();
      expect(signal.aborted).toBe(true);
      await res.body!.cancel();
    });

    it("sends keepalives while the run is silent, and stops after cancel", async () => {
      vi.useFakeTimers();
      hangingRun();
      const res = await handlers().run(runRequest({ input: "hi" }));
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();

      expect(decoder.decode((await reader.read()).value)).toContain("event: init");

      vi.advanceTimersByTime(KEEPALIVE_INTERVAL_MS);
      expect(decoder.decode((await reader.read()).value)).toBe(": keepalive\n\n");

      await reader.cancel();
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});

describe("run callbacks", () => {
  afterEach(() => vi.restoreAllMocks());

  const DONE = {
    event: "done",
    data: {
      run_id: RUN,
      status: "completed",
      output: "Hello there",
      attachments: [
        { id: "att-1", name: "a.png", mime: "image/png", bytes: 3, download_url: "x" },
        { id: "att-2", mime: 7 },
        { nope: true },
      ],
    },
  };

  function withCallbacks(callbacks: Pick<SeclaiHandlersOptions, "onEvent" | "onRunEnd">) {
    return createSeclaiHandlers({ apiKey: "k", agentId: AGENT, ...callbacks });
  }

  /** Run with an `onRunEnd` that records each outcome. */
  async function runRecording(
    events: (
      agentId: string,
      body: unknown,
      opts: { signal: AbortSignal },
    ) => AsyncGenerator<AgentRunEvent, void, undefined>,
    extra: Pick<SeclaiHandlersOptions, "onEvent"> = {},
  ) {
    const outcomes: RunOutcome[] = [];
    client.runStreamingAgent.mockImplementation(events);
    const res = await withCallbacks({ ...extra, onRunEnd: (o) => void outcomes.push(o) }).run(
      runRequest({ input: "hi" }),
    );
    return { res, outcomes };
  }

  /** The event names in an SSE body, in order. */
  const eventNames = (text: string) => [...text.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);

  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
  }

  /** Whether `promise` settles within a few macrotasks. */
  async function settles(promise: Promise<unknown>) {
    let settled = false;
    void promise.then(() => (settled = true));
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    return settled;
  }

  /** Yields `init`, then waits for its signal to abort. */
  function hanging() {
    return async function* (_agentId: string, _body: unknown, opts: { signal: AbortSignal }) {
      yield { event: "init", data: { run_id: RUN } };
      yield { event: "stream_token", data: { token: "par" } };
      yield { event: "stream_token", data: { token: "tial" } };
      await new Promise((_resolve, reject) => {
        if (opts.signal.aborted) reject(new Error("aborted"));
        opts.signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    };
  }

  it("calls onEvent for each event in order, with the request and its body", async () => {
    const seen: [RunEvent, RunCallbackContext][] = [];
    client.runStreamingAgent.mockReturnValue(
      eventsOf(
        { event: "init", data: { run_id: RUN } },
        { event: "stream_token", data: { token: "Hi" } },
        DONE,
      ),
    );
    const req = runRequest({ input: "hi", sessionId: "s1" });

    const res = await withCallbacks({ onEvent: (e, ctx) => void seen.push([e, ctx]) }).run(req);
    await res.text();

    expect(seen.map(([e]) => e.event)).toEqual(["init", "stream_token", "done"]);
    expect(seen[1]![0]).toEqual({ event: "stream_token", data: { token: "Hi" } });
    expect(seen[0]![1]).toEqual({ body: { input: "hi", sessionId: "s1" }, request: req });
  });

  it("relays an event only once onEvent has resolved for it", async () => {
    const gate = deferred();
    client.runStreamingAgent.mockReturnValue(eventsOf({ event: "init", data: { run_id: RUN } }, DONE));
    const res = await withCallbacks({
      onEvent: (e) => (e.event === "init" ? gate.promise : undefined),
    }).run(runRequest({ input: "hi" }));

    const read = res.body!.getReader().read();
    expect(await settles(read)).toBe(false);
    gate.resolve();
    expect(new TextDecoder().decode((await read).value)).toContain("event: init");
  });

  it("reports a completed run once, with its output and normalized attachments", async () => {
    const { res, outcomes } = await runRecording(() =>
      eventsOf(
        { event: "init", data: { run_id: RUN } },
        { event: "stream_token", data: { token: "Hello " } },
        DONE,
      ),
    );

    expect(eventNames(await res.text())).toEqual(["init", "stream_token", "done"]);
    expect(outcomes).toEqual([
      {
        runId: RUN,
        status: "completed",
        output: "Hello there",
        attachments: [
          { id: "att-1", name: "a.png", mime: "image/png" },
          { id: "att-2", name: null, mime: "application/octet-stream" },
        ],
        error: null,
      },
    ]);
  });

  it("falls back to the streamed text when `done` has no output", async () => {
    const { res, outcomes } = await runRecording(() =>
      eventsOf(
        { event: "stream_token", data: { token: "streamed" } },
        { event: "done", data: { run_id: RUN, status: "completed", output: "" } },
      ),
    );
    await res.text();
    // No `init`, so the run id comes from `done`.
    expect(outcomes).toEqual([
      { runId: RUN, status: "completed", output: "streamed", attachments: [], error: null },
    ]);
  });

  it("reports a failed run with the last attempt's error and the streamed text", async () => {
    const { res, outcomes } = await runRecording(() =>
      eventsOf(
        { event: "init", data: { run_id: RUN } },
        { event: "stream_token", data: { token: "so far" } },
        {
          event: "done",
          data: {
            status: "failed",
            output: "invalid",
            attempts: [{ error: "first" }, { error: "Blocked by policy" }, { error: null }],
          },
        },
      ),
    );
    expect(eventNames(await res.text())).toEqual(["init", "stream_token", "done"]);
    expect(outcomes).toEqual([
      { runId: RUN, status: "failed", output: "so far", attachments: [], error: "Blocked by policy" },
    ]);
  });

  it("reports an error event once, even when the stream then ends", async () => {
    const { res, outcomes } = await runRecording(() =>
      eventsOf(
        { event: "init", data: { run_id: RUN } },
        { event: "stream_token", data: { token: "partial" } },
        { event: "error", data: { error: "Model unavailable" } },
      ),
    );
    expect(eventNames(await res.text())).toEqual(["init", "stream_token", "error"]);
    expect(outcomes).toEqual([
      { runId: RUN, status: "failed", output: "partial", attachments: [], error: "Model unavailable" },
    ]);
  });

  it("reports a timeout event as a failure", async () => {
    const { res, outcomes } = await runRecording(() =>
      eventsOf({ event: "init", data: { run_id: RUN } }, { event: "timeout", data: {} }),
    );
    expect(eventNames(await res.text())).toEqual(["init", "timeout"]);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ runId: RUN, status: "failed", error: expect.stringMatching(/waiting/) });
  });

  it("reports an upstream failure, and passes its error frame to onEvent", async () => {
    const onEvent = vi.fn();
    const { res, outcomes } = await runRecording(
      async function* () {
        yield { event: "init", data: { run_id: RUN } };
        throw new SeclaiStreamingError("Timed out");
      },
      { onEvent },
    );

    expect(eventNames(await res.text())).toEqual(["init", "error"]);
    expect(onEvent.mock.calls.map(([e]) => e.event)).toEqual(["init", "error"]);
    expect(outcomes).toEqual([
      {
        runId: RUN,
        status: "failed",
        output: "",
        attachments: [],
        error: "Timed out waiting for the agent run to finish.",
      },
    ]);
  });

  it("reports a failure when the stream ends without a result", async () => {
    const { res, outcomes } = await runRecording(() =>
      eventsOf({ event: "init", data: { run_id: RUN } }, { event: "stream_token", data: { token: "x" } }),
    );
    expect(eventNames(await res.text())).toEqual(["init", "stream_token"]);
    expect(outcomes).toEqual([
      { runId: RUN, status: "failed", output: "x", attachments: [], error: "The stream ended without a result." },
    ]);
  });

  it("reports a failure when the upstream sends nothing", async () => {
    const { res, outcomes } = await runRecording(() => eventsOf());
    expect(await res.text()).toBe("");
    expect(outcomes).toEqual([
      { runId: null, status: "failed", output: "", attachments: [], error: "The stream ended without a result." },
    ]);
  });

  it("reports `cancelled` once when the browser cancels, and still closes the upstream", async () => {
    const { res, outcomes } = await runRecording(hanging());
    const { signal } = client.runStreamingAgent.mock.calls[0]![2];
    const reader = res.body!.getReader();
    await reader.read();
    await reader.read();
    await reader.read();

    await reader.cancel();

    expect(signal.aborted).toBe(true);
    expect(outcomes).toEqual([
      { runId: RUN, status: "cancelled", output: "partial", attachments: [], error: null },
    ]);
  });

  it("reports `cancelled` when the request's signal aborts the upstream first", async () => {
    const browser = new AbortController();
    const outcomes: RunOutcome[] = [];
    client.runStreamingAgent.mockImplementation(hanging());
    const res = await withCallbacks({ onRunEnd: (o) => void outcomes.push(o) }).run(
      runRequest({ input: "hi" }, { signal: browser.signal }),
    );
    const reader = res.body!.getReader();
    for (let i = 0; i < 3; i++) await reader.read();

    const pending = reader.read();
    browser.abort();
    expect(new TextDecoder().decode((await pending).value)).toContain("event: error");
    await reader.cancel();

    expect(outcomes).toEqual([
      { runId: RUN, status: "cancelled", output: "partial", attachments: [], error: null },
    ]);
  });

  it("does not report again when the browser cancels after the run ended", async () => {
    const { res, outcomes } = await runRecording(async function* () {
      yield DONE;
      await new Promise(() => {});
    });
    const reader = res.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("event: done");
    await reader.cancel();
    expect(outcomes.map((o) => o.status)).toEqual(["completed"]);
  });

  it("reports a cancel only once an onEvent still running has resolved, with its token", async () => {
    const gate = deferred();
    const entered = deferred();
    const order: string[] = [];
    const { res, outcomes } = await runRecording(hanging(), {
      onEvent: async (e) => {
        if (e.event !== "stream_token") return;
        entered.resolve();
        await gate.promise;
        order.push(`onEvent ${(e.data as { token: string }).token}`);
      },
    });
    const reader = res.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("event: init");
    void reader.read().catch(() => {});
    await entered.promise;

    const cancel = reader.cancel().then(() => order.push("cancel resolved"));
    expect(await settles(cancel)).toBe(false);
    expect(outcomes).toEqual([]);

    gate.resolve();
    await cancel;
    expect(order).toEqual(["onEvent par", "cancel resolved"]);
    expect(outcomes).toEqual([
      { runId: RUN, status: "cancelled", output: "par", attachments: [], error: null },
    ]);
  });

  it("keeps the run id of an `init` whose onEvent was still running at cancel", async () => {
    const gate = deferred();
    let onEventDone = false;
    const outcomes: [RunOutcome, boolean][] = [];
    client.runStreamingAgent.mockImplementation(hanging());
    const res = await withCallbacks({
      onEvent: async () => {
        await gate.promise;
        onEventDone = true;
      },
      onRunEnd: (o) => void outcomes.push([o, onEventDone]),
    }).run(runRequest({ input: "hi" }));
    const { signal } = client.runStreamingAgent.mock.calls[0]![2];

    const cancel = res.body!.cancel();
    expect(await settles(cancel)).toBe(false);
    expect(signal.aborted).toBe(true);
    gate.resolve();
    await cancel;

    // onRunEnd ran after onEvent had resolved.
    expect(outcomes).toEqual([
      [{ runId: RUN, status: "cancelled", output: "", attachments: [], error: null }, true],
    ]);
  });

  it("takes the run id from an `init` that was never relayed when cancelled before the first pull", async () => {
    const outcomes: RunOutcome[] = [];
    const onEvent = vi.fn();
    const abort = vi.fn();
    const stream = relayRunEvents(
      { event: "init", data: { run_id: RUN } },
      eventsOf(),
      abort,
      createRunObserver(
        { onEvent, onRunEnd: (o) => void outcomes.push(o) },
        { body: { input: "hi" }, request: runRequest({ input: "hi" }) },
      ),
    );

    // Synchronously, so `pull` never runs.
    await stream.cancel();

    expect(abort).toHaveBeenCalled();
    expect(onEvent).not.toHaveBeenCalled();
    expect(outcomes).toEqual([
      { runId: RUN, status: "cancelled", output: "", attachments: [], error: null },
    ]);
  });

  /** Yields `init`, waits for its signal to abort, then yields `after`, if given. */
  function untilAborted(after?: AgentRunEvent) {
    return async function* (_agentId: string, _body: unknown, opts: { signal: AbortSignal }) {
      yield { event: "init", data: { run_id: RUN } };
      await new Promise<void>((resolve) => {
        if (opts.signal.aborted) resolve();
        opts.signal.addEventListener("abort", () => resolve());
      });
      if (after) yield after;
    };
  }

  /** Run `events`, abort the request's signal while it waits, and return what follows. */
  async function abortMidway(
    events: ReturnType<typeof untilAborted>,
  ): Promise<{ rest: string; outcomes: RunOutcome[] }> {
    const browser = new AbortController();
    const outcomes: RunOutcome[] = [];
    client.runStreamingAgent.mockImplementation(events);
    const res = await withCallbacks({ onRunEnd: (o) => void outcomes.push(o) }).run(
      runRequest({ input: "hi" }, { signal: browser.signal }),
    );
    const reader = res.body!.getReader();
    await reader.read();
    const decoder = new TextDecoder();
    let rest = "";
    const drained = (async () => {
      for (let r = await reader.read(); !r.done; r = await reader.read()) rest += decoder.decode(r.value);
    })();
    browser.abort();
    await drained;
    return { rest, outcomes };
  }

  it.each([
    [{ event: "error", data: { error: "Model unavailable" } }, "Model unavailable"],
    [{ event: "timeout", data: {} }, expect.stringMatching(/waiting/)],
  ])("reports an API %o after the request's signal aborted as `failed`", async (event, error) => {
    const { rest, outcomes } = await abortMidway(untilAborted(event));
    expect(eventNames(rest)).toEqual([event.event]);
    expect(outcomes).toEqual([
      { runId: RUN, status: "failed", output: "", attachments: [], error },
    ]);
  });

  it("reports `cancelled` when the upstream ends quietly after the request's signal aborted", async () => {
    const { rest, outcomes } = await abortMidway(untilAborted());
    expect(rest).toBe("");
    expect(outcomes).toEqual([
      { runId: RUN, status: "cancelled", output: "", attachments: [], error: null },
    ]);
  });

  it("finishes onRunEnd before `done` is readable", async () => {
    const gate = deferred();
    const order: string[] = [];
    client.runStreamingAgent.mockReturnValue(eventsOf(DONE));
    const res = await withCallbacks({
      onRunEnd: async () => {
        await gate.promise;
        order.push("onRunEnd resolved");
      },
    }).run(runRequest({ input: "hi" }));

    const read = res.body!.getReader().read().then((r) => {
      order.push("done read");
      return r;
    });
    expect(await settles(read)).toBe(false);
    gate.resolve();
    expect(new TextDecoder().decode((await read).value)).toContain("event: done");
    expect(order).toEqual(["onRunEnd resolved", "done read"]);
  });

  it("calls onEvent for `done` before onRunEnd, with the same context", async () => {
    const calls: [string, RunCallbackContext][] = [];
    client.runStreamingAgent.mockReturnValue(eventsOf(DONE));
    const res = await withCallbacks({
      onEvent: (e, ctx) => void calls.push([`onEvent ${e.event}`, ctx]),
      onRunEnd: (_o, ctx) => void calls.push(["onRunEnd", ctx]),
    }).run(runRequest({ input: "hi" }));
    await res.text();

    expect(calls.map(([name]) => name)).toEqual(["onEvent done", "onRunEnd"]);
    expect(calls[0]![1]).toBe(calls[1]![1]);
  });

  describe("when a callback throws", () => {
    const quiet = () => vi.spyOn(console, "error").mockImplementation(() => {});
    const errorFrame = 'event: error\ndata: {"error":"The server could not process the run."}\n\n';

    it("ends the stream with an error event in place of the event, and reports the failure once", async () => {
      const log = quiet();
      const { res, outcomes } = await runRecording(hanging(), {
        onEvent: (e) => {
          if (e.event === "stream_token") throw new Error("db down");
        },
      });
      const { signal } = client.runStreamingAgent.mock.calls[0]![2];

      const text = await res.text();

      expect(text).toBe(`event: init\ndata: {"run_id":"${RUN}"}\n\n${errorFrame}`);
      expect(signal.aborted).toBe(true);
      // The token was read from the API, so it counts as streamed, though the
      // browser never got it.
      expect(outcomes).toEqual([
        {
          runId: RUN,
          status: "failed",
          output: "par",
          attachments: [],
          error: "The server could not process the run.",
        },
      ]);
      expect(log).toHaveBeenCalledWith(expect.any(String), new Error("db down"));
    });

    it("sends an error event instead of `done` when onRunEnd rejects, without calling it again", async () => {
      quiet();
      const onRunEnd = vi.fn(async () => {
        throw new Error("write failed");
      });
      client.runStreamingAgent.mockReturnValue(eventsOf({ event: "init", data: { run_id: RUN } }, DONE));

      const res = await withCallbacks({ onRunEnd }).run(runRequest({ input: "hi" }));

      expect(eventNames(await res.text())).toEqual(["init", "error"]);
      expect(onRunEnd).toHaveBeenCalledTimes(1);
    });

    it("sends an error event when onRunEnd throws at the end of the stream", async () => {
      quiet();
      const onRunEnd = vi.fn(() => {
        throw new Error("write failed");
      });
      client.runStreamingAgent.mockReturnValue(eventsOf({ event: "init", data: { run_id: RUN } }));

      const res = await withCallbacks({ onRunEnd }).run(runRequest({ input: "hi" }));

      expect(await res.text()).toBe(`event: init\ndata: {"run_id":"${RUN}"}\n\n${errorFrame}`);
      expect(onRunEnd).toHaveBeenCalledTimes(1);
    });

    it("still resolves a cancel when onRunEnd throws", async () => {
      const log = quiet();
      const onRunEnd = vi.fn(async () => {
        throw new Error("write failed");
      });
      client.runStreamingAgent.mockImplementation(hanging());
      const res = await withCallbacks({ onRunEnd }).run(runRequest({ input: "hi" }));
      const reader = res.body!.getReader();
      await reader.read();

      await expect(reader.cancel()).resolves.toBeUndefined();
      expect(onRunEnd).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledTimes(1);
    });
  });
});

describe("keepReadingAfterDisconnect", () => {
  afterEach(() => vi.restoreAllMocks());

  /** An upstream whose events arrive when the test says, and which honours the abort signal. */
  function upstream() {
    const queue: AgentRunEvent[] = [];
    let wake: (() => void) | undefined;
    let ended = false;
    let failure: unknown;
    let signal: AbortSignal | undefined;
    const reads: string[] = [];
    async function* gen(): AsyncGenerator<AgentRunEvent, void, undefined> {
      for (;;) {
        if (queue.length) {
          const e = queue.shift()!;
          reads.push(e.event);
          yield e;
          continue;
        }
        if (failure) throw failure;
        if (ended) return;
        await new Promise<void>((resolve, reject) => {
          wake = resolve;
          if (signal?.aborted) reject(new Error("aborted"));
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }
    }
    const ch = {
      reads,
      get signal() {
        return signal!;
      },
      events(_agent: string, _body: unknown, opts: { signal: AbortSignal }) {
        signal = opts.signal;
        return gen();
      },
      push(...events: AgentRunEvent[]) {
        queue.push(...events);
        wake?.();
      },
      end() {
        ended = true;
        wake?.();
      },
      fail(err: unknown) {
        failure = err;
        wake?.();
      },
    };
    return ch;
  }

  const INIT = { event: "init", data: { run_id: RUN } };
  const TOKEN = { event: "stream_token", data: { token: "Hi" } };
  const DONE = {
    event: "done",
    data: { run_id: RUN, status: "completed", output: "Hi there", attachments: [{ id: "a1", name: "x.png", mime: "image/png" }] },
  };

  function setup(opts: Partial<SeclaiHandlersOptions> = {}) {
    const up = upstream();
    client.runStreamingAgent.mockImplementation(up.events);
    const outcomes: RunOutcome[] = [];
    const seen: string[] = [];
    const seclai = createSeclaiHandlers({
      apiKey: "k",
      agentId: AGENT,
      keepReadingAfterDisconnect: true,
      onEvent: (e) => void seen.push(e.event),
      onRunEnd: (o) => void outcomes.push(o),
      ...opts,
    });
    return { up, outcomes, seen, seclai };
  }

  it("keeps reading after the browser cancels, and reports the real outcome", async () => {
    const { up, outcomes, seen, seclai } = setup();
    up.push(INIT);
    const res = await seclai.run(runRequest({ input: "hi" }));
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();

    expect(up.signal.aborted).toBe(false);
    up.push(TOKEN, DONE);
    up.end();

    await vi.waitFor(() => expect(outcomes).toHaveLength(1));
    expect(outcomes[0]).toEqual({
      runId: RUN,
      status: "completed",
      output: "Hi there",
      attachments: [{ id: "a1", name: "x.png", mime: "image/png" }],
      error: null,
    });
    expect(seen).toEqual(["init", "stream_token", "done"]);
  });

  it("reads a response that is never read, once the request aborts", async () => {
    const { up, outcomes, seen, seclai } = setup();
    up.push(INIT);
    const browser = new AbortController();
    // The framework drops this response unread, as React Router does after an abort.
    await seclai.run(runRequest({ input: "hi" }, { signal: browser.signal }));
    browser.abort();
    up.push(TOKEN, DONE);
    up.end();

    await vi.waitFor(() => expect(outcomes).toHaveLength(1));
    expect(outcomes[0]!.status).toBe("completed");
    // The buffered first event reaches onEvent too: the browser never got it.
    expect(seen).toEqual(["init", "stream_token", "done"]);
  });

  it("reads and handles events in order when the browser cancels during a pending read", async () => {
    const seen: string[] = [];
    let active = 0;
    let overlapped = false;
    const { up, outcomes, seclai } = setup({
      async onEvent(e) {
        active += 1;
        if (active > 1) overlapped = true;
        const token = (e.data as { token?: string }).token;
        // The first token's handler is slow: a second reader would get ahead of it.
        if (token === "A") await new Promise((r) => setTimeout(r, 30));
        seen.push(token ?? e.event);
        active -= 1;
      },
    });
    up.push(INIT);
    const res = await seclai.run(runRequest({ input: "hi" }));
    const reader = res.body!.getReader();
    await reader.read();
    const pendingRead = reader.read(); // the pull is now waiting on the upstream
    await new Promise((r) => setTimeout(r, 0));
    void reader.cancel();
    void pendingRead.catch(() => {});

    up.push(
      { event: "stream_token", data: { token: "A" } },
      { event: "stream_token", data: { token: "B" } },
      DONE,
    );
    up.end();

    await vi.waitFor(() => expect(outcomes).toHaveLength(1));
    expect(seen).toEqual(["init", "A", "B", "done"]);
    expect(overlapped).toBe(false);
    expect(up.reads).toEqual(["init", "stream_token", "stream_token", "done"]);
  });

  it("reports a lost connection after the browser left as failed, not cancelled", async () => {
    const { up, outcomes, seclai } = setup();
    up.push(INIT);
    const res = await seclai.run(runRequest({ input: "hi" }));
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    up.push(TOKEN);
    up.fail(new Error("socket reset"));

    await vi.waitFor(() => expect(outcomes).toHaveLength(1));
    expect(outcomes[0]).toMatchObject({ status: "failed", output: "Hi", runId: RUN });
  });

  it("reports a quiet end after the browser left as failed", async () => {
    const { up, outcomes, seclai } = setup();
    up.push(INIT);
    const res = await seclai.run(runRequest({ input: "hi" }));
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    up.end();

    await vi.waitFor(() => expect(outcomes).toHaveLength(1));
    expect(outcomes[0]).toMatchObject({ status: "failed", error: "The stream ended without a result." });
  });

  it("stops the upstream and reports failed once when a callback throws in the background", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { up, outcomes, seclai } = setup({
      onEvent: (e) => {
        if (e.event === "stream_token") throw new Error("db down");
      },
    });
    up.push(INIT);
    const res = await seclai.run(runRequest({ input: "hi" }));
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    up.push(TOKEN);

    await vi.waitFor(() => expect(outcomes).toHaveLength(1));
    expect(outcomes[0]!.status).toBe("failed");
    expect(up.signal.aborted).toBe(true);
    up.push(DONE);
    await new Promise((r) => setTimeout(r, 10));
    expect(outcomes).toHaveLength(1);
  });

  it("reports once when the request aborts after the run finished normally", async () => {
    const { up, outcomes, seclai } = setup();
    up.push(INIT, DONE);
    up.end();
    const browser = new AbortController();
    const res = await seclai.run(runRequest({ input: "hi" }, { signal: browser.signal }));
    await res.text();
    browser.abort();
    await new Promise((r) => setTimeout(r, 10));
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.status).toBe("completed");
  });

  it("doesn't send keepalives after the browser left", async () => {
    vi.useFakeTimers();
    try {
      const { up, seclai } = setup();
      up.push(INIT);
      const res = await seclai.run(runRequest({ input: "hi" }));
      const reader = res.body!.getReader();
      await reader.read();
      await reader.cancel();
      // An enqueue on the cancelled stream would throw from the timer.
      expect(() => vi.advanceTimersByTime(KEEPALIVE_INTERVAL_MS * 3)).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes the stream when the signal starts the background reading, so a waiting read settles", async () => {
    const { up, outcomes, seclai } = setup();
    up.push(INIT);
    const browser = new AbortController();
    const res = await seclai.run(runRequest({ input: "hi" }, { signal: browser.signal }));
    const reader = res.body!.getReader();
    await reader.read();
    const waiting = reader.read(); // the adapter's write loop, waiting on the upstream
    browser.abort();

    await expect(waiting).resolves.toEqual({ done: true, value: undefined });
    up.push(TOKEN, DONE);
    up.end();
    await vi.waitFor(() => expect(outcomes).toHaveLength(1));
    expect(outcomes[0]!.status).toBe("completed");
  });

  it("tells the observer once when it starts reading in the background", async () => {
    const onDisconnect = vi.fn();
    const ch = upstream();
    const events = ch.events("a", {}, { signal: new AbortController().signal });
    ch.push(INIT);
    const first = (await events.next()).value as AgentRunEvent;
    const browser = new AbortController();
    const stream = relayRunEvents(
      first,
      events,
      () => {},
      { onEvent() {}, onClose() {}, onError() {}, onDisconnect },
      { keepReadingAfterDisconnect: true, signal: browser.signal },
    );
    const reader = stream.getReader();
    await reader.read();
    browser.abort();
    await reader.cancel();
    expect(onDisconnect).toHaveBeenCalledOnce();
    ch.end();
  });

  it("does nothing without onEvent or onRunEnd: the upstream stops as before", async () => {
    const up = upstream();
    client.runStreamingAgent.mockImplementation(up.events);
    const seclai = createSeclaiHandlers({ apiKey: "k", agentId: AGENT, keepReadingAfterDisconnect: true });
    up.push(INIT);
    const res = await seclai.run(runRequest({ input: "hi" }));
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    expect(up.signal.aborted).toBe(true);
  });

  it("is off by default: the browser leaving cancels the run's reading", async () => {
    const { up, outcomes, seclai } = setup({ keepReadingAfterDisconnect: undefined });
    up.push(INIT);
    const res = await seclai.run(runRequest({ input: "hi" }));
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    expect(up.signal.aborted).toBe(true);
    await vi.waitFor(() => expect(outcomes).toHaveLength(1));
    expect(outcomes[0]!.status).toBe("cancelled");
  });
});

describe("download", () => {
  const downloadUrl = (params: Record<string, string>) =>
    `${URL_BASE}/download?${new URLSearchParams(params)}`;

  function upstream(contentType: string, headers: Record<string, string> = {}) {
    client.downloadAgentRunAttachment.mockResolvedValue(
      new Response("bytes", { headers: { "content-type": contentType, ...headers } }),
    );
  }

  it("streams the file and passes the download name", async () => {
    upstream("image/png", {
      "content-disposition": 'inline; filename="a.png"',
      "content-length": "5",
    });

    const res = await handlers().download(
      new Request(downloadUrl({ runId: RUN, attachmentId: "abc-123", name: "a.png" })),
    );

    const [runId, attachmentId, opts] = client.downloadAgentRunAttachment.mock.calls[0]!;
    expect([runId, attachmentId, opts.downloadName]).toEqual([RUN, "abc-123", "a.png"]);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("bytes");
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-disposition")).toBe('inline; filename="a.png"');
    expect(res.headers.get("content-length")).toBe("5");
  });

  it("drops the length of a body fetch has already decompressed", async () => {
    upstream("text/plain", { "content-encoding": "gzip", "content-length": "2" });
    const res = await handlers().download(
      new Request(downloadUrl({ runId: RUN, attachmentId: "abc" })),
    );
    expect(res.headers.get("content-length")).toBeNull();
  });

  it("sandboxes files so an SVG can't run script on the deployer's origin", async () => {
    upstream("image/svg+xml");
    const res = await handlers().download(
      new Request(downloadUrl({ runId: RUN, attachmentId: "abc" })),
    );
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("leaves PDFs out of the sandbox so browsers can display them", async () => {
    upstream("application/pdf");
    const res = await handlers().download(
      new Request(downloadUrl({ runId: RUN, attachmentId: "abc" })),
    );
    expect(res.headers.get("content-security-policy")).toBeNull();
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("accepts a base64 storage key as the attachment id", async () => {
    upstream("image/png");
    const res = await handlers().download(
      new Request(downloadUrl({ runId: RUN, attachmentId: "c3RvcmFnZS9rZXk=" })),
    );
    expect(res.status).toBe(200);
  });

  it.each([
    ["a traversal in the run id", { runId: "../../agents", attachmentId: "abc" }],
    ["a missing run id", { attachmentId: "abc" }],
    ["a traversal in the attachment id", { runId: RUN, attachmentId: "../../agents/x" }],
    ["a slash in the attachment id", { runId: RUN, attachmentId: "a/b" }],
    ["a query in the attachment id", { runId: RUN, attachmentId: "a?x=1" }],
    ["a missing attachment id", { runId: RUN }],
    ["an overlong name", { runId: RUN, attachmentId: "abc", name: "x".repeat(256) }],
  ])("rejects %s without calling the API", async (_label, params) => {
    const res = await handlers().download(new Request(downloadUrl(params as Record<string, string>)));
    expect(res.status).toBe(400);
    expect(client.downloadAgentRunAttachment).not.toHaveBeenCalled();
  });

  it("maps a missing file to a 404", async () => {
    client.downloadAgentRunAttachment.mockRejectedValue(statusError(404));
    const res = await handlers().download(
      new Request(downloadUrl({ runId: RUN, attachmentId: "abc" })),
    );
    expect(res.status).toBe(404);
  });
});

describe("handle", () => {
  it("routes by the last path segment", async () => {
    const refs = { requires_uploads: false, accepted_attachments: [] };
    client.getAgentAttachmentReferences.mockResolvedValue(refs);

    const res = await handlers().handle(new Request(`${URL_BASE}/attachment-references`));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(refs);
  });

  it("ignores a trailing slash and the query string", async () => {
    const res = await handlers().handle(new Request(`${URL_BASE}/download/?runId=nope`));
    // Reached the download handler, which rejects the bad run id.
    expect(res.status).toBe(400);
  });

  it("keeps each handler's method check", async () => {
    const res = await handlers().handle(new Request(`${URL_BASE}/run`));
    expect(res.status).toBe(405);
  });

  it.each(["unknown", "handle", "toString", "constructor", ""])(
    "returns 404 for %j",
    async (segment) => {
      const res = await handlers().handle(new Request(`${URL_BASE}/${segment}`));
      expect(res.status).toBe(404);
    },
  );
});

import { SeclaiAPIStatusError, SeclaiStreamingError, type AgentRunEvent } from "@seclai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  consoleLogger,
  createSeclaiHandlers,
  type RunCallbackContext,
  type RunEvent,
  type RunOutcome,
  type SeclaiHandlersOptions,
  type SeclaiLogger,
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

describe("logger", () => {
  type Level = "debug" | "info" | "warn" | "error";
  type Line = [Level, string, Record<string, unknown> | undefined];

  const API_KEY = "sk-test-0123456789abcdef";
  const INPUT = "my very private prompt text";

  /** A logger that records each call. */
  function recorder() {
    const lines: Line[] = [];
    const at = (level: Level) => (message: string, fields?: Record<string, unknown>) =>
      void lines.push([level, message, fields]);
    const logger: SeclaiLogger = {
      debug: at("debug"),
      info: at("info"),
      warn: at("warn"),
      error: at("error"),
    };
    /** `level message` for each line, debug left out. */
    const summary = () => lines.filter(([l]) => l !== "debug").map(([l, m]) => `${l} ${m}`);
    const find = (message: string) => lines.find(([, m]) => m === message);
    return { logger, lines, summary, find };
  }

  function withLogger(logger: SeclaiLogger, extra: Partial<SeclaiHandlersOptions> = {}) {
    return createSeclaiHandlers({ apiKey: API_KEY, agentId: AGENT, logger, ...extra });
  }

  it("with keepReadingAfterDisconnect, logs the background reading and then the run's real end", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    client.runStreamingAgent.mockImplementation(async function* () {
      yield { event: "init", data: { run_id: RUN } };
      await gate;
      yield { event: "stream_token", data: { token: "Hi" } };
      yield { event: "done", data: { run_id: RUN, status: "completed", output: "Hi", attachments: [] } };
    });
    const { logger, summary } = recorder();
    const outcomes: RunOutcome[] = [];
    const seclai = withLogger(logger, {
      keepReadingAfterDisconnect: true,
      onRunEnd: (o) => void outcomes.push(o),
    });
    const res = await seclai.run(runRequest({ input: INPUT }));
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    release();

    await vi.waitFor(() => expect(outcomes).toHaveLength(1));
    expect(outcomes[0]!.status).toBe("completed");
    const lines = summary();
    expect(lines).toContain("info browser left; reading the rest of the run in the background");
    expect(lines).not.toContain("info browser disconnected; the run continues on Seclai");
    expect(lines.at(-1)).toBe("info run done");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const COMPLETED = (attachments: unknown[] = []) => ({
    event: "done",
    data: { run_id: RUN, status: "completed", output: "Hello there", attachments },
  });

  it("logs nothing without a logger", async () => {
    const spies = (["debug", "info", "log", "warn", "error"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    client.runStreamingAgent.mockReturnValue(
      eventsOf(
        { event: "init", data: { run_id: RUN } },
        { event: "stream_token", data: { token: "Hi" } },
        COMPLETED(),
      ),
    );
    await (await handlers().run(runRequest({ input: "hi" }))).text();
    client.runStreamingAgent.mockImplementation(async function* () {
      throw statusError(400);
    });
    await handlers().run(runRequest({ input: "hi" }));

    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it("logs the run lifecycle in order, with ids and counts in fields", async () => {
    const { logger, summary, find } = recorder();
    client.runStreamingAgent.mockReturnValue(
      eventsOf(
        { event: "init", data: { run_id: RUN } },
        { event: "step_progress", data: { step_id: "s1", step_name: "Think", message: "started" } },
        { event: "stream_token", data: { token: "Hello " } },
        { event: "stream_token", data: { token: "there" } },
        { event: "stream_end", data: {} },
        COMPLETED([{ id: "a" }, { id: "b" }]),
      ),
    );

    const res = await withLogger(logger).run(
      runRequest({ input: INPUT, uploadIds: ["u1", "u2"], sessionId: "sess-1" }),
    );
    await res.text();

    expect(summary()).toEqual([
      "info run starting",
      "info stream open",
      "info run started",
      "info step",
      "info first token",
      "info run done",
    ]);
    expect(find("run starting")![2]).toEqual({ session_id: "sess-1", uploads: 2, input_chars: INPUT.length });
    expect(find("stream open")![2]).toMatchObject({ ms: expect.any(Number) });
    expect(find("run started")![2]).toEqual({ run_id: RUN, session_id: "sess-1" });
    expect(find("step")![2]).toMatchObject({ run_id: RUN, step: "Think", message: "started" });
    expect(find("first token")![2]).toMatchObject({ run_id: RUN, ms: expect.any(Number) });
    expect(find("run done")![2]).toEqual({
      run_id: RUN,
      session_id: "sess-1",
      status: "completed",
      attachments: 2,
      tokens: 2,
      output_chars: "Hello there".length,
      ms: expect.any(Number),
    });
  });

  it("logs every event, token and keepalive at debug", async () => {
    vi.useFakeTimers();
    const { logger, lines } = recorder();
    let release!: () => void;
    client.runStreamingAgent.mockImplementation(async function* () {
      yield { event: "init", data: { run_id: RUN } };
      yield { event: "stream_token", data: { token: "Hi" } };
      await new Promise<void>((r) => (release = r));
      yield COMPLETED();
    });
    const res = await withLogger(logger).run(runRequest({ input: "hi" }));
    const reader = res.body!.getReader();
    await reader.read();
    await reader.read();
    const next = reader.read();
    await vi.advanceTimersByTimeAsync(KEEPALIVE_INTERVAL_MS);
    expect(new TextDecoder().decode((await next).value)).toBe(": keepalive\n\n");
    release();
    while (!(await reader.read()).done);

    const debug = lines.filter(([l]) => l === "debug").map(([, m, f]) => `${m} ${f?.event ?? ""}`.trim());
    expect(debug).toEqual(["event init", "token", "keepalive", "event done", "stream closed"]);
    expect(lines.find(([, m]) => m === "token")![2]).toMatchObject({ n: 1, chars: 2 });
  });

  it("logs a step once while it repeats", async () => {
    const { logger, lines } = recorder();
    const step = (name: string, message: string) => ({
      event: "step_progress",
      data: { step_id: name, step_name: name, message },
    });
    client.runStreamingAgent.mockReturnValue(
      eventsOf(
        step("Search", "running"),
        step("Search", "running"),
        step("Search", "done"),
        step("Write", "running"),
        step("Write", "running"),
        step("Search", "running"),
        COMPLETED(),
      ),
    );
    await (await withLogger(logger).run(runRequest({ input: "hi" }))).text();

    const steps = lines.filter(([, m]) => m === "step").map(([, , f]) => `${f!.step}: ${f!.message}`);
    expect(steps).toEqual(["Search: running", "Search: done", "Write: running", "Search: running"]);
  });

  it("logs the first token's latency, then a progress line at most every 5 seconds", async () => {
    vi.useFakeTimers();
    const { logger, lines } = recorder();
    const gates: (() => void)[] = [];
    const token = (t: string) => ({ event: "stream_token", data: { token: t } });
    client.runStreamingAgent.mockImplementation(async function* () {
      yield { event: "init", data: { run_id: RUN } };
      for (const t of ["ab", "cd", "ef", "gh", "ij"]) {
        await new Promise<void>((r) => gates.push(r));
        yield token(t);
      }
      yield COMPLETED();
    });
    const res = await withLogger(logger).run(runRequest({ input: "hi" }));
    const reader = res.body!.getReader();
    await reader.read();

    /** Wait `ms`, then let the next token through. */
    const tokenAfter = async (ms: number) => {
      await vi.advanceTimersByTimeAsync(ms);
      const read = reader.read();
      await vi.advanceTimersByTimeAsync(0);
      gates.shift()!();
      await read;
    };
    await tokenAfter(1_200); // first token
    await tokenAfter(2_000); // 2s after: too soon
    await tokenAfter(3_000); // 5s after the first: progress
    await tokenAfter(1_000); // too soon
    await tokenAfter(5_000); // progress
    while (!(await reader.read()).done);

    const info = lines.filter(([l, m]) => l === "info" && /token|streaming/.test(m));
    expect(info.map(([, m, f]) => [m, f!.ms, f!.tokens, f!.chars])).toEqual([
      ["first token", 1_200, undefined, undefined],
      ["streaming", 6_200, 3, 6],
      ["streaming", 12_200, 5, 10],
    ]);
  });

  it("warns when a completed run streamed no tokens", async () => {
    const { logger, summary, find } = recorder();
    client.runStreamingAgent.mockReturnValue(
      eventsOf({ event: "init", data: { run_id: RUN } }, COMPLETED()),
    );
    await (await withLogger(logger).run(runRequest({ input: "hi" }))).text();

    expect(summary().slice(-2)).toEqual(["info run done", expect.stringMatching(/^warn /)]);
    const [, message] = summary().slice(-1)[0]!.split(/^warn /);
    expect(message).toMatch(/display_result/);
    expect(message).toMatch(/streaming_result/);
    expect(find("run done")![2]).toMatchObject({ tokens: 0, output_chars: 11 });
  });

  it("warns about a failed run, with the last attempt's error", async () => {
    const { logger, summary, find } = recorder();
    client.runStreamingAgent.mockReturnValue(
      eventsOf(
        { event: "init", data: { run_id: RUN } },
        { event: "done", data: { run_id: RUN, status: "failed", attempts: [{ error: "Blocked" }] } },
      ),
    );
    await (await withLogger(logger).run(runRequest({ input: "hi" }))).text();

    expect(summary()).toEqual([
      "info run starting",
      "info stream open",
      "info run started",
      "warn run failed",
    ]);
    expect(find("run failed")![2]).toMatchObject({ run_id: RUN, status: "failed", error: "Blocked" });
  });

  it("warns when the stream ends without a result", async () => {
    const { logger, summary } = recorder();
    client.runStreamingAgent.mockReturnValue(eventsOf({ event: "init", data: { run_id: RUN } }));
    await (await withLogger(logger).run(runRequest({ input: "hi" }))).text();
    expect(summary().at(-1)).toBe("warn stream ended without a result");
  });

  it("logs stream errors and timeouts at error", async () => {
    const { logger, summary, find } = recorder();
    client.runStreamingAgent.mockImplementation(async function* () {
      yield { event: "init", data: { run_id: RUN } };
      throw new SeclaiStreamingError("Timed out");
    });
    await (await withLogger(logger).run(runRequest({ input: "hi" }))).text();
    expect(summary().at(-1)).toBe("error stream error");
    expect(find("stream error")![2]).toMatchObject({
      run_id: RUN,
      error: "Timed out waiting for the agent run to finish.",
    });

    const second = recorder();
    client.runStreamingAgent.mockReturnValue(
      eventsOf({ event: "init", data: { run_id: RUN } }, { event: "timeout", data: {} }),
    );
    await (await withLogger(second.logger).run(runRequest({ input: "hi" }))).text();
    expect(second.summary().at(-1)).toBe("error run timed out");
  });

  it("logs an up-front rejection with the status and the API's message", async () => {
    const { logger, summary, find } = recorder();
    client.runStreamingAgent.mockImplementation(async function* () {
      throw statusError(402, JSON.stringify({ detail: "Out of credits" }));
    });
    const res = await withLogger(logger).run(runRequest({ input: "hi" }));

    expect(res.status).toBe(402);
    expect(summary()).toEqual(["info run starting", "error run rejected"]);
    expect(find("run rejected")![2]).toMatchObject({
      status: 402,
      upstream_status: 402,
      error: "Out of credits",
    });
  });

  it("logs the cause a 502 hides from the browser", async () => {
    const { logger, find } = recorder();
    client.runStreamingAgent.mockImplementation(async function* () {
      throw statusError(401, JSON.stringify({ detail: "Invalid API key" }));
    });
    const res = await withLogger(logger).run(runRequest({ input: "hi" }));
    expect(res.status).toBe(502);
    expect(find("run rejected")![2]).toMatchObject({ status: 502, upstream_status: 401, error: "Invalid API key" });
  });

  it("logs that the browser left and the run continues", async () => {
    const { logger, summary, find } = recorder();
    client.runStreamingAgent.mockImplementation(async function* (
      _agentId: string,
      _body: unknown,
      opts: { signal: AbortSignal },
    ) {
      yield { event: "init", data: { run_id: RUN } };
      yield { event: "stream_token", data: { token: "par" } };
      await new Promise((_resolve, reject) => {
        opts.signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    });
    const res = await withLogger(logger).run(runRequest({ input: "hi" }));
    const reader = res.body!.getReader();
    await reader.read();
    await reader.read();
    await reader.cancel();

    expect(summary().at(-1)).toBe("info browser disconnected; the run continues on Seclai");
    expect(find("browser disconnected; the run continues on Seclai")![2]).toMatchObject({
      run_id: RUN,
      tokens: 1,
    });
    expect(summary().filter((l) => l.startsWith("warn") || l.startsWith("error"))).toEqual([]);
  });

  it("logs a disconnect, not a stream error, when the request's signal aborts first", async () => {
    const { logger, summary } = recorder();
    client.runStreamingAgent.mockImplementation(async function* (
      _agentId: string,
      _body: unknown,
      opts: { signal: AbortSignal },
    ) {
      yield { event: "init", data: { run_id: RUN } };
      await new Promise((_resolve, reject) => {
        if (opts.signal.aborted) reject(new Error("aborted"));
        opts.signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    });
    const browser = new AbortController();
    const res = await withLogger(logger).run(runRequest({ input: "hi" }, { signal: browser.signal }));
    const reader = res.body!.getReader();
    await reader.read();
    const pending = reader.read();
    browser.abort();
    await pending;
    await reader.cancel();

    expect(summary().slice(-1)).toEqual(["info browser disconnected; the run continues on Seclai"]);
    expect(summary().filter((l) => l.includes("browser disconnected"))).toHaveLength(1);
    expect(summary().filter((l) => l.startsWith("error"))).toEqual([]);
  });

  describe("uploads and downloads", () => {
    const upload = (logger: SeclaiLogger) => {
      const form = new FormData();
      form.set("file", new File(["file-contents-xyz"], "a.txt", { type: "text/plain" }));
      return withLogger(logger).upload(
        new Request(`${URL_BASE}/upload`, { method: "POST", body: form }),
      );
    };

    it("logs an upload received and uploaded, without its contents", async () => {
      const { logger, lines } = recorder();
      client.uploadAgentInput.mockResolvedValue({ id: "up-1", status: "ready", filename: "a.txt" });

      expect((await upload(logger)).status).toBe(200);

      expect(lines.map(([l, m]) => `${l} ${m}`)).toEqual(["info upload received", "info uploaded"]);
      expect(lines[0]![2]).toEqual({ name: "a.txt", type: expect.stringMatching(/^text\/plain/), size: 17 });
      expect(lines[1]![2]).toMatchObject({ name: "a.txt", size: 17, upload_id: "up-1", ms: expect.any(Number) });
      expect(JSON.stringify(lines)).not.toContain("file-contents");
    });

    it("logs a failed upload", async () => {
      const { logger, lines } = recorder();
      client.uploadAgentInput.mockRejectedValue(statusError(413, JSON.stringify({ detail: "Too big" })));

      expect((await upload(logger)).status).toBe(413);
      expect(lines.at(-1)).toEqual([
        "error",
        "upload failed",
        expect.objectContaining({ name: "a.txt", status: 413, upstream_status: 413, error: "Too big" }),
      ]);
    });

    const download = (logger: SeclaiLogger) =>
      withLogger(logger).download(
        new Request(`${URL_BASE}/download?${new URLSearchParams({ runId: RUN, attachmentId: "att-1" })}`),
      );

    it("logs a download served", async () => {
      const { logger, lines } = recorder();
      client.downloadAgentRunAttachment.mockResolvedValue(
        new Response("bytes", { headers: { "content-type": "image/png" } }),
      );
      await download(logger);
      expect(lines).toEqual([
        [
          "info",
          "download served",
          { run_id: RUN, attachment_id: "att-1", status: 200, content_type: "image/png" },
        ],
      ]);
    });

    it("logs a failed download", async () => {
      const { logger, lines } = recorder();
      client.downloadAgentRunAttachment.mockRejectedValue(statusError(404));
      await download(logger);
      expect(lines).toEqual([
        [
          "error",
          "download failed",
          expect.objectContaining({ run_id: RUN, attachment_id: "att-1", status: 404, upstream_status: 404 }),
        ],
      ]);
    });
  });

  it("never logs the input text or the API key", async () => {
    const { logger, lines } = recorder();
    client.runStreamingAgent.mockReturnValue(
      eventsOf(
        { event: "init", data: { run_id: RUN } },
        { event: "stream_token", data: { token: "x" } },
        COMPLETED(),
      ),
    );
    await (await withLogger(logger).run(runRequest({ input: INPUT, sessionId: "s" }))).text();
    // An error message that happens to carry the key.
    client.runStreamingAgent.mockImplementation(async function* () {
      throw new Error(`connect failed for ${API_KEY}`);
    });
    await withLogger(logger).run(runRequest({ input: INPUT }));
    client.downloadAgentRunAttachment.mockRejectedValue(new Error(`bad key ${API_KEY}`));
    await withLogger(logger).download(
      new Request(`${URL_BASE}/download?${new URLSearchParams({ runId: RUN, attachmentId: "a" })}`),
    );

    expect(lines.length).toBeGreaterThan(8);
    const logged = JSON.stringify(lines);
    expect(logged).not.toContain(INPUT);
    expect(logged).not.toContain(API_KEY);
    expect(logged).toContain("[redacted]");
  });

  it("keeps the run and the upload working when the logger throws", async () => {
    const broken: SeclaiLogger = {
      debug: () => {
        throw new Error("debug");
      },
      info: () => {
        throw new Error("info");
      },
      warn: () => {
        throw new Error("warn");
      },
      error: () => {
        throw new Error("error");
      },
    };
    const outcomes: RunOutcome[] = [];
    client.runStreamingAgent.mockReturnValue(
      eventsOf(
        { event: "init", data: { run_id: RUN } },
        { event: "stream_token", data: { token: "Hi" } },
        COMPLETED(),
      ),
    );
    const res = await withLogger(broken, { onRunEnd: (o) => void outcomes.push(o) }).run(
      runRequest({ input: "hi" }),
    );
    expect(await res.text()).toBe(
      [
        `event: init\ndata: {"run_id":"${RUN}"}\n\n`,
        `event: stream_token\ndata: {"token":"Hi"}\n\n`,
        `event: done\ndata: ${JSON.stringify(COMPLETED().data)}\n\n`,
      ].join(""),
    );
    expect(outcomes.map((o) => o.status)).toEqual(["completed"]);

    client.uploadAgentInput.mockResolvedValue({ id: "up-1", status: "ready" });
    const form = new FormData();
    form.set("file", new File(["x"], "a.txt"));
    const up = await withLogger(broken).upload(
      new Request(`${URL_BASE}/upload`, { method: "POST", body: form }),
    );
    expect(up.status).toBe(200);

    client.runStreamingAgent.mockImplementation(async function* () {
      throw statusError(400);
    });
    expect((await withLogger(broken).run(runRequest({ input: "hi" }))).status).toBe(400);
  });

  it("relays the same bytes with or without a logger", async () => {
    const events = () =>
      eventsOf(
        { event: "init", data: { run_id: RUN } },
        { event: "step_progress", data: { step_name: "n" } },
        { event: "stream_token", data: { token: "Hi" } },
        COMPLETED([{ id: "a" }]),
      );
    client.runStreamingAgent.mockReturnValue(events());
    const plain = await (await handlers().run(runRequest({ input: "hi" }))).text();
    client.runStreamingAgent.mockReturnValue(events());
    const logged = await (await withLogger(recorder().logger).run(runRequest({ input: "hi" }))).text();
    expect(logged).toBe(plain);
  });

  it("sends callback errors to logger.error instead of console.error", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { logger, lines } = recorder();
    client.runStreamingAgent.mockReturnValue(eventsOf({ event: "init", data: { run_id: RUN } }, COMPLETED()));
    const res = await withLogger(logger, {
      onRunEnd: () => {
        throw new Error("db down");
      },
    }).run(runRequest({ input: "hi" }));

    expect(await res.text()).toContain("event: error");
    expect(consoleError).not.toHaveBeenCalled();
    const errors = lines.filter(([l]) => l === "error");
    expect(errors).toEqual([
      ["error", "an onEvent or onRunEnd callback threw", expect.objectContaining({ run_id: RUN, error: new Error("db down") })],
      ["error", "run failed: a callback threw", expect.objectContaining({ run_id: RUN, status: "failed" })],
    ]);
  });

  it.each(["onEvent", "onRunEnd"] as const)(
    "logs a run whose %s threw on `done` as failed, not done, after the callbacks ran",
    async (name) => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const { logger, lines, summary } = recorder();
      const order: string[] = [];
      const outcomes: RunOutcome[] = [];
      client.runStreamingAgent.mockReturnValue(eventsOf({ event: "init", data: { run_id: RUN } }, COMPLETED()));
      const res = await withLogger(logger, {
        onEvent: (e) => {
          if (e.event !== "done") return;
          order.push("onEvent done");
          if (name === "onEvent") throw new Error("db down");
        },
        onRunEnd: (o) => {
          order.push("onRunEnd");
          outcomes.push(o);
          if (name === "onRunEnd") throw new Error("db down");
        },
      }).run(runRequest({ input: "hi" }));

      const names = [...(await res.text()).matchAll(/^event: (.+)$/gm)].map((m) => m[1]);
      expect(names).toEqual(["init", "error"]);
      expect(summary()).not.toContain("info run done");
      expect(summary().at(-1)).toBe("error run failed: a callback threw");
      expect(lines.at(-1)![2]).toMatchObject({ run_id: RUN, status: "failed" });
      // The browser gets an error event, and so does onRunEnd unless it was the one that threw.
      expect(outcomes.map((o) => o.status)).toEqual(name === "onEvent" ? ["failed"] : ["completed"]);
      expect(order.indexOf("onEvent done")).toBeLessThan(order.indexOf("onRunEnd"));
    },
  );

  it("logs `run done` only after onRunEnd has resolved", async () => {
    const { logger } = recorder();
    const order: string[] = [];
    logger.info = (message) => void order.push(`log ${message}`);
    client.runStreamingAgent.mockReturnValue(eventsOf({ event: "init", data: { run_id: RUN } }, COMPLETED()));
    const res = await withLogger(logger, {
      onRunEnd: async (o) => {
        await Promise.resolve();
        order.push(`onRunEnd ${o.status}`);
      },
    }).run(runRequest({ input: "hi" }));
    await res.text();
    expect(order.slice(-2)).toEqual(["onRunEnd completed", "log run done"]);
  });

  it("logs the upstream's real error on a mid-stream failure, without sending it to the browser", async () => {
    const { logger, find } = recorder();
    client.runStreamingAgent.mockImplementation(async function* () {
      yield { event: "init", data: { run_id: RUN } };
      throw new Error(`socket hang up calling https://api.test?key=${API_KEY}`);
    });
    const res = await withLogger(logger).run(runRequest({ input: "hi" }));
    const body = await res.text();

    expect(body).toContain('"error":"The connection to the Seclai API was lost."');
    expect(body).not.toContain("socket hang up");
    expect(body).not.toContain(API_KEY);
    const fields = find("stream error")![2]!;
    expect(fields).toMatchObject({
      run_id: RUN,
      error: "The connection to the Seclai API was lost.",
      cause: "socket hang up calling https://api.test?key=[redacted]",
    });
    expect(JSON.stringify(fields)).not.toContain(API_KEY);
  });

  it("logs a disconnect, not a rejection, when the browser leaves while the stream connects", async () => {
    const { logger, summary } = recorder();
    const browser = new AbortController();
    client.runStreamingAgent.mockImplementation(async function* (
      _agentId: string,
      _body: unknown,
      opts: { signal: AbortSignal },
    ) {
      await new Promise((_resolve, reject) => {
        opts.signal.addEventListener("abort", () => reject(new Error("This operation was aborted")));
      });
    });
    const running = withLogger(logger).run(runRequest({ input: "hi" }, { signal: browser.signal }));
    await new Promise((r) => setTimeout(r, 0));
    browser.abort();
    await running;

    expect(summary()).toEqual([
      "info run starting",
      "info browser disconnected; the run continues on Seclai",
    ]);
  });
});

describe("consoleLogger", () => {
  it("writes from the given level up, prefixed, to the target", () => {
    const target = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const log = consoleLogger("warn", target);
    log.debug("d");
    log.info("i", { a: 1 });
    log.warn("w", { a: 1 });
    log.error("e");
    expect(target.debug).not.toHaveBeenCalled();
    expect(target.info).not.toHaveBeenCalled();
    expect(target.warn).toHaveBeenCalledWith("[seclai] w", { a: 1 });
    expect(target.error).toHaveBeenCalledWith("[seclai] e");
  });

  it("defaults to info and console", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    consoleLogger().debug("d");
    consoleLogger().info("i");
    expect(debug).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith("[seclai] i");
    vi.restoreAllMocks();
  });

  it("writes nothing when silent", () => {
    const target = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const log = consoleLogger("silent", target);
    log.error("e");
    expect(target.error).not.toHaveBeenCalled();
  });
});

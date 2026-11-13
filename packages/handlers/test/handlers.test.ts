import { SeclaiAPIStatusError, SeclaiStreamingError, type AgentRunEvent } from "@seclai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSeclaiHandlers,
  deny,
  type RunRequestBody,
  type SeclaiHandlers,
  type SeclaiHandlersOptions,
} from "../src";
import { KEEPALIVE_INTERVAL_MS } from "../src/sse";

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

describe("authorizeRun", () => {
  const withHook = (authorizeRun: SeclaiHandlersOptions["authorizeRun"]) =>
    createSeclaiHandlers({ apiKey: "secret-key", agentId: AGENT, authorizeRun });
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    client.runStreamingAgent.mockReturnValue(eventsOf({ event: "done", data: {} }));
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => consoleError.mockRestore());

  it("receives the request and the validated body", async () => {
    const hook = vi.fn((_req: Request, body: RunRequestBody) => body);
    const req = runRequest({ input: "hi", uploadIds: ["a"], sessionId: "s1", extra: true });

    const res = await withHook(hook).run(req);

    expect(res.status).toBe(200);
    expect(hook).toHaveBeenCalledOnce();
    expect(hook.mock.calls[0]![0]).toBe(req);
    // Unknown fields are already gone.
    expect(hook.mock.calls[0]![1]).toEqual({ input: "hi", uploadIds: ["a"], sessionId: "s1" });
    expect(client.runStreamingAgent.mock.calls[0]![1]).toEqual({
      input: "hi",
      input_upload_ids: ["a"],
      metadata: { session_id: "s1" },
    });
  });

  it("returns a refusal Response as-is, without calling the API", async () => {
    const refusal = new Response("nope", { status: 403 });
    const res = await withHook(() => refusal).run(runRequest({ input: "hi", sessionId: "s1" }));

    expect(res).toBe(refusal);
    expect(client.runStreamingAgent).not.toHaveBeenCalled();
  });

  it("runs a rewritten body", async () => {
    await withHook((_req, body) => ({
      ...body,
      input: `${body.input}\n\nThe first upload is the logo.`,
      uploadIds: ["server-side"],
    })).run(runRequest({ input: "hi", uploadIds: ["a"] }));

    expect(client.runStreamingAgent.mock.calls[0]![1]).toEqual({
      input: "hi\n\nThe first upload is the logo.",
      input_upload_ids: ["server-side"],
    });
  });

  it("drops unknown fields a rewrite adds", async () => {
    await withHook((_req, body) => ({ ...body, agentId: "other" }) as RunRequestBody).run(
      runRequest({ input: "hi" }),
    );
    expect(client.runStreamingAgent).toHaveBeenCalledOnce();
    expect(client.runStreamingAgent.mock.calls[0]![0]).toBe(AGENT);
    expect(client.runStreamingAgent.mock.calls[0]![1]).toEqual({ input: "hi" });
  });

  it.each([
    ["an empty body", {}],
    ["a non-string input", { input: 1 }],
    ["an empty session id", { input: "x", sessionId: "" }],
    ["null", null],
    ["a string", "ok"],
  ])("returns a 500 for a rewrite to %s, and logs why", async (_label, rewrite) => {
    const res = await withHook(() => rewrite as RunRequestBody).run(runRequest({ input: "hi" }));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Could not authorize this request.", status: 500 });
    expect(client.runStreamingAgent).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledOnce();
    expect(String(consoleError.mock.calls[0]![0])).toMatch(/authorizeRun returned a body that isn't valid/);
  });

  it("validates the body again when the hook changes it in place and returns nothing", async () => {
    const res = await withHook((_req, body) => {
      (body as Record<string, unknown>).uploadIds = null;
      delete body.input;
    }).run(runRequest({ input: "hi" }));

    expect(res.status).toBe(500);
    expect(client.runStreamingAgent).not.toHaveBeenCalled();
    expect(String(consoleError.mock.calls[0]![0])).toMatch(/changed the body in place/);
  });

  it("runs a body the hook changed in place, when it's still valid", async () => {
    await withHook((_req, body) => {
      body.sessionId = "from-db";
    }).run(runRequest({ input: "hi" }));

    expect(client.runStreamingAgent.mock.calls[0]![1]).toEqual({
      input: "hi",
      metadata: { session_id: "from-db" },
    });
  });

  it("logs the validation reason for a bad rewrite", async () => {
    await withHook(() => ({ input: 1 }) as unknown as RunRequestBody).run(runRequest({ input: "hi" }));
    expect(String(consoleError.mock.calls[0]![0])).toContain("`input` must be a string.");
  });

  it.each([
    ["nothing", () => {}],
    ["undefined from an async hook", async () => undefined],
    ["true", () => true],
  ])("runs the body unchanged when the hook returns %s", async (_label, hook) => {
    const res = await withHook(hook).run(runRequest({ input: "hi", sessionId: "s1" }));

    expect(res.status).toBe(200);
    expect(client.runStreamingAgent.mock.calls[0]![1]).toEqual({
      input: "hi",
      metadata: { session_id: "s1" },
    });
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("returns a 403 for false, without calling the API", async () => {
    const res = await withHook(() => false).run(runRequest({ input: "hi" }));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "This request isn't allowed.", status: 403 });
    expect(client.runStreamingAgent).not.toHaveBeenCalled();
  });

  it("treats a thrown Response as a refusal, without logging it", async () => {
    const res = await withHook(() => {
      throw deny(403, "That isn't your conversation.");
    }).run(runRequest({ input: "hi", sessionId: "someone-elses" }));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "That isn't your conversation.", status: 403 });
    expect(client.runStreamingAgent).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("awaits an async hook", async () => {
    const res = await withHook(async (_req, body) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return { ...body, sessionId: "from-db" };
    }).run(runRequest({ input: "hi" }));

    expect(res.status).toBe(200);
    expect(client.runStreamingAgent.mock.calls[0]![1]).toEqual({
      input: "hi",
      metadata: { session_id: "from-db" },
    });
  });

  it("awaits an async refusal", async () => {
    const res = await withHook(async () => new Response(null, { status: 401 })).run(
      runRequest({ input: "hi" }),
    );
    expect(res.status).toBe(401);
    expect(client.runStreamingAgent).not.toHaveBeenCalled();
  });

  it.each([
    ["throws", () => {
      throw new Error("db password is hunter2");
    }],
    ["rejects", async () => {
      throw new Error("db password is hunter2");
    }],
  ])("returns a 500 without the message when the hook %s, and logs the error", async (_label, hook) => {
    const res = await withHook(hook).run(runRequest({ input: "hi" }));

    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.text()).not.toContain("hunter2");
    expect(client.runStreamingAgent).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledOnce();
    expect(consoleError.mock.calls[0]![0]).toBe("[seclai] authorizeRun threw, so the request got a 500.");
    expect((consoleError.mock.calls[0]![1] as Error).message).toBe("db password is hunter2");
  });

  it("is not called for a body that fails validation", async () => {
    const hook = vi.fn((_req: Request, body: RunRequestBody) => body);
    const res = await withHook(hook).run(runRequest({}));
    expect(res.status).toBe(400);
    expect(hook).not.toHaveBeenCalled();
  });

  it("is not called for the wrong method", async () => {
    const hook = vi.fn((_req: Request, body: RunRequestBody) => body);
    const res = await withHook(hook).run(new Request(`${URL_BASE}/run`));
    expect(res.status).toBe(405);
    expect(hook).not.toHaveBeenCalled();
  });

  it("applies through handle", async () => {
    const res = await withHook(() => new Response(null, { status: 403 })).handle(
      runRequest({ input: "hi" }),
    );
    expect(res.status).toBe(403);
    expect(client.runStreamingAgent).not.toHaveBeenCalled();
  });
});

describe("authorizeDownload", () => {
  const withHook = (authorizeDownload: SeclaiHandlersOptions["authorizeDownload"]) =>
    createSeclaiHandlers({ apiKey: "secret-key", agentId: AGENT, authorizeDownload });
  const downloadRequest = (attachmentId = "abc") =>
    new Request(`${URL_BASE}/download?${new URLSearchParams({ runId: RUN, attachmentId })}`);
  let consoleError: ReturnType<typeof vi.spyOn>;
  let consoleWarn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    client.downloadAgentRunAttachment.mockImplementation(
      async () => new Response("bytes", { headers: { "content-type": "text/plain" } }),
    );
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    consoleError.mockRestore();
    consoleWarn.mockRestore();
  });

  it("serves the file when the hook returns true, passing the request and ids", async () => {
    const hook = vi.fn(() => true);
    const req = downloadRequest();

    const res = await withHook(hook).download(req);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("bytes");
    expect(hook).toHaveBeenCalledWith(req, { runId: RUN, attachmentId: "abc" }, undefined);
  });

  it("returns a 404 for false, without calling the API", async () => {
    const res = await withHook(() => false).download(downloadRequest());

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found.", status: 404 });
    expect(client.downloadAgentRunAttachment).not.toHaveBeenCalled();
  });

  it("treats a missing return value as a refusal, and warns once", async () => {
    const seclai = withHook((() => undefined) as unknown as () => boolean);
    const first = await seclai.download(downloadRequest());
    const second = await seclai.download(downloadRequest());

    expect(first.status).toBe(404);
    expect(second.status).toBe(404);
    expect(client.downloadAgentRunAttachment).not.toHaveBeenCalled();
    expect(consoleWarn).toHaveBeenCalledOnce();
    expect(String(consoleWarn.mock.calls[0]![0])).toMatch(/returned undefined.*Return true to serve the file/);
  });

  it("doesn't warn for an explicit false", async () => {
    await withHook(() => false).download(downloadRequest());
    expect(consoleWarn).not.toHaveBeenCalled();
  });

  it("treats a thrown Response as a refusal", async () => {
    const res = await withHook(() => {
      throw deny(401, "Sign in to download.");
    }).download(downloadRequest());
    expect(res.status).toBe(401);
    expect(client.downloadAgentRunAttachment).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("returns a refusal Response as-is, without calling the API", async () => {
    const refusal = new Response("sign in", { status: 401 });
    const res = await withHook(() => refusal).download(downloadRequest());

    expect(res).toBe(refusal);
    expect(client.downloadAgentRunAttachment).not.toHaveBeenCalled();
  });

  it("awaits an async hook", async () => {
    const serve = await withHook(async () => true).download(downloadRequest());
    expect(serve.status).toBe(200);

    const refuse = await withHook(async () => false).download(downloadRequest());
    expect(refuse.status).toBe(404);
    expect(client.downloadAgentRunAttachment).toHaveBeenCalledOnce();
  });

  it.each([
    ["throws", () => {
      throw new Error("db password is hunter2");
    }],
    ["rejects", async () => {
      throw new Error("db password is hunter2");
    }],
  ])("returns a 500 without the message when the hook %s", async (_label, hook) => {
    const res = await withHook(hook).download(downloadRequest());

    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("hunter2");
    expect(client.downloadAgentRunAttachment).not.toHaveBeenCalled();
  });

  it("is not called for malformed ids", async () => {
    const hook = vi.fn(() => true);
    const res = await withHook(hook).download(downloadRequest("../../agents/x"));
    expect(res.status).toBe(400);
    expect(hook).not.toHaveBeenCalled();
  });

  it("applies through handle", async () => {
    const res = await withHook(() => false).handle(downloadRequest());
    expect(res.status).toBe(404);
    expect(client.downloadAgentRunAttachment).not.toHaveBeenCalled();
  });
});

describe("authorizeUpload", () => {
  const withHook = (authorizeUpload: SeclaiHandlersOptions["authorizeUpload"]) =>
    createSeclaiHandlers({ apiKey: "secret-key", agentId: AGENT, authorizeUpload });
  const uploadRequest = (name = "a.png") => {
    const form = new FormData();
    form.set("file", new File(["png"], name, { type: "image/png" }));
    return new Request(`${URL_BASE}/upload`, { method: "POST", body: form });
  };
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    client.uploadAgentInput.mockResolvedValue({
      id: "up-1",
      status: "ready",
      filename: "a.png",
      content_type: "image/png",
      file_size: 3,
    });
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => consoleError.mockRestore());

  it("receives the request and the file, and uploads when it returns nothing", async () => {
    const hook = vi.fn((_req: Request, _file: File) => {});
    const req = uploadRequest("me.png");

    const res = await withHook(hook).upload(req);

    expect(res.status).toBe(200);
    expect(hook.mock.calls[0]![0]).toBe(req);
    expect((hook.mock.calls[0]![1] as File).name).toBe("me.png");
    expect(client.uploadAgentInput).toHaveBeenCalledOnce();
  });

  it("uploads when it returns true", async () => {
    expect((await withHook(() => true).upload(uploadRequest())).status).toBe(200);
  });

  it("returns a 403 for false, without uploading", async () => {
    const res = await withHook(() => false).upload(uploadRequest());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "This upload isn't allowed.", status: 403 });
    expect(client.uploadAgentInput).not.toHaveBeenCalled();
  });

  it("returns a refusal Response, returned or thrown, without uploading", async () => {
    const returned = await withHook(() => deny(413, "Too big.")).upload(uploadRequest());
    const thrown = await withHook(() => {
      throw deny(409, "One headshot per session.");
    }).upload(uploadRequest());

    expect(returned.status).toBe(413);
    expect(thrown.status).toBe(409);
    expect(await thrown.json()).toEqual({ error: "One headshot per session.", status: 409 });
    expect(client.uploadAgentInput).not.toHaveBeenCalled();
  });

  it("returns a logged 500 when the hook throws", async () => {
    const res = await withHook(() => {
      throw new Error("db password is hunter2");
    }).upload(uploadRequest());

    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("hunter2");
    expect(consoleError).toHaveBeenCalledOnce();
    expect(client.uploadAgentInput).not.toHaveBeenCalled();
  });

  it("returns a logged 500 for a return value it doesn't understand", async () => {
    const res = await withHook((() => "yes") as unknown as () => boolean).upload(uploadRequest());
    expect(res.status).toBe(500);
    expect(consoleError).toHaveBeenCalledOnce();
    expect(client.uploadAgentInput).not.toHaveBeenCalled();
  });

  it("is not called when the form has no file", async () => {
    const hook = vi.fn(() => true);
    const res = await withHook(hook).upload(
      new Request(`${URL_BASE}/upload`, { method: "POST", body: new FormData() }),
    );
    expect(res.status).toBe(400);
    expect(hook).not.toHaveBeenCalled();
  });

  it("applies through handle", async () => {
    const res = await withHook(() => false).handle(uploadRequest());
    expect(res.status).toBe(403);
    expect(client.uploadAgentInput).not.toHaveBeenCalled();
  });
});

describe("hook context", () => {
  type User = { userId: string };
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    client.runStreamingAgent.mockReturnValue(eventsOf({ event: "done", data: {} }));
    client.downloadAgentRunAttachment.mockImplementation(async () => new Response("bytes"));
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => consoleError.mockRestore());

  it("passes the `context` option's value to the hooks", async () => {
    const context = vi.fn(async (req: Request): Promise<User> => ({
      userId: req.headers.get("x-user") ?? "",
    }));
    const authorizeRun = vi.fn((_req: Request, _body: RunRequestBody, _ctx: User) => {});
    const authorizeDownload = vi.fn((_req: Request, _ids: unknown, ctx: User) => ctx.userId === "u1");
    const seclai = createSeclaiHandlers({ apiKey: "k", agentId: AGENT, context, authorizeRun, authorizeDownload });

    await seclai.run(runRequest({ input: "hi" }, { headers: { "x-user": "u1" } }));
    const download = await seclai.download(
      new Request(`${URL_BASE}/download?runId=${RUN}&attachmentId=a`, { headers: { "x-user": "u1" } }),
    );

    expect(authorizeRun.mock.calls[0]![2]).toEqual({ userId: "u1" });
    expect(download.status).toBe(200);
    expect(context).toHaveBeenCalledTimes(2);
  });

  it("only resolves the context when a hook is about to run", async () => {
    const context = vi.fn(async () => ({ userId: "u1" }));
    const seclai = createSeclaiHandlers({ apiKey: "k", agentId: AGENT, context, authorizeRun: () => {} });

    await seclai.run(runRequest({}));
    await seclai.download(new Request(`${URL_BASE}/download?runId=${RUN}&attachmentId=a`));

    expect(context).not.toHaveBeenCalled();
  });

  it("refuses when the context throws a Response", async () => {
    const seclai = createSeclaiHandlers({
      apiKey: "k",
      agentId: AGENT,
      context: (): User => {
        throw deny(401, "Sign in first.");
      },
      authorizeRun: () => {},
    });

    const res = await seclai.run(runRequest({ input: "hi" }));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Sign in first.", status: 401 });
    expect(client.runStreamingAgent).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("returns a logged 500 when the context throws an error", async () => {
    const seclai = createSeclaiHandlers({
      apiKey: "k",
      agentId: AGENT,
      context: (): User => {
        throw new Error("session store is down");
      },
      authorizeRun: () => {},
    });

    const res = await seclai.run(runRequest({ input: "hi" }));

    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("session store");
    expect(consoleError).toHaveBeenCalledOnce();
  });

  it("withContext passes its value instead of calling the `context` option", async () => {
    const context = vi.fn(async (): Promise<User> => ({ userId: "from-request" }));
    const authorizeRun = vi.fn((_req: Request, _body: RunRequestBody, _ctx: User) => {});
    const seclai = createSeclaiHandlers({ apiKey: "k", agentId: AGENT, context, authorizeRun });

    const res = await seclai.withContext({ userId: "from-framework" }).handle(runRequest({ input: "hi" }));

    expect(res.status).toBe(200);
    expect(authorizeRun.mock.calls[0]![2]).toEqual({ userId: "from-framework" });
    expect(context).not.toHaveBeenCalled();
  });

  it("withContext leaves the original handlers unbound", async () => {
    const seen: (User | undefined)[] = [];
    const seclai = createSeclaiHandlers<User | undefined>({
      apiKey: "k",
      agentId: AGENT,
      authorizeRun: (_req, _body, ctx) => void seen.push(ctx),
    });

    await seclai.withContext({ userId: "u1" }).run(runRequest({ input: "hi" }));
    client.runStreamingAgent.mockReturnValue(eventsOf({ event: "done", data: {} }));
    await seclai.run(runRequest({ input: "hi" }));

    expect(seen).toEqual([{ userId: "u1" }, undefined]);
  });

  it("hints at the missing context when a hook can't read it", async () => {
    // TypeScript only offers withContext here; plain JavaScript can still call run.
    const seclai = createSeclaiHandlers<User>({
      apiKey: "k",
      agentId: AGENT,
      authorizeRun: (_req, _body, { userId }) => userId === "u1",
    }) as unknown as SeclaiHandlers;

    const res = await seclai.run(runRequest({ input: "hi" }));

    expect(res.status).toBe(500);
    expect(String(consoleError.mock.calls[0]![0])).toContain(
      "No context was passed: set the `context` option, or call `withContext(ctx)`.",
    );
  });
});

describe("deny", () => {
  it("builds the handlers' error JSON with optional headers", async () => {
    const res = deny(429, "Slow down.", { "retry-after": "30" });
    expect(res.status).toBe(429);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("retry-after")).toBe("30");
    expect(await res.json()).toEqual({ error: "Slow down.", status: 429 });
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

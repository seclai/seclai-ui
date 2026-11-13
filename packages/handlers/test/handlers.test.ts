import { SeclaiAPIStatusError, SeclaiStreamingError, type AgentRunEvent } from "@seclai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ATTACHMENT_SLOTS_TTL_MS, createSeclaiHandlers, type SeclaiUploadOptions } from "../src";
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

describe("upload options", () => {
  const UPLOADED = {
    id: "up-1",
    status: "ready",
    filename: "a.png",
    content_type: "image/png",
    file_size: 5,
  };

  const withUpload = (upload: SeclaiUploadOptions) =>
    createSeclaiHandlers({ apiKey: "secret-key", agentId: AGENT, upload });

  function uploadRequest(file: File, headers?: HeadersInit) {
    const form = new FormData();
    form.set("file", file);
    return new Request(`${URL_BASE}/upload`, { method: "POST", body: form, headers });
  }

  const png = (body = "hello") => new File([body], "a.png", { type: "image/png" });

  function slots(...accepted: Array<{ name: string; content_types?: string[] }>) {
    client.getAgentAttachmentReferences.mockResolvedValue({
      requires_uploads: accepted.length > 0,
      accepted_attachments: accepted.map((slot) => ({ min: 0, ...slot })),
    });
  }

  beforeEach(() => {
    client.uploadAgentInput.mockResolvedValue(UPLOADED);
  });

  it("rejects maxBytes other than a positive number", () => {
    for (const maxBytes of [0, -1, Number.NaN, Infinity]) {
      expect(() => withUpload({ maxBytes })).toThrow(/maxBytes/);
    }
  });

  describe("maxBytes", () => {
    it("refuses an oversized body from its content-length without reading it", async () => {
      const req = uploadRequest(png(), { "content-length": String(10 * 1024 * 1024) });
      const formData = vi.spyOn(req, "formData");

      const res = await withUpload({ maxBytes: 1024 * 1024 }).upload(req);

      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({
        error: "The file is larger than the 1048576-byte limit.",
        status: 413,
      });
      expect(formData).not.toHaveBeenCalled();
      expect(client.uploadAgentInput).not.toHaveBeenCalled();
    });

    it("stops reading a chunked body without content-length once it passes the limit", async () => {
      const boundary = "limit-test";
      const encoder = new TextEncoder();
      const chunk = new Uint8Array(16 * 1024).fill(97);
      const totalChunks = 200; // 3.2 MB, far over 1 KB + the 64 KB envelope
      let sent = 0;
      let cancelled = false;
      const source = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent === 0) {
            controller.enqueue(
              encoder.encode(
                `--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="a.bin"\r\n` +
                  "content-type: application/octet-stream\r\n\r\n",
              ),
            );
          }
          if (sent === totalChunks) {
            controller.enqueue(encoder.encode(`\r\n--${boundary}--\r\n`));
            controller.close();
            return;
          }
          sent++;
          controller.enqueue(chunk);
        },
        cancel() {
          cancelled = true;
        },
      });
      const req = new Request(`${URL_BASE}/upload`, {
        method: "POST",
        headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
        body: source,
        duplex: "half",
      } as RequestInit);
      expect(req.headers.get("content-length")).toBeNull();

      const res = await withUpload({ maxBytes: 1024 }).upload(req);

      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({
        error: "The file is larger than the 1024-byte limit.",
        status: 413,
      });
      expect(cancelled).toBe(true);
      expect(sent).toBeLessThan(totalChunks);
      expect(client.uploadAgentInput).not.toHaveBeenCalled();
    });

    it("refuses a file over the limit by its actual size", async () => {
      const res = await withUpload({ maxBytes: 4 }).upload(uploadRequest(png("hello")));
      expect(res.status).toBe(413);
      expect(client.uploadAgentInput).not.toHaveBeenCalled();
    });

    it("accepts a file at the limit, leaving room for the multipart envelope", async () => {
      const res = await withUpload({ maxBytes: 5 }).upload(
        uploadRequest(png("hello"), { "content-length": "400" }),
      );
      expect(res.status).toBe(200);
      expect(client.uploadAgentInput).toHaveBeenCalledOnce();
    });
  });

  describe("checkContentType", () => {
    afterEach(() => vi.useRealTimers());

    it("uploads a file a slot allows", async () => {
      slots(
        { name: "doc", content_types: ["application/pdf"] },
        { name: "photo", content_types: ["image/png"] },
      );
      const res = await withUpload({ checkContentType: true }).upload(uploadRequest(png()));
      expect(res.status).toBe(200);
      expect(client.getAgentAttachmentReferences).toHaveBeenCalledWith(AGENT);
      expect(client.uploadAgentInput).toHaveBeenCalledOnce();
    });

    it("refuses a file no slot allows without calling the upload API", async () => {
      slots({ name: "doc", content_types: ["application/pdf"] });
      const res = await withUpload({ checkContentType: true }).upload(uploadRequest(png()));
      expect(res.status).toBe(415);
      expect(await res.json()).toEqual({
        error: "This agent does not accept files of type image/png.",
        status: 415,
      });
      expect(client.uploadAgentInput).not.toHaveBeenCalled();
    });

    it.each([
      ["a type wildcard", ["image/*"], "image/png", true],
      ["a type wildcard for another type", ["image/*"], "text/plain", false],
      ["a wildcard without its slash", ["image/*"], "imagery/png", false],
      ["a full wildcard", ["*/*"], "text/plain", true],
      ["different case", ["Image/PNG"], "image/png", true],
      ["parameters on the file's type", ["text/plain"], "text/plain;charset=utf-8", true],
      ["a slot without types", [], "application/x-anything", true],
      ["a typeless file and a typed slot", ["image/*"], "", true],
      ["a typeless file and an any-type slot", [], "", true],
      ["an octet-stream file and a typed slot", ["image/*"], "application/octet-stream", true],
    ])("handles %s", async (_label, contentTypes, fileType, allowed) => {
      slots({ name: "files", content_types: contentTypes });
      const res = await withUpload({ checkContentType: true }).upload(
        uploadRequest(new File(["x"], "f", { type: fileType })),
      );
      expect(res.status).toBe(allowed ? 200 : 415);
    });

    it("leaves a file without a type to the API, without looking up the slots", async () => {
      slots();
      const res = await withUpload({ checkContentType: true }).upload(
        uploadRequest(new File(["# notes"], "notes.md", { type: "" })),
      );
      expect(res.status).toBe(200);
      expect(client.getAgentAttachmentReferences).not.toHaveBeenCalled();
      expect(client.uploadAgentInput).toHaveBeenCalledOnce();
    });

    it("refuses every typed file when the agent declares no slots", async () => {
      slots();
      const res = await withUpload({ checkContentType: true }).upload(uploadRequest(png()));
      expect(res.status).toBe(415);
      expect(client.uploadAgentInput).not.toHaveBeenCalled();
    });

    it("looks the slots up once within the TTL, and again after it", async () => {
      vi.useFakeTimers();
      slots({ name: "photo", content_types: ["image/*"] });
      const seclai = withUpload({ checkContentType: true });

      await seclai.upload(uploadRequest(png()));
      await seclai.upload(uploadRequest(png()));
      expect(client.getAgentAttachmentReferences).toHaveBeenCalledOnce();
      expect(client.uploadAgentInput).toHaveBeenCalledTimes(2);

      vi.advanceTimersByTime(ATTACHMENT_SLOTS_TTL_MS);
      await seclai.upload(uploadRequest(png()));
      expect(client.getAgentAttachmentReferences).toHaveBeenCalledTimes(2);
    });

    it("refuses the upload when the lookup fails, and retries on the next one", async () => {
      client.getAgentAttachmentReferences.mockRejectedValueOnce(new Error("secret-key down"));
      const seclai = withUpload({ checkContentType: true });

      const res = await seclai.upload(uploadRequest(png()));
      expect(res.status).toBe(502);
      expect(await res.text()).not.toContain("secret-key");
      expect(client.uploadAgentInput).not.toHaveBeenCalled();

      slots({ name: "photo", content_types: ["image/*"] });
      expect((await seclai.upload(uploadRequest(png()))).status).toBe(200);
      expect(client.getAgentAttachmentReferences).toHaveBeenCalledTimes(2);
    });

    it("checks the size before looking up the slots", async () => {
      const res = await withUpload({ maxBytes: 1, checkContentType: true }).upload(
        uploadRequest(png()),
      );
      expect(res.status).toBe(413);
      expect(client.getAgentAttachmentReferences).not.toHaveBeenCalled();
    });

    it("is off by default", async () => {
      expect((await handlers().upload(uploadRequest(png()))).status).toBe(200);
      expect(client.getAgentAttachmentReferences).not.toHaveBeenCalled();
    });
  });

  describe("onUpload", () => {
    it("receives the file, result and request, and keeps the default response", async () => {
      const onUpload = vi.fn();
      const req = uploadRequest(png());

      const res = await withUpload({ onUpload }).upload(req);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(UPLOADED);
      const [file, result, passed] = onUpload.mock.calls[0]!;
      expect(await (file as File).text()).toBe("hello");
      expect((file as File).name).toBe("a.png");
      expect(result).toEqual(UPLOADED);
      expect(passed).toBe(req);
    });

    it("replaces the response with one it returns", async () => {
      const res = await withUpload({
        onUpload: async (_file, result) =>
          Response.json({ id: result.id, url: "/files/1" }, { status: 201 }),
      }).upload(uploadRequest(png()));

      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ id: "up-1", url: "/files/1" });
    });

    it("turns a throw into a 500 without leaking its message", async () => {
      const res = await withUpload({
        onUpload: () => {
          throw new Error("db password is hunter2");
        },
      }).upload(uploadRequest(png()));

      expect(res.status).toBe(500);
      const text = await res.text();
      expect(JSON.parse(text).status).toBe(500);
      expect(text).not.toContain("hunter2");
    });

    it("is not called when the upload fails", async () => {
      client.uploadAgentInput.mockRejectedValue(statusError(400));
      const onUpload = vi.fn();
      const res = await withUpload({ onUpload }).upload(uploadRequest(png()));
      expect(res.status).toBe(400);
      expect(onUpload).not.toHaveBeenCalled();
    });

    it("is not called when a file is refused", async () => {
      slots({ name: "doc", content_types: ["application/pdf"] });
      const onUpload = vi.fn();
      const res = await withUpload({ checkContentType: true, onUpload }).upload(
        uploadRequest(png()),
      );
      expect(res.status).toBe(415);
      expect(onUpload).not.toHaveBeenCalled();
    });
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

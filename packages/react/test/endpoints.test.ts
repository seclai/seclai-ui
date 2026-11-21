import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  createEndpoints,
  fetchAttachmentReferences,
  uploadFile,
  type AgentEndpoints,
  type UploadResult,
} from "../src";
import { jsonResponse } from "./helpers";

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => impl(url, init));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("createEndpoints", () => {
  it("defaults to /api/seclai without an agent id", () => {
    const endpoints: AgentEndpoints = createEndpoints();
    expect(endpoints.attachmentReferences).toBe("/api/seclai/attachment-references");
    expect(endpoints.upload).toBe("/api/seclai/upload");
    expect(endpoints.run).toBe("/api/seclai/run");
    expect(endpoints.download("r", "a")).toBe("/api/seclai/download?runId=r&attachmentId=a");
  });

  it("drops trailing slashes and encodes the agent id", () => {
    const endpoints = createEndpoints({ basePath: "/custom//", agentId: "a 1/b" });
    expect(endpoints.attachmentReferences).toBe("/custom/a%201%2Fb/attachment-references");
    expect(endpoints.upload).toBe("/custom/a%201%2Fb/upload");
    expect(endpoints.run).toBe("/custom/a%201%2Fb/run");
    expect(endpoints.download("r", "a")).toBe("/custom/a%201%2Fb/download?runId=r&attachmentId=a");
  });

  it("encodes the download params and adds the name only when there is one", () => {
    const { download } = createEndpoints();
    const url = new URL(download("run 1", "file&2", "a b.png"), "http://x");
    expect(url.pathname).toBe("/api/seclai/download");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      runId: "run 1",
      attachmentId: "file&2",
      name: "a b.png",
    });
    expect(download("r", "a", null)).not.toContain("name=");
    expect(download("r", "a", "")).not.toContain("name=");
  });
});

describe("uploadFile", () => {
  const endpoints = createEndpoints({ agentId: "agent" });
  const upload = { id: "up-1", status: "ready", filename: "a.txt", content_type: "text/plain", file_size: 2 };

  it("posts the file as multipart form data and returns the upload", async () => {
    const fetchMock = stubFetch(() => jsonResponse(upload));
    const file = new File(["hi"], "a.txt", { type: "text/plain" });

    await expect(uploadFile(endpoints, file)).resolves.toEqual(upload);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/seclai/agent/upload");
    expect(init?.method).toBe("POST");
    expect((init?.body as FormData).get("file")).toBe(file);
  });

  it("passes the signal to fetch", async () => {
    const fetchMock = stubFetch(() => jsonResponse(upload));
    const controller = new AbortController();
    await uploadFile(endpoints, new File(["hi"], "a.txt"), { signal: controller.signal });
    expect(fetchMock.mock.calls[0]![1]?.signal).toBe(controller.signal);
  });

  it("adds params to the upload URL's query string", async () => {
    const fetchMock = stubFetch(() => jsonResponse(upload));
    await uploadFile(endpoints, new File(["hi"], "a.txt"), { params: { sessionId: "s 1&2", kind: "headshot" } });
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/seclai/agent/upload?sessionId=s+1%262&kind=headshot");
  });

  it("accepts URLSearchParams, repeated keys included", async () => {
    const fetchMock = stubFetch(() => jsonResponse(upload));
    const params = new URLSearchParams([["tag", "a"], ["tag", "b"]]);
    await uploadFile(endpoints, new File(["hi"], "a.txt"), { params });
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/seclai/agent/upload?tag=a&tag=b");
  });

  it("adds params after a query the URL already has, keeping it relative", async () => {
    const fetchMock = stubFetch(() => jsonResponse(upload));
    const file = new File(["hi"], "a.txt");
    const params = { kind: "style" };
    await uploadFile({ ...endpoints, upload: "/up?tenant=t1" }, file, { params });
    await uploadFile({ ...endpoints, upload: "/up?" }, file, { params });
    await uploadFile({ ...endpoints, upload: "up?a=1&" }, file, { params });
    await uploadFile({ ...endpoints, upload: "/up?a=1#frag" }, file, { params });
    await uploadFile({ ...endpoints, upload: "https://api.example.com/up?a=1" }, file, { params });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/up?tenant=t1&kind=style",
      "/up?kind=style",
      "up?a=1&kind=style",
      "/up?a=1&kind=style#frag",
      "https://api.example.com/up?a=1&kind=style",
    ]);
  });

  it("leaves the URL unchanged without params, or with empty ones", async () => {
    const fetchMock = stubFetch(() => jsonResponse(upload));
    const file = new File(["hi"], "a.txt");
    const withQuery = { ...endpoints, upload: "/up?a=1" };
    await uploadFile(withQuery, file);
    await uploadFile(withQuery, file, { params: {} });
    await uploadFile(withQuery, file, { params: new URLSearchParams() });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/up?a=1", "/up?a=1", "/up?a=1"]);
  });

  it("types the result as UploadResult, or as the type the app names", async () => {
    stubFetch(() => jsonResponse({ id: "rec-1", sessionId: "s1", kind: "headshot" }));
    type MyUpload = { id: string; sessionId: string; kind: "headshot" | "style" };
    const file = new File(["hi"], "a.txt");

    expectTypeOf(uploadFile(endpoints, file)).resolves.toEqualTypeOf<UploadResult>();
    const mine = await uploadFile<MyUpload>(endpoints, file, { params: { sessionId: "s1" } });
    expectTypeOf(mine).toEqualTypeOf<MyUpload>();
    expect(mine.kind).toBe("headshot");
  });

  it("throws the handler's error message", async () => {
    stubFetch(() => jsonResponse({ error: "That file is too large." }, 413));
    await expect(uploadFile(endpoints, new File(["hi"], "a.txt"))).rejects.toThrow(
      new Error("That file is too large."),
    );
  });

  it("falls back to the status when the error isn't JSON", async () => {
    stubFetch(() => new Response("<html>Bad gateway</html>", { status: 502 }));
    await expect(uploadFile(endpoints, new File(["hi"], "a.txt"))).rejects.toThrow(
      "The request failed with status 502.",
    );
  });
});

describe("fetchAttachmentReferences", () => {
  const endpoints = createEndpoints();

  it("gets the attachment references with the signal", async () => {
    const refs = { requires_uploads: true, accepted_attachments: [{ name: "photo", min: 1 }] };
    const fetchMock = stubFetch(() => jsonResponse(refs));
    const controller = new AbortController();

    await expect(fetchAttachmentReferences(endpoints, { signal: controller.signal })).resolves.toEqual(refs);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/seclai/attachment-references");
    expect(init?.method).toBeUndefined();
    expect(init?.signal).toBe(controller.signal);
  });

  it("throws the handler's error message", async () => {
    stubFetch(() => jsonResponse({ error: "Unknown agent." }, 404));
    await expect(fetchAttachmentReferences(endpoints)).rejects.toThrow("Unknown agent.");
  });
});

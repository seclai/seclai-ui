import type { AgentEndpointOptions, AttachmentReferences, UploadResult } from "./types";

export const DEFAULT_BASE_PATH = "/api/seclai";

/**
 * The URLs of the `@seclai/handlers` routes. Build it with
 * {@link createEndpoints} rather than by hand: members may be added in later
 * versions.
 */
export interface AgentEndpoints {
  /** `GET`: the files the agent accepts. See {@link fetchAttachmentReferences}. */
  attachmentReferences: string;
  /** `POST` multipart form data with a `file` field. See {@link uploadFile}. */
  upload: string;
  /** `POST` JSON `{ input, uploadIds, sessionId }`: streams the run as SSE. */
  run: string;
  /**
   * The download proxy URL for a file a run produced. Use it in place of the
   * API's `download_url`, which needs the API key the browser doesn't have.
   *
   * @param runId The run that produced the file.
   * @param attachmentId The attachment's `id`.
   * @param name Optional file name for the download. Left out when empty.
   */
  download(runId: string, attachmentId: string, name?: string | null): string;
}

/**
 * Build the handler URLs for an agent, the same way `useAgentRun` and the
 * components do. Use it to link to stored attachments with `download`, rather
 * than writing the URL format by hand.
 *
 * Trailing slashes on `basePath` are dropped and `agentId` is URL-encoded.
 *
 * @example
 * const endpoints = createEndpoints({ agentId: "my-agent" });
 * endpoints.run; // "/api/seclai/my-agent/run"
 * endpoints.download(runId, attachmentId, "report.pdf");
 */
export function createEndpoints({
  basePath = DEFAULT_BASE_PATH,
  agentId,
}: AgentEndpointOptions = {}): AgentEndpoints {
  const trimmed = basePath.replace(/\/+$/, "");
  const base = agentId ? `${trimmed}/${encodeURIComponent(agentId)}` : trimmed;
  return {
    attachmentReferences: `${base}/attachment-references`,
    upload: `${base}/upload`,
    run: `${base}/run`,
    download(runId, attachmentId, name) {
      const params = new URLSearchParams({ runId, attachmentId });
      if (name) params.set("name", name);
      return `${base}/download?${params}`;
    },
  };
}

/** Read the message out of a handler's error response. */
export async function readErrorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error) return body.error;
  } catch {
    // Not one of our JSON errors, e.g. a platform's own error page.
  }
  return `The request failed with status ${res.status}.`;
}

async function readJson<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(await readErrorMessage(res));
  return (await res.json()) as T;
}

/** Per-call options for {@link uploadFile} and {@link fetchAttachmentReferences}. */
export interface EndpointRequestOptions {
  /** Aborts the request. */
  signal?: AbortSignal;
}

/**
 * Fetch the files the agent's trigger accepts, and whether it requires any.
 *
 * @throws An `Error` with the handler's error message when the response isn't
 *   OK. Rejects as `fetch` does on a network failure or when `signal` aborts.
 */
export async function fetchAttachmentReferences(
  endpoints: AgentEndpoints,
  { signal }: EndpointRequestOptions = {},
): Promise<AttachmentReferences> {
  return readJson(await fetch(endpoints.attachmentReferences, { signal }));
}

/** Options for {@link uploadFile}. */
export interface UploadFileOptions extends EndpointRequestOptions {
  /**
   * Your app's data for this upload, for example the session it belongs to or
   * the file's role. Added to the upload URL's query string, after any query
   * the URL already has; the `upload` handler passes them to `authorizeUpload`
   * and `upload.onUpload`. They are visible in the URL and in server logs, so
   * keep secrets out of them.
   */
  params?: Record<string, string> | URLSearchParams;
}

/**
 * Upload one file through the `upload` handler. Pass the returned `id` to
 * `start({ uploadIds })` from `useAgentRun`.
 *
 * The result is the handler's JSON response. When your `upload.onUpload`
 * returns its own `Response`, name its type: `uploadFile<MyUpload>(…)`. The
 * type isn't checked at run time.
 *
 * @param options `signal` aborts the upload. `params` is added to the upload
 *   URL's query string.
 * @throws An `Error` with the handler's error message when the response isn't
 *   OK. Rejects as `fetch` does on a network failure or when `signal` aborts.
 *
 * @example
 * const upload = await uploadFile<MyUpload>(endpoints, file, {
 *   params: { sessionId, kind: "headshot" },
 * });
 */
export async function uploadFile<T = UploadResult>(
  endpoints: AgentEndpoints,
  file: File,
  { signal, params }: UploadFileOptions = {},
): Promise<T> {
  const form = new FormData();
  form.set("file", file);
  const url = params ? withQuery(endpoints.upload, params) : endpoints.upload;
  return readJson<T>(await fetch(url, { method: "POST", body: form, signal }));
}

/**
 * Add `params` to `url`'s query string, keeping a relative URL relative. The
 * new params go after any already there, so the handler, which keeps the last
 * value of a repeated key, sees them.
 */
function withQuery(url: string, params: Record<string, string> | URLSearchParams): string {
  const query = new URLSearchParams(params).toString();
  if (!query) return url;
  const hashAt = url.indexOf("#");
  const base = hashAt < 0 ? url : url.slice(0, hashAt);
  const hash = hashAt < 0 ? "" : url.slice(hashAt);
  const separator = !base.includes("?") ? "?" : base.endsWith("?") || base.endsWith("&") ? "" : "&";
  return `${base}${separator}${query}${hash}`;
}

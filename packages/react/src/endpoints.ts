import type { AgentEndpointOptions, AttachmentReferences, UploadResult } from "./types";

export const DEFAULT_BASE_PATH = "/api/seclai";

export interface AgentEndpoints {
  attachmentReferences: string;
  upload: string;
  run: string;
  download(runId: string, attachmentId: string, name?: string | null): string;
}

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

export async function fetchAttachmentReferences(
  endpoints: AgentEndpoints,
  signal?: AbortSignal,
): Promise<AttachmentReferences> {
  return readJson(await fetch(endpoints.attachmentReferences, { signal }));
}

export async function uploadFile(endpoints: AgentEndpoints, file: File): Promise<UploadResult> {
  const form = new FormData();
  form.set("file", file);
  return readJson(await fetch(endpoints.upload, { method: "POST", body: form }));
}

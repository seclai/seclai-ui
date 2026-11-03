/**
 * The handlers' wire format, declared here rather than imported from
 * `@seclai/handlers` or `@seclai/sdk` so the browser bundle stays free of both.
 * Only the fields this package reads are listed.
 */

/** A file slot declared by the agent's trigger. */
export interface AcceptedAttachmentSlot {
  name: string;
  label?: string | null;
  min?: number;
  max?: number | null;
  content_types?: string[];
  name_pattern?: string | null;
}

/** The response from the `attachment-references` endpoint. */
export interface AttachmentReferences {
  requires_uploads: boolean;
  accepted_attachments?: AcceptedAttachmentSlot[];
}

/** The response from the `upload` endpoint. */
export interface UploadResult {
  id: string;
  status: string;
  filename: string;
  content_type: string;
  file_size: number;
}

/** One entry in a run's `attachments`. */
export interface RunFile {
  id: string;
  name: string | null;
  mime: string;
  bytes: number | null;
}

/** The fields read from an `init` or `done` event's run snapshot. */
export interface RunSnapshot {
  run_id?: string;
  status?: string;
  output?: string | null;
  attachments?: RunFile[];
  attempts?: { error?: string | null }[];
}

/** A file produced by a run, with a `url` that goes through the download proxy. */
export interface AgentAttachment {
  id: string;
  name: string | null;
  mime: string;
  bytes: number | null;
  url: string;
}

/** The latest progress for one step of a run. */
export interface AgentRunStep {
  id: string;
  name: string;
  message: string;
}

export type AgentRunStatus = "idle" | "running" | "completed" | "failed" | "cancelled";

/** What the agent UI boots in: a one-shot form, or a multi-turn chat. */
export type AgentUiMode = "form" | "chat";

/** Where the handlers are mounted. */
export interface AgentEndpointOptions {
  /** Base path the handlers are mounted under. Defaults to `/api/seclai`. */
  basePath?: string;
  /**
   * Adds the agent id to the path, for a server that hosts several agents:
   * `${basePath}/${agentId}/run`. Leave it out when the server has just one. The
   * server still decides which agents it serves.
   */
  agentId?: string;
}

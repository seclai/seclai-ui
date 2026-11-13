import { Seclai, SeclaiApiVersion, type ApiVersion } from "@seclai/sdk";
import { json, jsonError, toErrorResponse } from "./errors";
import { createRunObserver, type RunEndCallback, type RunEventCallback } from "./run-callbacks";
import { relayRunEvents, SSE_HEADERS } from "./sse";

/**
 * From this version uploads are `ready` at once and a run's `output` is plain
 * text with files in `attachments`. The handlers rely on both.
 */
export const MIN_API_VERSION = SeclaiApiVersion.V2026_10_16;

/**
 * A dated constant, not `SeclaiApiVersion.Latest`, which moves with SDK upgrades
 * and could change response shapes underneath a deployed app.
 */
export const DEFAULT_API_VERSION = SeclaiApiVersion.V2026_10_28;

/**
 * The SDK's default is 60s, which would kill ordinary runs. The API ends its own
 * stream with a `timeout` event at 600s, so this leaves room for that to arrive.
 */
const DEFAULT_RUN_TIMEOUT_MS = 11 * 60 * 1000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** An attachment `id`, or the URL-safe-base64 storage key that webhooks carry. */
const ATTACHMENT_ID = /^[A-Za-z0-9_-]+={0,2}$/;
/** The API's limit on `download_name`. */
const MAX_DOWNLOAD_NAME_LENGTH = 255;

export interface SeclaiHandlersOptions {
  /** Seclai API key. Server-side only: never expose it to the browser. */
  apiKey: string;
  /** The agent these handlers run. */
  agentId: string;
  /** Dated API version. Must be {@link MIN_API_VERSION} or later. */
  apiVersion?: ApiVersion;
  /** How long a streaming run may take, in milliseconds. Defaults to 11 minutes. */
  runTimeoutMs?: number;
  /**
   * Called with each event of a run stream, in order, and awaited before the
   * event is relayed to the browser. If it throws, the stream ends with an
   * `error` event.
   */
  onEvent?: RunEventCallback;
  /**
   * Called exactly once for each run that started streaming, with how it ended.
   * Awaited before the final `done`, `error` or `timeout` event is relayed, so
   * whatever it stores is in place when the browser sees the run end. If it
   * throws, the browser gets an `error` event instead.
   */
  onRunEnd?: RunEndCallback;
}

/** JSON body accepted by the `run` handler. */
export interface RunRequestBody {
  /** The prompt text. */
  input?: string;
  /** Ids returned by the `upload` handler, sent together with `input`. */
  uploadIds?: string[];
  /** Keys a conversation: sent to the agent as `metadata.session_id`. */
  sessionId?: string;
}

export type SeclaiHandler = (req: Request) => Promise<Response>;

export interface SeclaiHandlers {
  /** `GET`: which files the agent accepts. */
  attachmentReferences: SeclaiHandler;
  /** `POST` multipart form data with a `file` field: returns the upload's `id`. */
  upload: SeclaiHandler;
  /** `POST` a {@link RunRequestBody}: returns the run as a server-sent event stream. */
  run: SeclaiHandler;
  /** `GET ?runId=&attachmentId=&name=`: streams a file from a run. */
  download: SeclaiHandler;
  /**
   * All four in one, for a single catch-all route: picks the handler from the
   * last segment of the URL path (`attachment-references`, `upload`, `run` or
   * `download`) and returns a 404 for anything else.
   */
  handle: SeclaiHandler;
}

/** The last path segment each handler answers to in {@link SeclaiHandlers.handle}. */
const ROUTES = {
  "attachment-references": "attachmentReferences",
  upload: "upload",
  run: "run",
  download: "download",
} as const satisfies Record<string, Exclude<keyof SeclaiHandlers, "handle">>;

function wrongMethod(allow: string): Response {
  return jsonError(405, "Method not allowed.", { allow });
}

function parseRunBody(body: unknown): RunRequestBody | string {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return "The request body must be a JSON object.";
  }
  const { input, uploadIds, sessionId } = body as Record<string, unknown>;
  if (input !== undefined && typeof input !== "string") {
    return "`input` must be a string.";
  }
  if (
    uploadIds !== undefined &&
    !(Array.isArray(uploadIds) && uploadIds.every((id) => typeof id === "string"))
  ) {
    return "`uploadIds` must be an array of strings.";
  }
  if (sessionId !== undefined && (typeof sessionId !== "string" || !sessionId)) {
    return "`sessionId` must be a non-empty string.";
  }
  if (!input && !uploadIds?.length) {
    return "Provide `input`, `uploadIds`, or both.";
  }
  return { input, uploadIds, sessionId };
}

/**
 * Create the server handlers for one agent. Each takes a Web `Request` and
 * returns a Web `Response`, so they mount on any runtime with those APIs. Routing
 * is left to the host framework.
 *
 * @throws If `apiKey` or `agentId` is missing, or `apiVersion` is too old.
 */
export function createSeclaiHandlers(options: SeclaiHandlersOptions): SeclaiHandlers {
  const {
    apiKey,
    agentId,
    apiVersion = DEFAULT_API_VERSION,
    runTimeoutMs = DEFAULT_RUN_TIMEOUT_MS,
    onEvent,
    onRunEnd,
  } = options;

  // Without a key the SDK would go looking for credentials in ~/.seclai.
  if (!apiKey) throw new Error("createSeclaiHandlers: `apiKey` is required.");
  if (!agentId) throw new Error("createSeclaiHandlers: `agentId` is required.");
  // Dated versions are YYYY-MM-DD, so they sort as strings.
  if (apiVersion < MIN_API_VERSION) {
    throw new Error(
      `createSeclaiHandlers: \`apiVersion\` must be ${MIN_API_VERSION} or later, got ${apiVersion}.`,
    );
  }

  const client = new Seclai({
    apiKey,
    apiVersion,
    // The SDK calls this as a method. Workers' fetch throws "Illegal invocation"
    // when called with any `this` but the global, so it can't be passed bare.
    fetch: (input, init) => globalThis.fetch(input, init),
  });

  const handlers: Omit<SeclaiHandlers, "handle"> = {
    async attachmentReferences(req) {
      if (req.method !== "GET") return wrongMethod("GET");
      try {
        return json(await client.getAgentAttachmentReferences(agentId));
      } catch (err) {
        return toErrorResponse(err);
      }
    },

    async upload(req) {
      if (req.method !== "POST") return wrongMethod("POST");

      let form: FormData;
      try {
        form = await req.formData();
      } catch {
        return jsonError(400, "The request body must be multipart form data.");
      }
      const file = form.get("file");
      // Not `instanceof File`: Node 18 has no global File.
      if (file === null || typeof file === "string") {
        return jsonError(400, "The form must include a `file` field holding a file.");
      }

      try {
        const upload = await client.uploadAgentInput(agentId, {
          file,
          fileName: file.name,
          mimeType: file.type || undefined,
        });
        return json({
          id: upload.id,
          status: upload.status,
          filename: upload.filename,
          content_type: upload.content_type,
          file_size: upload.file_size,
        });
      } catch (err) {
        return toErrorResponse(err);
      }
    },

    async run(req) {
      if (req.method !== "POST") return wrongMethod("POST");

      let raw: unknown;
      try {
        raw = await req.json();
      } catch {
        return jsonError(400, "The request body must be JSON.");
      }
      const body = parseRunBody(raw);
      if (typeof body === "string") return jsonError(400, body);

      const upstream = new AbortController();
      const abort = () => upstream.abort();
      req.signal?.addEventListener("abort", abort, { once: true });

      const events = client.runStreamingAgent(
        agentId,
        {
          ...(body.input ? { input: body.input } : {}),
          ...(body.uploadIds?.length ? { input_upload_ids: body.uploadIds } : {}),
          ...(body.sessionId ? { metadata: { session_id: body.sessionId } } : {}),
        },
        { timeoutMs: runTimeoutMs, signal: upstream.signal },
      );

      try {
        // A rejected run throws here, before any bytes are committed, so a bad
        // attachment or an empty credit balance can be a real HTTP error.
        const first = await events.next();
        const observer =
          onEvent || onRunEnd
            ? createRunObserver({ onEvent, onRunEnd }, { body, request: req })
            : undefined;
        return new Response(
          relayRunEvents(first.done ? undefined : first.value, events, abort, observer),
          { headers: SSE_HEADERS },
        );
      } catch (err) {
        return toErrorResponse(err);
      }
    },

    async download(req) {
      if (req.method !== "GET") return wrongMethod("GET");

      const params = new URL(req.url).searchParams;
      const runId = params.get("runId") ?? "";
      const attachmentId = params.get("attachmentId") ?? "";
      const name = params.get("name") ?? undefined;

      // The SDK puts these in the request path unencoded, and our key is good for
      // the whole account, so `../` here could reach any other API route.
      if (!UUID.test(runId)) return jsonError(400, "`runId` must be a UUID.");
      if (!ATTACHMENT_ID.test(attachmentId)) {
        return jsonError(400, "`attachmentId` is not valid.");
      }
      if (name !== undefined && name.length > MAX_DOWNLOAD_NAME_LENGTH) {
        return jsonError(400, `\`name\` must be ${MAX_DOWNLOAD_NAME_LENGTH} characters or fewer.`);
      }

      try {
        const upstream = await client.downloadAgentRunAttachment(runId, attachmentId, {
          ...(name ? { downloadName: name } : {}),
          signal: req.signal,
        });

        const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";
        const headers = new Headers({
          "content-type": contentType,
          "cache-control": "private, no-store",
          "x-content-type-options": "nosniff",
        });
        const disposition = upstream.headers.get("content-disposition");
        if (disposition) headers.set("content-disposition", disposition);
        // fetch has already decoded a compressed body, so its length would be wrong.
        const length = upstream.headers.get("content-length");
        if (length && !upstream.headers.has("content-encoding")) {
          headers.set("content-length", length);
        }
        // These bytes are served from the deployer's origin, and an SVG opened
        // directly could run script there. `sandbox` stops that, but it also
        // breaks Chrome's PDF viewer, so PDFs are left out.
        if (!contentType.toLowerCase().startsWith("application/pdf")) {
          headers.set("content-security-policy", "sandbox; default-src 'none'");
        }

        return new Response(upstream.body, { status: upstream.status, headers });
      } catch (err) {
        return toErrorResponse(err);
      }
    },
  };

  return {
    ...handlers,
    async handle(req) {
      const segment = new URL(req.url).pathname.replace(/\/+$/, "").split("/").pop() ?? "";
      const name = Object.hasOwn(ROUTES, segment) ? ROUTES[segment as keyof typeof ROUTES] : undefined;
      if (!name) return jsonError(404, "Not found.");
      return handlers[name](req);
    },
  };
}

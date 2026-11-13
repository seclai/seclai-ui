import {
  Seclai,
  SeclaiApiVersion,
  type AcceptedAttachmentSlot,
  type ApiVersion,
} from "@seclai/sdk";
import { json, jsonError, toErrorResponse } from "./errors";
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

/**
 * How long `upload.checkContentType` reuses the agent's attachment slots. Short,
 * so a slot edited on Seclai takes effect within a minute, but long enough that a
 * burst of uploads makes one lookup.
 */
export const ATTACHMENT_SLOTS_TTL_MS = 60 * 1000;

/**
 * Room for the multipart boundaries, part headers and any other form fields when
 * the body's size is compared with `upload.maxBytes`, so a file just under the
 * limit isn't refused for its envelope.
 */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

/**
 * Read a multipart body, failing with `"too-large"` once more than `limit` bytes
 * have arrived. The bytes are counted as they stream, so a body without a
 * `content-length` is cut off there instead of being buffered whole; erroring the
 * stream also cancels the request's body. The counted bytes are parsed through a
 * `Response`, which takes a stream body on every runtime, where a `Request` would
 * need `duplex: "half"` on Node.
 */
async function readLimitedForm(req: Request, limit: number): Promise<FormData | "too-large"> {
  if (!req.body) return req.formData();
  let received = 0;
  let exceeded = false;
  const counted = req.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        received += chunk.byteLength;
        if (received > limit) {
          exceeded = true;
          controller.error(new Error("The request body is over the size limit."));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
  const headers = new Headers();
  const contentType = req.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  try {
    return await new Response(counted, { headers }).formData();
  } catch (err) {
    if (exceeded) return "too-large";
    throw err;
  }
}

/** What the `upload` handler returns, and what `upload.onUpload` receives. */
export interface UploadResult {
  /** Pass this in `uploadIds` to the `run` handler. */
  id: string;
  status: string;
  filename: string;
  content_type: string;
  file_size: number;
}

/** Checks and a hook for the `upload` handler. All are off by default. */
export interface SeclaiUploadOptions {
  /**
   * Largest file accepted, in bytes. Anything bigger gets a 413 without reaching
   * the API. A request whose `content-length` is too big is refused before its
   * body is read; otherwise the body is counted as it streams and reading stops
   * once it passes the limit plus 64 KB for the multipart envelope.
   */
  maxBytes?: number;
  /**
   * Refuse with a 415, without reaching the API, a file whose type none of the
   * agent's accepted attachment slots allows. A file of unknown type (none, or
   * `application/octet-stream`, which a typeless file arrives as) isn't checked:
   * the API decides. The slots are read with
   * `getAgentAttachmentReferences` and reused for {@link ATTACHMENT_SLOTS_TTL_MS}.
   * An agent with no slots accepts nothing, and a failed lookup refuses the
   * upload.
   *
   * The reused slots belong to this `createSeclaiHandlers` instance. Where the
   * handlers are created per request, as on Cloudflare Workers, every upload makes
   * its own lookup.
   */
  checkContentType?: boolean;
  /**
   * Called after a successful upload, for example to keep a copy of the file or
   * record which session it belongs to. Return a `Response` to send it instead of
   * the default JSON. `req`'s body has already been read. A throw becomes a 500.
   */
  onUpload?(
    file: File,
    result: UploadResult,
    req: Request,
  ): void | Response | Promise<void | Response>;
}

export interface SeclaiHandlersOptions {
  /** Seclai API key. Server-side only: never expose it to the browser. */
  apiKey: string;
  /** The agent these handlers run. */
  agentId: string;
  /** Dated API version. Must be {@link MIN_API_VERSION} or later. */
  apiVersion?: ApiVersion;
  /** How long a streaming run may take, in milliseconds. Defaults to 11 minutes. */
  runTimeoutMs?: number;
  /** Size limit, content-type check and hook for the `upload` handler. */
  upload?: SeclaiUploadOptions;
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
 * What a file of unknown type arrives as: no type, or the generic type multipart
 * encoding gives a part whose `File` had none.
 */
const UNKNOWN_TYPES = new Set(["", "application/octet-stream"]);

/** A MIME type without parameters, lowercased: `Text/Plain; charset=x` is `text/plain`. */
function essence(type: string): string {
  return type.split(";")[0]!.trim().toLowerCase();
}

/**
 * Whether a slot takes a file of this (non-empty) type. Slot patterns are exact
 * types or `type/*`, and a slot without any accepts every type.
 */
function slotAllows(slot: AcceptedAttachmentSlot, type: string): boolean {
  const patterns = slot.content_types ?? [];
  if (patterns.length === 0) return true;
  return patterns.some((raw) => {
    const pattern = essence(raw);
    if (pattern === "*" || pattern === "*/*") return true;
    if (pattern.endsWith("/*")) return type.startsWith(pattern.slice(0, -1));
    return pattern === type;
  });
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
    upload: uploadOptions = {},
  } = options;
  const { maxBytes, checkContentType = false, onUpload } = uploadOptions;

  // Without a key the SDK would go looking for credentials in ~/.seclai.
  if (!apiKey) throw new Error("createSeclaiHandlers: `apiKey` is required.");
  if (!agentId) throw new Error("createSeclaiHandlers: `agentId` is required.");
  // Dated versions are YYYY-MM-DD, so they sort as strings.
  if (apiVersion < MIN_API_VERSION) {
    throw new Error(
      `createSeclaiHandlers: \`apiVersion\` must be ${MIN_API_VERSION} or later, got ${apiVersion}.`,
    );
  }
  if (maxBytes !== undefined && !(Number.isFinite(maxBytes) && maxBytes > 0)) {
    throw new Error("createSeclaiHandlers: `upload.maxBytes` must be a positive number.");
  }

  const client = new Seclai({
    apiKey,
    apiVersion,
    // The SDK calls this as a method. Workers' fetch throws "Illegal invocation"
    // when called with any `this` but the global, so it can't be passed bare.
    fetch: (input, init) => globalThis.fetch(input, init),
  });

  // One lookup in flight at a time, shared by concurrent uploads. A failure isn't
  // kept, so the next upload tries again.
  let slots: { promise: Promise<AcceptedAttachmentSlot[]>; expires: number } | undefined;
  function attachmentSlots(): Promise<AcceptedAttachmentSlot[]> {
    if (!slots || Date.now() >= slots.expires) {
      const entry = {
        promise: client
          .getAgentAttachmentReferences(agentId)
          .then((refs) => refs.accepted_attachments ?? []),
        expires: Date.now() + ATTACHMENT_SLOTS_TTL_MS,
      };
      entry.promise.catch(() => {
        if (slots === entry) slots = undefined;
      });
      slots = entry;
    }
    return slots.promise;
  }

  const tooLarge = () =>
    jsonError(413, `The file is larger than the ${maxBytes}-byte limit.`);

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

      // Refuse an oversized body before reading it when its length is declared.
      // Without `content-length`, the body is counted as it streams instead, and
      // the file's own size is checked once the form is read.
      const bodyLimit = maxBytes === undefined ? undefined : maxBytes + MULTIPART_OVERHEAD_BYTES;
      if (bodyLimit !== undefined) {
        const length = Number(req.headers.get("content-length"));
        if (length > bodyLimit) return tooLarge();
      }

      let form: FormData;
      try {
        const read = bodyLimit === undefined ? await req.formData() : await readLimitedForm(req, bodyLimit);
        if (read === "too-large") return tooLarge();
        form = read;
      } catch {
        return jsonError(400, "The request body must be multipart form data.");
      }
      const file = form.get("file");
      // Not `instanceof File`: Node 18 has no global File.
      if (file === null || typeof file === "string") {
        return jsonError(400, "The form must include a `file` field holding a file.");
      }
      if (maxBytes !== undefined && file.size > maxBytes) return tooLarge();

      let result: UploadResult;
      try {
        // An unknown type isn't a wrong one: browsers give none to `.md`, some
        // `.csv` files or HEIC on Windows, and multipart encoding then labels the
        // part `application/octet-stream`. Those go on and the API decides.
        const type = essence(file.type);
        if (checkContentType && !UNKNOWN_TYPES.has(type)) {
          const accepted = await attachmentSlots();
          if (!accepted.some((slot) => slotAllows(slot, type))) {
            return jsonError(415, `This agent does not accept files of type ${type}.`);
          }
        }

        const upload = await client.uploadAgentInput(agentId, {
          file,
          fileName: file.name,
          mimeType: file.type || undefined,
        });
        result = {
          id: upload.id,
          status: upload.status,
          filename: upload.filename,
          content_type: upload.content_type,
          file_size: upload.file_size,
        };
      } catch (err) {
        return toErrorResponse(err);
      }

      if (onUpload) {
        try {
          const replacement = await onUpload(file, result, req);
          if (replacement instanceof Response) return replacement;
        } catch {
          // The app's own error: its message could hold anything, so it stays here.
          return jsonError(500, "The server failed to finish handling the upload.");
        }
      }
      return json(result);
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
        return new Response(
          relayRunEvents(first.done ? undefined : first.value, events, abort),
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

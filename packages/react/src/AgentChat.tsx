import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import {
  acceptAttribute,
  acceptsType,
  messageFileLimits,
  useAcceptedAttachments,
} from "./attachments";
import { createEndpoints, uploadFile } from "./endpoints";
import { MarkdownContent } from "./placeholders/MarkdownContent";
import { MediaPreview } from "./placeholders/MediaPreview";
import type { AgentAttachment, AgentEndpointOptions } from "./types";
import { useAgentRun } from "./useAgentRun";

/** A named attach button, such as "+ Headshot". */
export interface AgentChatAttachButton {
  label: string;
  /** Stays with every file added through this button. See `onBeforeSend`. */
  tag?: string;
}

/** A file the user sent with a message. */
export interface AgentChatFile {
  uploadId: string;
  name: string;
  contentType: string;
  /** The tag of the attach button it was added with. Dropped and pasted files have none. */
  tag?: string;
}

/** What `onBeforeSend` gets: the typed text and the files going with it. */
export interface AgentChatMessage {
  input: string;
  files: AgentChatFile[];
}

export interface AgentChatProps extends AgentEndpointOptions {
  /** Placeholder for the message box. */
  placeholder?: string;
  /**
   * Named attach buttons, for agents that take files. Without them the chat shows
   * one "Attach" button, and only when the agent accepts files.
   */
  attachButtons?: AgentChatAttachButton[];
  /**
   * Called as a message is sent. Return a string to send that as the run's input
   * in place of the typed text, for example to tell the agent which file is which
   * from their tags. The transcript still shows what the user typed.
   */
  onBeforeSend?(message: AgentChatMessage): string | void;
}

interface ChatTurn {
  id: number;
  role: "user" | "assistant";
  text: string;
  /** Files the user sent. Plain data, so a turn can be saved and restored. */
  files?: AgentChatFile[];
  /** Files the agent produced. */
  attachments?: AgentAttachment[];
  error?: string | null;
  cancelled?: boolean;
}

interface PendingFile {
  localId: string;
  name: string;
  contentType: string;
  tag?: string;
  /** An object URL for an image thumbnail. */
  preview: string | null;
  status: "uploading" | "ready" | "error";
  uploadId?: string;
  error?: string;
}

function createSessionId(): string {
  // randomUUID only exists in secure contexts, so plain-http hosts need the fallback.
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

// Only needs to be unique within the page.
let nextLocalId = 0;

function createPreview(file: File): string | null {
  if (!file.type.startsWith("image/") || typeof URL.createObjectURL !== "function") return null;
  return URL.createObjectURL(file);
}

function revoke(url: string | null | undefined) {
  if (url && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(url);
}

function hasFiles(dataTransfer: DataTransfer | null): boolean {
  return !!dataTransfer && Array.from(dataTransfer.types ?? []).includes("Files");
}

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

interface FileChipProps {
  name: string;
  tag?: string;
  preview?: string | null;
  status?: PendingFile["status"];
  error?: string;
  onRemove?(): void;
}

function FileChip({ name, tag, preview, status, error, onRemove }: FileChipProps) {
  const meta = status === "uploading" ? "Uploading…" : status === "error" ? error : tag;
  return (
    <li className="seclai-file" data-status={status}>
      {preview && <img className="seclai-file-thumb" src={preview} alt="" />}
      <span className="seclai-file-text">
        <span className="seclai-file-name" title={name}>
          {name}
        </span>
        {meta && <span className="seclai-file-meta">{meta}</span>}
      </span>
      {onRemove && (
        <button
          type="button"
          className="seclai-file-remove"
          aria-label={`Remove ${name}`}
          onClick={onRemove}
        >
          ×
        </button>
      )}
    </li>
  );
}

function Turn({ turn, previews }: { turn: ChatTurn; previews: Map<string, string> }) {
  return (
    <li className={`seclai-turn seclai-turn-${turn.role}`}>
      {turn.files && turn.files.length > 0 && (
        <ul className="seclai-files" aria-label="Attached files">
          {turn.files.map((file) => (
            <FileChip
              key={file.uploadId}
              name={file.name}
              tag={file.tag}
              preview={previews.get(file.uploadId)}
            />
          ))}
        </ul>
      )}
      {turn.text && <MarkdownContent content={turn.text} />}
      {turn.attachments?.map((attachment) => (
        <MediaPreview key={attachment.id} attachment={attachment} />
      ))}
      {turn.error && (
        <p className="seclai-error" role="alert">
          {turn.error}
        </p>
      )}
      {turn.cancelled && <p className="seclai-notice">Stopped.</p>}
    </li>
  );
}

/**
 * A label wrapping a visually hidden file input, so the browser opens the picker
 * itself. Some browsers ignore scripted clicks on a `display: none` input, and a
 * label also works before hydration.
 */
function AttachControl({
  label,
  accept,
  multiple,
  disabled,
  onFiles,
}: {
  label: string;
  accept?: string;
  multiple: boolean;
  disabled: boolean;
  onFiles(files: File[]): void;
}) {
  return (
    <label className="seclai-button seclai-attach" aria-disabled={disabled || undefined}>
      {label}
      <input
        type="file"
        className="seclai-sr-only"
        accept={accept}
        multiple={multiple}
        disabled={disabled}
        onChange={(e) => {
          const picked = Array.from(e.target.files ?? []);
          // Lets the same file be picked again after it's removed.
          e.target.value = "";
          if (picked.length) onFiles(picked);
        }}
      />
    </label>
  );
}

/**
 * A multi-turn chat. Each message is its own run, and the agent ties them into a
 * conversation through the session id in the run's metadata. When the agent
 * accepts files they can be attached, dropped or pasted, and each one uploads
 * as soon as it's added.
 */
export function AgentChat({
  basePath,
  agentId,
  placeholder = "Send a message",
  attachButtons,
  onBeforeSend,
}: AgentChatProps) {
  const endpoints = useMemo(() => createEndpoints({ basePath, agentId }), [basePath, agentId]);
  const run = useAgentRun({ basePath, agentId });
  // A chat still works if this fails; it just can't take files.
  const { slots } = useAcceptedAttachments(endpoints);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [message, setMessage] = useState("");
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const sessionId = useRef<string | null>(null);
  const nextTurnId = useRef(0);
  // Thumbnails of sent images by upload id, kept out of the turns so they stay plain data.
  const sentPreviews = useRef(new Map<string, string>());
  const pendingPreviews = useRef(new Set<string>());

  useEffect(
    () => () => {
      pendingPreviews.current.forEach(revoke);
      sentPreviews.current.forEach(revoke);
    },
    [],
  );

  const limits = slots?.length ? messageFileLimits(slots) : null;
  const acceptsFiles = !!limits && (limits.max == null || limits.max > 0);

  const running = run.status === "running";
  const uploading = files.some((f) => f.status === "uploading");
  const ready = files.filter((f) => f.status === "ready" && f.uploadId);
  // Failed uploads don't count toward the limit, since they won't be sent.
  const room = limits?.max == null ? Infinity : limits.max - files.filter((f) => f.status !== "error").length;
  const canSend = !running && !uploading && (!!message.trim() || ready.length > 0);

  function setFile(localId: string, patch: Partial<PendingFile>) {
    setFiles((prev) => prev.map((f) => (f.localId === localId ? { ...f, ...patch } : f)));
  }

  function upload(item: PendingFile, file: File) {
    uploadFile(endpoints, file).then(
      (result) => setFile(item.localId, { status: "ready", uploadId: result.id }),
      (err: unknown) =>
        setFile(item.localId, {
          status: "error",
          error: err instanceof Error ? err.message : "The upload failed.",
        }),
    );
  }

  function addFiles(incoming: File[], tag?: string) {
    if (!acceptsFiles || !limits || incoming.length === 0) return;
    const problems: string[] = [];
    const added: [PendingFile, File][] = [];
    let left = room;
    let tooMany = false;

    for (const file of incoming) {
      if (!acceptsType(limits.contentTypes, file.type)) {
        problems.push(`${file.name} isn't a type of file this agent accepts.`);
        continue;
      }
      if (left <= 0) {
        tooMany = true;
        continue;
      }
      left--;
      const preview = createPreview(file);
      if (preview) pendingPreviews.current.add(preview);
      added.push([
        {
          localId: `file-${++nextLocalId}`,
          name: file.name,
          contentType: file.type,
          tag,
          preview,
          status: "uploading",
        },
        file,
      ]);
    }
    if (tooMany) problems.push(`You can attach up to ${plural(limits.max!, "file")} per message.`);

    setNotice(problems.length ? problems.join(" ") : null);
    if (added.length === 0) return;
    setFiles((prev) => [...prev, ...added.map(([item]) => item)]);
    for (const [item, file] of added) upload(item, file);
  }

  function remove(localId: string) {
    const gone = files.find((f) => f.localId === localId);
    if (gone?.preview) {
      revoke(gone.preview);
      pendingPreviews.current.delete(gone.preview);
    }
    setFiles((prev) => prev.filter((f) => f.localId !== localId));
    setNotice(null);
  }

  async function send() {
    if (!canSend) return;
    const text = message.trim();

    const sent: AgentChatFile[] = ready.map((f) => ({
      uploadId: f.uploadId!,
      name: f.name,
      contentType: f.contentType,
      ...(f.tag ? { tag: f.tag } : {}),
    }));
    const override = onBeforeSend?.({ input: text, files: sent });
    const input = (typeof override === "string" ? override : text) || undefined;

    // Sent thumbnails move to the transcript. Failed uploads are dropped.
    for (const f of files) {
      if (!f.preview) continue;
      pendingPreviews.current.delete(f.preview);
      if (f.status === "ready" && f.uploadId) sentPreviews.current.set(f.uploadId, f.preview);
      else revoke(f.preview);
    }

    // Created on first send, not during render, so server and client markup match.
    sessionId.current ??= createSessionId();
    setMessage("");
    setFiles([]);
    setNotice(null);
    setTurns((prev) => [
      ...prev,
      { id: nextTurnId.current++, role: "user", text, ...(sent.length ? { files: sent } : {}) },
    ]);

    const result = await run.start({
      input,
      uploadIds: sent.length ? sent.map((f) => f.uploadId) : undefined,
      sessionId: sessionId.current,
    });

    setTurns((prev) => [
      ...prev,
      {
        id: nextTurnId.current++,
        role: "assistant",
        text: result.text,
        attachments: result.attachments,
        error: result.error,
        cancelled: result.status === "cancelled",
      },
    ]);
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void send();
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  }

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const data = event.clipboardData;
    const pasted = Array.from(data?.files ?? []);
    if (pasted.length === 0) return;
    // Apps such as Excel and Word put an image rendering next to the text. When
    // there's text, paste it as text and leave the files alone.
    if (data.getData("text/plain")) return;
    event.preventDefault();
    addFiles(pasted);
  }

  const dropHandlers = acceptsFiles
    ? {
        onDragOver(event: DragEvent<HTMLFormElement>) {
          if (!hasFiles(event.dataTransfer)) return;
          event.preventDefault();
          setDragging(true);
        },
        onDragLeave(event: DragEvent<HTMLFormElement>) {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
        },
        onDrop(event: DragEvent<HTMLFormElement>) {
          if (!hasFiles(event.dataTransfer)) return;
          event.preventDefault();
          setDragging(false);
          addFiles(Array.from(event.dataTransfer.files));
        },
      }
    : {};

  const buttons = attachButtons?.length ? attachButtons : [{ label: "Attach" }];

  return (
    <div className="seclai-agent seclai-chat">
      <ul className="seclai-turns" aria-live="polite" aria-busy={running}>
        {turns.map((turn) => (
          <Turn key={turn.id} turn={turn} previews={sentPreviews.current} />
        ))}
        {running && (
          <li className="seclai-turn seclai-turn-assistant">
            {run.text ? (
              <MarkdownContent content={run.text} />
            ) : (
              <p className="seclai-notice">Thinking…</p>
            )}
          </li>
        )}
      </ul>

      <form
        className={dragging ? "seclai-form seclai-dropping" : "seclai-form"}
        onSubmit={onSubmit}
        {...dropHandlers}
      >
        {files.length > 0 && (
          <ul className="seclai-files" aria-label="Files to send">
            {files.map((f) => (
              <FileChip
                key={f.localId}
                name={f.name}
                tag={f.tag}
                preview={f.preview}
                status={f.status}
                error={f.error}
                onRemove={() => remove(f.localId)}
              />
            ))}
          </ul>
        )}
        <textarea
          rows={2}
          aria-label="Message"
          placeholder={placeholder}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={acceptsFiles ? onPaste : undefined}
        />
        {notice && (
          <p className="seclai-error" role="alert">
            {notice}
          </p>
        )}
        <div className="seclai-actions">
          {acceptsFiles &&
            buttons.map((button) => (
              <AttachControl
                key={`${button.label}\u0000${button.tag ?? ""}`}
                label={button.label}
                accept={acceptAttribute(limits!.contentTypes)}
                multiple={room > 1}
                disabled={room <= 0}
                onFiles={(picked) => addFiles(picked, button.tag)}
              />
            ))}
          <button type="submit" className="seclai-button seclai-button-primary" disabled={!canSend}>
            Send
          </button>
          {running && (
            <button type="button" className="seclai-button" onClick={run.cancel}>
              Stop
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

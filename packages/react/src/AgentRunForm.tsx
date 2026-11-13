import { useMemo, useState, type FormEvent } from "react";
import { acceptAttribute, useAcceptedAttachments } from "./attachments";
import { createEndpoints, uploadFile } from "./endpoints";
import { MarkdownContent } from "./placeholders/MarkdownContent";
import { MediaPreview } from "./placeholders/MediaPreview";
import type { AcceptedAttachmentSlot, AgentEndpointOptions } from "./types";
import { useAgentRun, type AgentRunState } from "./useAgentRun";

export interface AgentRunFormProps extends AgentEndpointOptions {
  /** Label for the text input. */
  inputLabel?: string;
  /** Called when a run finishes, whether it succeeded or not. */
  onFinish?(result: AgentRunState): void;
}

function slotProblem(slot: AcceptedAttachmentSlot, count: number): string | null {
  const label = slot.label ?? slot.name;
  const min = slot.min ?? 0;
  if (count < min) return `${label} needs at least ${min} file${min === 1 ? "" : "s"}.`;
  if (slot.max != null && count > slot.max) {
    return `${label} takes at most ${slot.max} file${slot.max === 1 ? "" : "s"}.`;
  }
  return null;
}

/**
 * A form built from what the agent accepts: a text input plus one file input per
 * declared attachment. It uploads the files, then runs with text and files
 * together and shows the output.
 */
export function AgentRunForm({ basePath, agentId, inputLabel = "Input", onFinish }: AgentRunFormProps) {
  const endpoints = useMemo(() => createEndpoints({ basePath, agentId }), [basePath, agentId]);
  const run = useAgentRun({ basePath, agentId });

  const { slots, error: loadError } = useAcceptedAttachments(endpoints);
  const [input, setInput] = useState("");
  const [files, setFiles] = useState<Record<string, File[]>>({});
  const [uploading, setUploading] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const selected = Object.values(files).flat();
  const busy = uploading || run.status === "running";

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !slots) return;

    const problem = slots
      .map((slot) => slotProblem(slot, files[slot.name]?.length ?? 0))
      .find(Boolean);
    if (problem) {
      setFormError(problem);
      return;
    }
    if (!input.trim() && selected.length === 0) {
      setFormError("Enter some text or choose a file.");
      return;
    }

    setFormError(null);
    setUploading(true);
    let uploadIds: string[];
    try {
      const uploads = await Promise.all(selected.map((file) => uploadFile(endpoints, file)));
      uploadIds = uploads.map((upload) => upload.id);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "The upload failed.");
      return;
    } finally {
      setUploading(false);
    }

    const result = await run.start({
      input: input.trim() || undefined,
      uploadIds: uploadIds.length ? uploadIds : undefined,
    });
    onFinish?.(result);
  }

  if (loadError) {
    return (
      <div className="seclai-agent">
        <p className="seclai-error" role="alert">
          {loadError}
        </p>
      </div>
    );
  }
  if (!slots) {
    return (
      <div className="seclai-agent">
        <p className="seclai-notice">Loading…</p>
        <div className="seclai-skeleton" aria-hidden="true">
          <span />
          <span />
        </div>
      </div>
    );
  }

  const error = formError ?? run.error;

  return (
    <div className="seclai-agent">
      <form className="seclai-form" onSubmit={submit}>
        <label className="seclai-field">
          <span>{inputLabel}</span>
          <textarea rows={4} value={input} onChange={(e) => setInput(e.target.value)} />
        </label>

        {slots.map((slot) => (
          <label className="seclai-field" key={slot.name}>
            <span>
              {slot.label ?? slot.name}
              {(slot.min ?? 0) > 0 ? " (required)" : ""}
            </span>
            <input
              type="file"
              name={slot.name}
              accept={acceptAttribute(slot.content_types)}
              multiple={slot.max == null || slot.max > 1}
              onChange={(e) =>
                setFiles((prev) => ({ ...prev, [slot.name]: Array.from(e.target.files ?? []) }))
              }
            />
          </label>
        ))}

        <div className="seclai-actions">
          <button type="submit" className="seclai-button seclai-button-primary" disabled={busy}>
            {uploading ? "Uploading…" : "Run"}
          </button>
          {run.status === "running" && (
            <button type="button" className="seclai-button" onClick={run.cancel}>
              Stop
            </button>
          )}
        </div>
      </form>

      {run.steps.length > 0 && (
        <ul className="seclai-steps">
          {run.steps.map((step) => (
            <li key={step.id}>
              {step.name}: {step.message}
            </li>
          ))}
        </ul>
      )}

      {error && (
        <p className="seclai-error" role="alert">
          {error}
        </p>
      )}

      {run.status === "cancelled" && <p className="seclai-notice">Stopped.</p>}

      {(run.text || run.attachments.length > 0) && (
        <div className="seclai-output" aria-live="polite" aria-busy={run.status === "running"}>
          {run.text && <MarkdownContent content={run.text} />}
          {run.attachments.map((attachment) => (
            <MediaPreview key={attachment.id} attachment={attachment} />
          ))}
        </div>
      )}
    </div>
  );
}

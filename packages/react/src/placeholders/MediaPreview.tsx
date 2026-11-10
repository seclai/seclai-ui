import type { AgentAttachment } from "../types";

// Placeholder, to be ported from the MediaPreview component in the main Seclai
// app, which handles image, audio, video, PDF and a download fallback. Port it
// rather than rebuilding it here.

export interface MediaPreviewProps {
  attachment: AgentAttachment;
}

/**
 * Shows a file from a run. For now images show inline and everything else is a
 * download link. Audio, video and PDF previews are coming in a later version.
 */
export function MediaPreview({ attachment }: MediaPreviewProps) {
  const name = attachment.name ?? attachment.id;
  return (
    <figure className="seclai-media">
      {attachment.mime.startsWith("image/") && <img src={attachment.url} alt={name} />}
      <figcaption>
        <a href={attachment.url} download={name}>
          {name}
        </a>
      </figcaption>
    </figure>
  );
}

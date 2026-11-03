import type { AgentAttachment } from "../types";

/**
 * PLACEHOLDER: port from seclai/frontend/app/components/MediaPreview.tsx, which
 * handles image, audio, video, PDF and a download fallback. Don't rebuild it here.
 *
 * Until then images show inline, so image output can be checked by eye, and
 * everything else is a download link.
 */
export interface MediaPreviewProps {
  attachment: AgentAttachment;
}

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

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { attachmentFileName, isImage } from "../media/files";
import type { AgentAttachment } from "../types";

// Images are done. Audio, video and PDF are still to be ported from the
// MediaPreview component in the main Seclai app, and until then they get the
// download-link fallback. Port them rather than rebuilding them here.

/** A CSS aspect ratio: a number such as `16 / 9`, or a string such as `"16 / 9"`. */
export type MediaAspectRatio = number | string;

export interface MediaPreviewProps {
  attachment: AgentAttachment;
  /**
   * The image frame's aspect ratio. Without it the frame takes the image's own
   * ratio once it loads, and `--seclai-media-aspect-ratio` (square by default)
   * until then.
   */
  aspectRatio?: MediaAspectRatio;
  /** A badge on the image, matching the agent's numbered list ("1.", "2."). */
  number?: number;
  /** App-specific buttons, shown after the download link. A function gets the attachment. */
  actions?: ReactNode | ((attachment: AgentAttachment) => ReactNode);
  /** Makes the image a button, for opening a full-size viewer. */
  onOpen?(): void;
}

function hasContent(node: ReactNode): boolean {
  return node != null && node !== false && node !== "";
}

export function aspectRatioStyle(ratio: MediaAspectRatio | undefined): CSSProperties | undefined {
  return ratio == null ? undefined : { aspectRatio: String(ratio) };
}

/** A short accessible name for an image: its filename, or else its number. */
export function imageLabel(attachment: AgentAttachment, number?: number): string {
  return attachment.name ?? (number != null ? `Image ${number}` : "Image");
}

/**
 * Shows a file from a run. An image gets a card with a fixed-ratio frame and a
 * download link. Anything else is a download link for now: audio, video and PDF
 * previews are coming in a later version.
 */
export function MediaPreview({ attachment, aspectRatio, number, actions, onOpen }: MediaPreviewProps) {
  const filename = attachmentFileName(attachment, number);
  const extra = typeof actions === "function" ? actions(attachment) : actions;

  if (!isImage(attachment)) {
    return (
      <figure className="seclai-media">
        <figcaption>
          <a href={attachment.url} download={filename}>
            {attachment.name ?? filename}
          </a>
          {hasContent(extra) && <span className="seclai-media-actions">{extra}</span>}
        </figcaption>
      </figure>
    );
  }

  return (
    <ImageCard
      attachment={attachment}
      aspectRatio={aspectRatio}
      number={number}
      filename={filename}
      extra={extra}
      onOpen={onOpen}
    />
  );
}

interface ImageCardProps extends Omit<MediaPreviewProps, "actions"> {
  filename: string;
  extra: ReactNode;
}

function ImageCard({ attachment, aspectRatio, number, filename, extra, onOpen }: ImageCardProps) {
  const img = useRef<HTMLImageElement>(null);
  const [natural, setNatural] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const label = imageLabel(attachment, number);

  function measure() {
    const el = img.current;
    if (el && el.naturalWidth > 0 && el.naturalHeight > 0) {
      setNatural(`${el.naturalWidth} / ${el.naturalHeight}`);
    }
  }

  useEffect(() => {
    setNatural(null);
    setFailed(false);
    // A cached image can finish loading, or fail, before React attaches onLoad
    // and onError, as when server-rendered markup hydrates. A complete image
    // with no width is one that failed.
    const el = img.current;
    if (el?.complete) {
      if (el.naturalWidth === 0) setFailed(true);
      else measure();
    }
  }, [attachment.url]);

  const frameContent = (
    <>
      {failed ? (
        <span className="seclai-media-error">Couldn't load the image.</span>
      ) : (
        <img
          ref={img}
          src={attachment.url}
          alt={label}
          loading="lazy"
          decoding="async"
          onLoad={measure}
          onError={() => setFailed(true)}
        />
      )}
      {number != null && <span className="seclai-media-badge">{number}</span>}
    </>
  );
  const frameStyle = aspectRatioStyle(aspectRatio ?? natural ?? undefined);

  return (
    <figure className="seclai-media seclai-media-image">
      {onOpen ? (
        <button
          type="button"
          className="seclai-media-frame"
          style={frameStyle}
          aria-label={`Open ${label} full size`}
          aria-haspopup="dialog"
          onClick={onOpen}
        >
          {frameContent}
        </button>
      ) : (
        <div className="seclai-media-frame" style={frameStyle}>
          {frameContent}
        </div>
      )}
      <figcaption className="seclai-media-bar">
        <a href={attachment.url} download={filename} aria-label={`Download ${label}`}>
          Download
        </a>
        {hasContent(extra) && <span className="seclai-media-actions">{extra}</span>}
      </figcaption>
    </figure>
  );
}

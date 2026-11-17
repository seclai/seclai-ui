import { useEffect, useRef, useState, type ReactNode } from "react";
import { MediaPreview, type MediaAspectRatio } from "../placeholders/MediaPreview";
import type { AgentAttachment } from "../types";
import { attachmentFileName, downloadSequentially, isImage } from "./files";
import { MediaSkeleton } from "./MediaSkeleton";
import { MediaViewer } from "./MediaViewer";

/** How long "Download all" waits between files, so the browser doesn't block them. */
export const DOWNLOAD_ALL_DELAY_MS = 400;

export interface MediaGalleryProps {
  /** A run's attachments. Images become numbered cards; other files follow as download links. */
  attachments: AgentAttachment[];
  /** Every card's aspect ratio. Without it each card takes its image's own ratio. */
  aspectRatio?: MediaAspectRatio;
  /**
   * Skeleton cards to show after the images, for images still being generated.
   * They're numbered on from the last image.
   */
  pending?: number;
  /** App-specific buttons for each card. Gets the attachment and its 1-based number. */
  actions?(attachment: AgentAttachment, number: number): ReactNode;
}

/**
 * Lays out a run's images as numbered cards that open a full-size viewer, with
 * "Download all" when there's more than one. Files that aren't images are shown
 * after them with `MediaPreview`.
 */
export function MediaGallery({
  attachments,
  aspectRatio,
  pending = 0,
  actions,
}: MediaGalleryProps) {
  const images = attachments.filter(isImage);
  const files = attachments.filter((attachment) => !isImage(attachment));
  const [viewing, setViewing] = useState<number | null>(null);
  const [downloading, setDownloading] = useState(false);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => () => abort.current?.abort(), []);

  // The image being viewed went away, as when the attachments are replaced.
  if (viewing != null && viewing >= images.length) setViewing(null);

  async function downloadAll() {
    if (downloading) return;
    const controller = new AbortController();
    abort.current = controller;
    setDownloading(true);
    try {
      await downloadSequentially(
        images.map((image, i) => ({ url: image.url, filename: attachmentFileName(image, i + 1) })),
        DOWNLOAD_ALL_DELAY_MS,
        controller.signal,
      );
    } finally {
      if (!controller.signal.aborted) setDownloading(false);
    }
  }

  const skeletons = Math.max(0, Math.floor(pending));

  return (
    <div className="seclai-gallery">
      {images.length + skeletons > 0 && (
        <ul className="seclai-gallery-grid">
          {images.map((image, i) => (
            <li key={image.id}>
              <MediaPreview
                attachment={image}
                aspectRatio={aspectRatio}
                number={i + 1}
                actions={actions?.(image, i + 1)}
                onOpen={() => setViewing(i)}
              />
            </li>
          ))}
          {Array.from({ length: skeletons }, (_, i) => (
            <li key={`pending-${i}`}>
              <MediaSkeleton aspectRatio={aspectRatio} number={images.length + i + 1} />
            </li>
          ))}
        </ul>
      )}

      {images.length > 1 && (
        <div className="seclai-gallery-actions">
          {/* aria-disabled rather than disabled, so a keyboard user's focus stays put. */}
          <button
            type="button"
            className="seclai-button"
            aria-disabled={downloading}
            onClick={downloadAll}
          >
            {downloading ? "Downloading…" : `Download all ${images.length}`}
          </button>
        </div>
      )}

      {files.map((file) => (
        <MediaPreview key={file.id} attachment={file} />
      ))}

      {images.length > 0 && (
        <MediaViewer
          attachments={images}
          index={viewing}
          onIndexChange={setViewing}
          onClose={() => setViewing(null)}
        />
      )}
    </div>
  );
}

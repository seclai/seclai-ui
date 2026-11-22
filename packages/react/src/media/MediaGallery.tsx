import { useEffect, useRef, useState, type ReactNode } from "react";
import type { AgentAttachment } from "../types";
import { attachmentFileName, isImage, mediaKind, SAVE_FILES_DELAY_MS, saveFiles } from "./files";
import { MediaPreview, type MediaAspectRatio } from "./MediaPreview";
import { MediaSkeleton } from "./MediaSkeleton";
import { MediaViewer } from "./MediaViewer";

/** How long "Download all" waits between files, so the browser doesn't block them. */
export const DOWNLOAD_ALL_DELAY_MS = SAVE_FILES_DELAY_MS;

export interface MediaGalleryProps {
  /**
   * A run's attachments. Images, audio, video and PDFs become cards, numbered in
   * this order; other files follow as download links.
   */
  attachments: AgentAttachment[];
  /**
   * Every image and video card's aspect ratio. Without it each takes its file's
   * own ratio. Audio and PDF cards keep their own shape.
   */
  aspectRatio?: MediaAspectRatio;
  /**
   * Skeleton cards to show after the cards, for images still being generated.
   * They're numbered on from the last card.
   */
  pending?: number;
  /** App-specific buttons for each card. Gets the attachment and its 1-based number. */
  actions?(attachment: AgentAttachment, number: number): ReactNode;
}

/**
 * Lays out a run's images, audio, video and PDFs as numbered cards, in the
 * attachments' order, so the numbers match the agent's numbered list. Images
 * open a full-size viewer. "Download all" saves every card's file when there's
 * more than one. Other files follow the cards as download links.
 */
export function MediaGallery({
  attachments,
  aspectRatio,
  pending = 0,
  actions,
}: MediaGalleryProps) {
  const cards = attachments.filter((attachment) => mediaKind(attachment) != null);
  const files = attachments.filter((attachment) => mediaKind(attachment) == null);
  // The viewer pages through the images only, keeping their card numbers.
  const images: AgentAttachment[] = [];
  const imageNumbers: number[] = [];
  const viewerIndexes = cards.map((card, i) => {
    if (!isImage(card)) return null;
    imageNumbers.push(i + 1);
    return images.push(card) - 1;
  });
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
      await saveFiles(
        cards.map((card, i) => ({ source: card.url, filename: attachmentFileName(card, i + 1) })),
        { delayMs: DOWNLOAD_ALL_DELAY_MS, signal: controller.signal },
      );
    } finally {
      if (!controller.signal.aborted) setDownloading(false);
    }
  }

  const skeletons = Math.max(0, Math.floor(pending));

  return (
    <div className="seclai-gallery">
      {cards.length + skeletons > 0 && (
        <ul className="seclai-gallery-grid">
          {cards.map((card, i) => {
            const image = viewerIndexes[i];
            return (
              <li key={card.id}>
                <MediaPreview
                  attachment={card}
                  aspectRatio={aspectRatio}
                  number={i + 1}
                  actions={actions?.(card, i + 1)}
                  onOpen={image != null ? () => setViewing(image) : undefined}
                />
              </li>
            );
          })}
          {Array.from({ length: skeletons }, (_, i) => (
            <li key={`pending-${i}`}>
              <MediaSkeleton aspectRatio={aspectRatio} number={cards.length + i + 1} />
            </li>
          ))}
        </ul>
      )}

      {cards.length > 1 && (
        <div className="seclai-gallery-actions">
          {/* aria-disabled rather than disabled, so a keyboard user's focus stays put. */}
          <button
            type="button"
            className="seclai-button"
            aria-disabled={downloading}
            onClick={downloadAll}
          >
            {downloading ? "Downloading…" : `Download all ${cards.length}`}
          </button>
        </div>
      )}

      {files.map((file) => (
        <MediaPreview key={file.id} attachment={file} />
      ))}

      {images.length > 0 && (
        <MediaViewer
          attachments={images}
          numbers={imageNumbers}
          index={viewing}
          onIndexChange={setViewing}
          onClose={() => setViewing(null)}
        />
      )}
    </div>
  );
}

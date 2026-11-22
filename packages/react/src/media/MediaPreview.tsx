import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { AgentAttachment } from "../types";
import { attachmentFileName, mediaKind, type MediaKind } from "./files";

// Ported from the MediaPreview component in the main Seclai app, without its
// Mantine and Tabler dependencies. Images, audio, video and PDFs get a card;
// anything else is a download link.
//
// Every preview loads only `attachment.url`, which the package builds as the
// download handler's own URL. There's no <embed> or <iframe>: a PDF goes in an
// <object> with type="application/pdf", SVG only ever loads in an <img>, where it
// can't run script, and HTML is never previewed. If a "PDF" turns out to be
// something else, the <object> renders what the handler served, and the handler
// serves everything but PDFs with a `sandbox` Content Security Policy.

/** A CSS aspect ratio: a number such as `16 / 9`, or a string such as `"16 / 9"`. */
export type MediaAspectRatio = number | string;

export interface MediaPreviewProps {
  attachment: AgentAttachment;
  /**
   * The image or video frame's aspect ratio. Without it the frame takes the
   * file's own ratio once it loads, and `--seclai-media-aspect-ratio` (square
   * by default) until then. Audio and PDF cards don't use it.
   */
  aspectRatio?: MediaAspectRatio;
  /** A badge on the card, matching the agent's numbered list ("1.", "2."). */
  number?: number;
  /** App-specific buttons, shown after the download link. A function gets the attachment. */
  actions?: ReactNode | ((attachment: AgentAttachment) => ReactNode);
  /** Makes an image a button, for opening a full-size viewer. Other files ignore it. */
  onOpen?(): void;
}

function hasContent(node: ReactNode): boolean {
  return node != null && node !== false && node !== "";
}

export function aspectRatioStyle(ratio: MediaAspectRatio | undefined): CSSProperties | undefined {
  return ratio == null ? undefined : { aspectRatio: String(ratio) };
}

const KIND_LABELS: Record<MediaKind, string> = {
  image: "Image",
  audio: "Audio",
  video: "Video",
  pdf: "PDF",
};

function kindLabel(attachment: AgentAttachment): string {
  const kind = mediaKind(attachment);
  return kind ? KIND_LABELS[kind] : "File";
}

/**
 * A short accessible name for a file: its filename, or else its kind and number
 * ("Image 2", "Audio 3", "PDF 1").
 */
export function mediaLabel(attachment: AgentAttachment, number?: number): string {
  if (attachment.name) return attachment.name;
  const kind = kindLabel(attachment);
  return number != null ? `${kind} ${number}` : kind;
}

/**
 * Shows a file from a run, by its mime type (ignoring case and parameters):
 *
 * - an image in a fixed-ratio frame, which can open a full-size viewer;
 * - audio with the browser's own controls;
 * - video with the browser's own controls, in a frame like an image's;
 * - a PDF in the browser's PDF viewer, or a download link where there isn't one;
 * - anything else as a download link.
 *
 * Every card has a download link, an optional number badge and an `actions`
 * slot. A file that fails to load says so, and keeps its download link.
 */
export function MediaPreview({ attachment, aspectRatio, number, actions, onOpen }: MediaPreviewProps) {
  const filename = attachmentFileName(attachment, number);
  const extra = typeof actions === "function" ? actions(attachment) : actions;
  const card: CardProps = { attachment, number, filename, extra };

  switch (mediaKind(attachment)) {
    case "image":
      return <ImageCard {...card} aspectRatio={aspectRatio} onOpen={onOpen} />;
    case "video":
      return <VideoCard {...card} aspectRatio={aspectRatio} />;
    case "audio":
      return <AudioCard {...card} />;
    case "pdf":
      return <PdfCard {...card} />;
    default:
      return (
        <figure className="seclai-media">
          <figcaption>
            <a href={attachment.url} download={filename}>
              {attachment.name || filename}
            </a>
            {hasContent(extra) && <span className="seclai-media-actions">{extra}</span>}
          </figcaption>
        </figure>
      );
  }
}

interface CardProps {
  attachment: AgentAttachment;
  number?: number;
  filename: string;
  extra: ReactNode;
}

function Badge({ number }: { number?: number }) {
  return number != null ? <span className="seclai-media-badge">{number}</span> : null;
}

/** The card's download link and actions. */
function CardBar({ attachment, number, filename, extra }: CardProps) {
  return (
    <figcaption className="seclai-media-bar">
      <a href={attachment.url} download={filename} aria-label={`Download ${mediaLabel(attachment, number)}`}>
        Download
      </a>
      {hasContent(extra) && <span className="seclai-media-actions">{extra}</span>}
    </figcaption>
  );
}

/** A heading for a card whose file has no picture to put the badge on: the badge and the name. */
function CardHead({ attachment, number }: Pick<CardProps, "attachment" | "number">) {
  return (
    <div className="seclai-media-head">
      <Badge number={number} />
      <span className="seclai-media-title">{attachment.name || kindLabel(attachment)}</span>
    </div>
  );
}

function ImageCard({
  aspectRatio,
  onOpen,
  ...card
}: CardProps & Pick<MediaPreviewProps, "aspectRatio" | "onOpen">) {
  const { attachment, number } = card;
  const img = useRef<HTMLImageElement>(null);
  const [natural, setNatural] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const label = mediaLabel(attachment, number);

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
      <Badge number={number} />
    </>
  );
  const frameStyle = aspectRatioStyle(aspectRatio ?? natural ?? undefined);

  return (
    <figure className="seclai-media seclai-media-card seclai-media-image">
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
      <CardBar {...card} />
    </figure>
  );
}

function VideoCard({ aspectRatio, ...card }: CardProps & Pick<MediaPreviewProps, "aspectRatio">) {
  const { attachment, number } = card;
  const video = useRef<HTMLVideoElement>(null);
  const [natural, setNatural] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  function measure() {
    const el = video.current;
    if (el && el.videoWidth > 0 && el.videoHeight > 0) {
      setNatural(`${el.videoWidth} / ${el.videoHeight}`);
    }
  }

  useEffect(() => {
    setNatural(null);
    setFailed(false);
    // As with images, the video may have failed, or loaded its metadata, before
    // React attached its listeners.
    const el = video.current;
    if (el?.error) setFailed(true);
    else if (el && el.readyState >= HTMLMediaElement.HAVE_METADATA) measure();
  }, [attachment.url]);

  return (
    <figure className="seclai-media seclai-media-card seclai-media-video">
      <div className="seclai-media-frame" style={aspectRatioStyle(aspectRatio ?? natural ?? undefined)}>
        {failed ? (
          <span className="seclai-media-error">Couldn't load the video.</span>
        ) : (
          <video
            ref={video}
            src={attachment.url}
            controls
            preload="metadata"
            playsInline
            aria-label={mediaLabel(attachment, number)}
            onLoadedMetadata={measure}
            onError={() => setFailed(true)}
          />
        )}
        <Badge number={number} />
      </div>
      <CardBar {...card} />
    </figure>
  );
}

function AudioCard(card: CardProps) {
  const { attachment, number } = card;
  const audio = useRef<HTMLAudioElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    // As with images, the audio may have failed before React attached onError.
    setFailed(audio.current?.error != null);
  }, [attachment.url]);

  return (
    <figure className="seclai-media seclai-media-card seclai-media-audio">
      <CardHead attachment={attachment} number={number} />
      <div className="seclai-media-body">
        {failed ? (
          <span className="seclai-media-error">Couldn't load the audio.</span>
        ) : (
          <audio
            ref={audio}
            src={attachment.url}
            controls
            preload="metadata"
            aria-label={mediaLabel(attachment, number)}
            onError={() => setFailed(true)}
          />
        )}
      </div>
      <CardBar {...card} />
    </figure>
  );
}

function PdfCard(card: CardProps) {
  const { attachment, number, filename } = card;
  const object = useRef<HTMLObjectElement>(null);
  const [failed, setFailed] = useState(false);
  const label = mediaLabel(attachment, number);

  useEffect(() => setFailed(false), [attachment.url]);

  // React doesn't pass on an <object>'s error event, so listen for it here. A
  // failure before this runs still shows the fallback content.
  useEffect(() => {
    const el = object.current;
    if (!el) return;
    const fail = () => setFailed(true);
    el.addEventListener("error", fail);
    return () => el.removeEventListener("error", fail);
  }, [attachment.url, failed]);

  return (
    <figure className="seclai-media seclai-media-card seclai-media-pdf">
      <CardHead attachment={attachment} number={number} />
      <div className="seclai-media-frame">
        {failed ? (
          <span className="seclai-media-error">Couldn't load the PDF.</span>
        ) : (
          // Keyed on the URL: browsers don't reliably reload an <object> whose
          // data changes.
          <object
            key={attachment.url}
            ref={object}
            type="application/pdf"
            data={attachment.url}
            aria-label={label}
          >
            {/* Shown by browsers without a PDF viewer, including most mobile ones. */}
            <span className="seclai-media-fallback">
              This browser can't show the PDF here.{" "}
              <a href={attachment.url} download={filename}>
                Download {label}
              </a>
            </span>
          </object>
        )}
      </div>
      <CardBar {...card} />
    </figure>
  );
}

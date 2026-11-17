import { aspectRatioStyle, type MediaAspectRatio } from "../placeholders/MediaPreview";

export interface MediaSkeletonProps {
  /** The frame's aspect ratio. Defaults to `--seclai-media-aspect-ratio`, square unless you set it. */
  aspectRatio?: MediaAspectRatio;
  /** A badge, for the number the image will have once it arrives. */
  number?: number;
  /** What a screen reader hears. Defaults to "Image <number> is being generated". */
  label?: string;
}

/**
 * A placeholder card for an image that hasn't arrived yet, the same shape as a
 * `MediaPreview` card, so the layout doesn't jump when it does. It pulses unless
 * the user prefers reduced motion.
 */
export function MediaSkeleton({ aspectRatio, number, label }: MediaSkeletonProps) {
  const name = label ?? (number != null ? `Image ${number} is being generated` : "Image is being generated");
  return (
    <div className="seclai-media seclai-media-image seclai-media-skeleton" role="img" aria-label={name}>
      <div className="seclai-media-frame" style={aspectRatioStyle(aspectRatio)}>
        {number != null && <span className="seclai-media-badge">{number}</span>}
      </div>
      <div className="seclai-media-bar">
        <span className="seclai-media-skeleton-line" />
      </div>
    </div>
  );
}

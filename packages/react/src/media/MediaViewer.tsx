import { useEffect, useId, useRef, type KeyboardEvent, type MouseEvent, type SyntheticEvent } from "react";
import { imageLabel } from "../placeholders/MediaPreview";
import type { AgentAttachment } from "../types";
import { attachmentFileName } from "./files";

export interface MediaViewerProps {
  /** The images to page through, in order. Image `i` is numbered `i + 1`. */
  attachments: AgentAttachment[];
  /** The image showing, or `null` when the viewer is closed. */
  index: number | null;
  /** Called with the new index when the user goes to the previous or next image. */
  onIndexChange(index: number): void;
  /** Called when the user closes the viewer: Escape, the close button or a click on the backdrop. */
  onClose(): void;
}

/**
 * A full-size image viewer in a modal `<dialog>`, with previous and next (also on
 * the arrow keys) and a download button. It's controlled: pass the `index` to
 * show, and `null` to close it. Focus moves into the viewer when it opens and
 * back to where it was when it closes.
 */
export function MediaViewer({ attachments, index, onIndexChange, onClose }: MediaViewerProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const isOpen = useRef(false);
  const titleId = useId();

  const current = index != null ? attachments[index] : undefined;
  const open = current != null;
  isOpen.current = open;

  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    if (open && !el.open) {
      returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      el.showModal();
      closeButton.current?.focus();
    } else if (!open && el.open) {
      el.close();
      restoreFocus();
    }
  }, [open]);

  // Unmounting while open takes the dialog away, but focus should still go back.
  useEffect(
    () => () => {
      if (isOpen.current) restoreFocus();
    },
    [],
  );

  function restoreFocus() {
    const target = returnFocus.current;
    returnFocus.current = null;
    if (target?.isConnected) target.focus();
  }

  const last = attachments.length - 1;
  const atStart = index == null || index <= 0;
  const atEnd = index == null || index >= last;

  function go(step: -1 | 1) {
    if (index == null) return;
    const next = index + step;
    if (next >= 0 && next <= last) onIndexChange(next);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Escape") return;
    // The viewer is modal, so the keys it handles stop here: one Escape mustn't
    // also close a host app's drawer, nor the arrows move a carousel behind it.
    // React listens at its root, so this also keeps them from native listeners
    // above the root, such as on `document`.
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "ArrowLeft") go(-1);
    else if (event.key === "ArrowRight") go(1);
    // Escape is handled here rather than left to the browser, so the parent's
    // state decides whether the dialog is open.
    else onClose();
  }

  function onCancel(event: SyntheticEvent<HTMLDialogElement>) {
    // Other close requests, such as the Android back gesture.
    event.preventDefault();
    onClose();
  }

  function onDialogClose() {
    // The browser closed it anyway (a cancel can't always be prevented).
    if (isOpen.current) onClose();
  }

  function onClick(event: MouseEvent<HTMLDialogElement>) {
    // The dialog has no padding, so a click on the dialog itself is on the backdrop.
    if (event.target === event.currentTarget) onClose();
  }

  const number = index != null ? index + 1 : 0;
  const label = current ? imageLabel(current, number) : "";

  return (
    <dialog
      ref={dialog}
      className="seclai-viewer"
      aria-labelledby={titleId}
      onKeyDown={onKeyDown}
      onCancel={onCancel}
      onClose={onDialogClose}
      onClick={onClick}
    >
      {current && (
        <div className="seclai-viewer-body">
          <img className="seclai-viewer-image" src={current.url} alt={label} />
          <div className="seclai-viewer-bar">
            <p className="seclai-viewer-title" id={titleId}>
              {label}
              {attachments.length > 1 && (
                <span className="seclai-viewer-count">
                  {number} of {attachments.length}
                </span>
              )}
            </p>
            {attachments.length > 1 && (
              <>
                {/* aria-disabled rather than disabled, so focus stays on the button at either end. */}
                <button
                  type="button"
                  className="seclai-button"
                  aria-disabled={atStart}
                  onClick={() => go(-1)}
                >
                  Previous
                </button>
                <button type="button" className="seclai-button" aria-disabled={atEnd} onClick={() => go(1)}>
                  Next
                </button>
              </>
            )}
            <a
              className="seclai-button seclai-button-primary"
              href={current.url}
              download={attachmentFileName(current, number)}
            >
              Download
            </a>
            <button type="button" className="seclai-button" ref={closeButton} onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      )}
    </dialog>
  );
}

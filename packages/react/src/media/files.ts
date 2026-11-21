import type { AgentAttachment } from "../types";

// Subtypes whose usual file extension isn't the subtype itself.
const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/svg+xml": "svg",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
  "audio/mpeg": "mp3",
  "video/quicktime": "mov",
  "text/plain": "txt",
  "text/markdown": "md",
  "application/octet-stream": "bin",
};

export function isImage(attachment: Pick<AgentAttachment, "mime">): boolean {
  return attachment.mime.toLowerCase().startsWith("image/");
}

/** A file extension for a mime type: `image/png` gives `png`, `image/jpeg` gives `jpg`. */
export function extensionForMime(mime: string): string {
  const type = mime.split(";")[0]!.trim().toLowerCase();
  const known = EXTENSIONS[type];
  if (known) return known;
  // `image/webp` → webp, `application/vnd.foo+json` → json, `audio/x-wav` → wav.
  const subtype = type.split("/")[1] ?? "";
  const ext = (subtype.split("+").at(-1) ?? "").replace(/^x-/, "");
  return /^[a-z0-9]{1,5}$/.test(ext) ? ext : "bin";
}

/**
 * The filename to save an attachment as: its own name, or else `image-<number>`
 * (or its id) with an extension from its mime type.
 */
export function attachmentFileName(attachment: AgentAttachment, number?: number): string {
  if (attachment.name) return attachment.name;
  const base = number != null ? `image-${number}` : attachment.id;
  return `${base}.${extensionForMime(attachment.mime)}`;
}

const SAFE_PROTOCOLS = new Set(["http:", "https:", "blob:"]);

/**
 * Whether a URL is safe to set as an `href` or `src` outside JSX, where React's
 * `javascript:` URL protection doesn't apply: `http:`, `https:` and `blob:`
 * URLs, and relative URLs that resolve to one against the document.
 */
export function isSafeUrl(url: string): boolean {
  try {
    return SAFE_PROTOCOLS.has(new URL(url, document.baseURI).protocol);
  } catch {
    return false;
  }
}

/** How long `saveFiles` waits between files by default, so the browser doesn't block them. */
export const SAVE_FILES_DELAY_MS = 400;

/**
 * How long `saveFile` keeps a Blob's object URL before revoking it. The click
 * only starts the download, and some browsers read the URL a little later, so
 * revoking it straight away can fail the download. 40 seconds is FileSaver.js's
 * value: holding the Blob longer only costs memory.
 */
export const REVOKE_OBJECT_URL_DELAY_MS = 40_000;

function clickDownloadLink(url: string, filename: string): void {
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  link.style.display = "none";
  document.body.append(link);
  link.click();
  link.remove();
}

/**
 * Saves a file in the browser, through a temporary `<a download>`.
 *
 * - With a URL, a URL that isn't `http:`, `https:`, `blob:` or relative (such as
 *   `javascript:`) is skipped with a warning.
 * - With a `Blob`, such as an image drawn on a canvas, it makes an object URL
 *   and revokes it 40 seconds later.
 *
 * Call it from an event handler. Without a `document`, as in server rendering,
 * it does nothing.
 */
export function saveFile(urlOrBlob: string | Blob, filename: string): void {
  if (typeof document === "undefined") return;
  if (typeof urlOrBlob !== "string") {
    const url = URL.createObjectURL(urlOrBlob);
    clickDownloadLink(url, filename);
    setTimeout(() => URL.revokeObjectURL(url), REVOKE_OBJECT_URL_DELAY_MS);
    return;
  }
  if (!isSafeUrl(urlOrBlob)) {
    console.warn(`seclai: not downloading ${filename}, its URL isn't http(s), blob or relative.`);
    return;
  }
  clickDownloadLink(urlOrBlob, filename);
}

/** A file for `saveFiles`: a URL or a `Blob`, and the name to save it as. */
export interface SaveFilesEntry {
  url: string | Blob;
  filename: string;
}

export interface SaveFilesOptions {
  /** How long to wait between files. Defaults to 400 ms. */
  delayMs?: number;
  /** Stops before the next file once aborted. */
  signal?: AbortSignal;
}

/**
 * Saves several files one after another with `saveFile`. Browsers block a burst
 * of simultaneous downloads, so each one waits `delayMs` after the last. The
 * promise resolves once the last file is started, or when `signal` aborts.
 */
export async function saveFiles(
  files: readonly SaveFilesEntry[],
  { delayMs = SAVE_FILES_DELAY_MS, signal }: SaveFilesOptions = {},
): Promise<void> {
  for (const [i, file] of files.entries()) {
    if (signal?.aborted) return;
    if (i > 0) await wait(delayMs, signal);
    if (signal?.aborted) return;
    saveFile(file.url, file.filename);
  }
}

/** Waits `ms`, or less if `signal` aborts first, clearing the timer. */
function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

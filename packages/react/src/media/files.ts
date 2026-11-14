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

/**
 * Saves a URL as a file, through a temporary `<a download>`. A URL that isn't
 * `http:`, `https:`, `blob:` or relative (such as `javascript:`) is skipped.
 */
export function triggerDownload(url: string, filename: string): void {
  if (!isSafeUrl(url)) {
    console.warn(`seclai: not downloading ${filename}, its URL isn't http(s), blob or relative.`);
    return;
  }
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
 * Saves several files one after another. Browsers block a burst of simultaneous
 * downloads, so each one waits `delayMs` after the last.
 */
export async function downloadSequentially(
  files: { url: string; filename: string }[],
  delayMs: number,
  signal?: AbortSignal,
): Promise<void> {
  for (const [i, file] of files.entries()) {
    if (signal?.aborted) return;
    if (i > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (signal?.aborted) return;
    triggerDownload(file.url, file.filename);
  }
}

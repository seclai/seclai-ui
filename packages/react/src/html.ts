// `@seclai/react/html`: HTML and inline SVG in MarkdownContent.
//
// An entry of its own because the HTML parser it needs (parse5, through
// `rehype-raw`) is about half the size of everything else in MarkdownContent.

import rehypeRaw from "rehype-raw";
import type { MarkdownExtension } from "./markdown/extensions";

const extension: MarkdownExtension = { rehypePluginsBeforeSanitize: [rehypeRaw] };

/**
 * HTML written in the Markdown, such as `<sub>`, `<kbd>`, `<details>` or an
 * inline `<svg>` chart, rendered rather than shown as text. It's sanitized to
 * an allowlist: GitHub's, plus SVG shapes, text, gradients and filters. Scripts,
 * styles, event handlers, `<iframe>`, `<foreignObject>`, forms and URLs other
 * than http, https and mailto are removed, and SVG can only reference ids in
 * the same reply.
 *
 * ```tsx
 * import { SeclaiMarkdownProvider } from "@seclai/react";
 * import { html } from "@seclai/react/html";
 *
 * <SeclaiMarkdownProvider extensions={[html()]}>…</SeclaiMarkdownProvider>
 * ```
 */
export function html(): MarkdownExtension {
  return extension;
}

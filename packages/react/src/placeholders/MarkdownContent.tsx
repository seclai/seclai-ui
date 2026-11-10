// Placeholder, to be ported from the MarkdownContent component in the main Seclai
// app, which handles GFM tables, KaTeX, mermaid and sanitized SVG. Port it rather
// than rebuilding it here.
//
// Until then this must not render the content as HTML: agent output is untrusted
// and there's no sanitizer.

export interface MarkdownContentProps {
  content: string;
}

/**
 * Shows agent output. For now it renders plain text, never HTML. Markdown
 * rendering, with tables, maths and diagrams, is coming in a later version.
 */
export function MarkdownContent({ content }: MarkdownContentProps) {
  return <div className="seclai-markdown">{content}</div>;
}

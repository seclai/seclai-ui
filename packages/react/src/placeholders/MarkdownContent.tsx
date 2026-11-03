/**
 * PLACEHOLDER: port from seclai/frontend/app/components/MarkdownContent.tsx, which
 * handles GFM tables, KaTeX, mermaid and sanitized SVG. Don't rebuild it here.
 *
 * Until then this renders plain text. It must not render the content as HTML:
 * agent output is untrusted and this has no sanitizer.
 */
export interface MarkdownContentProps {
  content: string;
}

export function MarkdownContent({ content }: MarkdownContentProps) {
  return <div className="seclai-markdown">{content}</div>;
}

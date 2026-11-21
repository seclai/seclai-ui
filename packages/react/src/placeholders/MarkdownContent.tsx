// Placeholder, to be ported from the MarkdownContent component in the main Seclai
// app, which handles GFM tables, KaTeX, mermaid and sanitized SVG. Port it rather
// than growing this one.
//
// Until then this must not render the content as HTML: agent output is untrusted
// and there's no sanitizer. It builds React elements from a small subset of
// Markdown and leaves everything else as text.

import { Fragment, type ReactNode } from "react";

export interface MarkdownContentProps {
  content: string;
}

type Block =
  | { type: "p"; lines: string[]; verbatim?: boolean }
  | { type: "ol"; items: Array<{ n: number; lines: string[] }> }
  | { type: "ul"; items: Array<{ lines: string[] }> };

// A marker needs text after it, so a half-streamed "1." or "- " stays text
// until the item has something in it. "* " is a bullet; "**bold**" isn't.
const ORDERED = /^\s*(\d{1,9})[.)]\s+(\S.*)$/;
const BULLET = /^\s*[-*•]\s+(\S.*)$/;
const BARE_MARKER = /^\s*(\d{1,9}[.)]|[-*•])\s*$/;
// As in Markdown, a backtick fence's info string can't hold a backtick, so a
// one-line "```code```" is a code span rather than a fence that never closes.
// A fence closes on a line of at least as many of the same character.
const FENCE = /^\s*(`{3,}(?!.*`)|~{3,})/;
const CLOSING_FENCE = /^\s*(`{3,}|~{3,})\s*$/;

function parse(content: string): Block[] {
  const blocks: Block[] = [];
  let blank = true;
  let fence: string | null = null;

  for (const line of content.replace(/\r\n?/g, "\n").split("\n")) {
    const last = blocks.at(-1);

    // Fenced code stays verbatim, blank lines and all, so `**kwargs` or a
    // "- " line in it isn't taken for Markdown. An unclosed fence runs to the end.
    if (fence && last?.type === "p") {
      last.lines.push(line);
      const closing = CLOSING_FENCE.exec(line)?.[1];
      if (closing && closing[0] === fence[0] && closing.length >= fence.length) fence = null;
      continue;
    }
    const opening = FENCE.exec(line);
    if (opening) {
      fence = opening[1]!;
      blocks.push({ type: "p", lines: [line], verbatim: true });
      blank = false;
      continue;
    }

    if (!line.trim()) {
      blank = true;
      continue;
    }

    const ordered = ORDERED.exec(line);
    const bullet = ordered ? null : BULLET.exec(line);
    if (ordered) {
      const item = { n: Number(ordered[1]), lines: [ordered[2]!] };
      // A blank line between items keeps them in one list.
      if (last?.type === "ol") last.items.push(item);
      else blocks.push({ type: "ol", items: [item] });
    } else if (bullet) {
      const item = { lines: [bullet[1]!] };
      if (last?.type === "ul") last.items.push(item);
      else blocks.push({ type: "ul", items: [item] });
    } else if (!blank && (last?.type === "ol" || last?.type === "ul") && !BARE_MARKER.test(line)) {
      // A line straight after an item continues it. A bare "2." is the next
      // item still streaming in, so it shows on its own line instead.
      last.items.at(-1)!.lines.push(line.trim());
    } else if (!blank && last?.type === "p" && !last.verbatim) {
      last.lines.push(line);
    } else {
      blocks.push({ type: "p", lines: [line] });
    }
    blank = false;
  }
  return blocks;
}

// A code span is skipped whole, so "`**kwargs`" stays as typed, but bold can
// hold one ("**`file.txt`**"). Bold needs text that doesn't start or end with a
// space, as in Markdown, so "f(**a, **b)" isn't bold, and an unclosed "**"
// stays text. The last character is matched explicitly rather than with a
// lookbehind, which Safari before 16.4 can't parse: there, it would break the
// whole bundle, not just bold.
const INLINE = /(`[^`\n]+`)|\*\*(?!\s)((?:[^*`\n]|`[^`\n]*`)*?(?:[^\s*`]|`[^`\n]*`))\*\*/g;

function inline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let at = 0;
  for (const match of text.matchAll(INLINE)) {
    if (match[2] === undefined) continue;
    const index = match.index!;
    if (index > at) nodes.push(text.slice(at, index));
    nodes.push(<strong key={index}>{match[2]}</strong>);
    at = index + match[0].length;
  }
  if (at < text.length) nodes.push(text.slice(at));
  return nodes;
}

function withBreaks(lines: string[], format: (line: string) => ReactNode): ReactNode {
  return lines.map((line, i) => (
    <Fragment key={i}>
      {i > 0 && <br />}
      {format(line)}
    </Fragment>
  ));
}

/**
 * Shows agent output. It renders paragraphs (a single newline is a line
 * break), numbered lists that keep the agent's own numbers, bulleted lists and
 * `**bold**`. Everything else, such as headings, code, links and tables, shows
 * as the text it is. It never renders HTML. It also works on text that's still
 * streaming: a half-written list item or `**` shows as text until it's
 * complete. Tables, maths and diagrams are coming in a later version.
 */
export function MarkdownContent({ content }: MarkdownContentProps) {
  return (
    <div className="seclai-markdown">
      {parse(content).map((block, i) => {
        switch (block.type) {
          case "ol":
            return (
              // `role="list"`: Safari drops the list role from a list styled with
              // `list-style: none`, which this one is, for its number badges.
              <ol key={i} start={block.items[0]!.n} role="list">
                {block.items.map((item, j) => (
                  <li key={j} value={item.n}>
                    <span className="seclai-markdown-number">{item.n}</span>
                    <span>{withBreaks(item.lines, inline)}</span>
                  </li>
                ))}
              </ol>
            );
          case "ul":
            return (
              <ul key={i}>
                {block.items.map((item, j) => (
                  <li key={j}>{withBreaks(item.lines, inline)}</li>
                ))}
              </ul>
            );
          default:
            return <p key={i}>{withBreaks(block.lines, block.verbatim ? (line) => line : inline)}</p>;
        }
      })}
    </div>
  );
}

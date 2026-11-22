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

// A list item can hold lists nested under it, so lists form a small tree.
interface List {
  type: "ol" | "ul";
  items: Item[];
}

interface Item {
  /** The agent's number, for an item of a numbered list. */
  n?: number;
  /** How far the marker is indented, with a tab as 4 spaces. */
  indent: number;
  lines: string[];
  lists: List[];
}

type Block = { type: "p"; lines: string[]; verbatim?: boolean } | { type: "hr" } | List;

// A marker needs text after it, so a half-streamed "1." or "- " stays text
// until the item has something in it. "* " is a bullet; "**bold**" isn't.
const ORDERED = /^(\s*)(\d{1,9})[.)]\s+(\S.*)$/;
const BULLET = /^(\s*)[-*•]\s+(\S.*)$/;
// A line that may still become a list item or a break while it streams in: a
// bare "2", "2." or "-", or only marker characters, such as "- -" or "**". It
// isn't a bullet, and it doesn't join the item before it.
// The trailing spaces belong to each branch, not after both: a shared `\s*` would
// overlap `[-*_\s]*`, and a marker then a long run of spaces would backtrack
// quadratically on every streamed token.
const BARE_MARKER = /^\s*(?:\d{1,9}[.)]?\s*|[-*•_][-*_\s]*)$/;
// Three or more of the same "-", "*" or "_", optionally spaced: "---", "* * *".
const THEMATIC_BREAK = /^\s*([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
// An item is nested under the item before it when its marker is indented at
// least this many spaces more.
const NEST = 2;
// As in Markdown, a backtick fence's info string can't hold a backtick, so a
// one-line "```code```" is a code span rather than a fence that never closes.
// A fence closes on a line of at least as many of the same character.
const FENCE = /^\s*(`{3,}(?!.*`)|~{3,})/;
const CLOSING_FENCE = /^\s*(`{3,}|~{3,})\s*$/;

function indentOf(space: string): number {
  let width = 0;
  for (const char of space) width += char === "\t" ? 4 : 1;
  return width;
}

function parse(content: string): Block[] {
  const blocks: Block[] = [];
  // The lists still open, outermost first: the last block, the list nested in
  // its last item, and so on down. Empty when the last block isn't a list.
  const open: List[] = [];
  let blank = true;
  let fence: string | null = null;

  const push = (block: Block) => {
    blocks.push(block);
    open.length = 0;
  };

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
      push({ type: "p", lines: [line], verbatim: true });
      blank = false;
      continue;
    }

    if (!line.trim()) {
      blank = true;
      continue;
    }

    // Checked before bullets, which "* * *" and "- - -" would otherwise be.
    if (THEMATIC_BREAK.test(line)) {
      push({ type: "hr" });
      blank = false;
      continue;
    }

    const ordered = ORDERED.exec(line);
    const bullet = ordered || BARE_MARKER.test(line) ? null : BULLET.exec(line);
    if (ordered || bullet) {
      const type = ordered ? "ol" : "ul";
      const item: Item = ordered
        ? { n: Number(ordered[2]), indent: indentOf(ordered[1]!), lines: [ordered[3]!], lists: [] }
        : { indent: indentOf(bullet![1]!), lines: [bullet![2]!], lists: [] };
      // The item's level: one deeper for each open list whose last item it's
      // indented under. A blank line between items keeps them in one list.
      let level = 0;
      while (level < open.length && item.indent >= open[level]!.items.at(-1)!.indent + NEST) level++;
      const list = open[level];
      if (list?.type === type) {
        list.items.push(item);
        open.length = level + 1;
      } else {
        // A new list: nested in the item above, or at the same level as a list
        // of the other kind, which it follows.
        const next: List = { type, items: [item] };
        (level > 0 ? open[level - 1]!.items.at(-1)!.lists : blocks).push(next);
        open.length = level;
        open.push(next);
      }
    } else if (!blank && open.length > 0 && !BARE_MARKER.test(line)) {
      // A line straight after an item continues it, the deepest one if it's
      // nested. A bare "2." is the next item still streaming in, so it shows
      // on its own line instead.
      open.at(-1)!.items.at(-1)!.lines.push(line.trim());
    } else if (!blank && last?.type === "p" && !last.verbatim) {
      last.lines.push(line);
    } else {
      push({ type: "p", lines: [line] });
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

function renderList(list: List, key: number): ReactNode {
  if (list.type === "ul") {
    return (
      <ul key={key}>
        {list.items.map((item, i) => (
          <li key={i}>
            {withBreaks(item.lines, inline)}
            {item.lists.map(renderList)}
          </li>
        ))}
      </ul>
    );
  }
  return (
    // `role="list"`: Safari drops the list role from a list styled with
    // `list-style: none`, which this one is, for its number badges.
    <ol key={key} start={list.items[0]!.n} role="list">
      {list.items.map((item, i) => (
        <li key={i} value={item.n}>
          <span className="seclai-markdown-number">{item.n}</span>
          <div>
            {withBreaks(item.lines, inline)}
            {item.lists.map(renderList)}
          </div>
        </li>
      ))}
    </ol>
  );
}

/**
 * Shows agent output. It renders paragraphs (a single newline is a line
 * break), numbered lists that keep the agent's own numbers, bulleted lists,
 * lists nested under an item by indenting them, horizontal rules (`---`,
 * `***`, `___`) and `**bold**`. Everything else, such as headings, code, links
 * and tables, shows as the text it is. It never renders HTML. It also works on
 * text that's still streaming: a half-written list item, rule or `**` shows as
 * text until it's complete. Tables, maths and diagrams are coming in a later
 * version.
 */
export function MarkdownContent({ content }: MarkdownContentProps) {
  return (
    <div className="seclai-markdown">
      {parse(content).map((block, i) => {
        switch (block.type) {
          case "ol":
          case "ul":
            return renderList(block, i);
          case "hr":
            return <hr key={i} />;
          default:
            return <p key={i}>{withBreaks(block.lines, block.verbatim ? (line) => line : inline)}</p>;
        }
      })}
    </div>
  );
}

// Where a reply can be split into blocks that render on their own.
//
// A streaming reply re-renders on every token. To keep that cheap on a long
// reply, MarkdownContent renders it as a run of blocks, each memoized by its
// text, so only the last block, the one still growing, is parsed again. A split
// is only made where rendering the blocks one by one gives exactly what
// rendering the whole reply would:
//
// - Between two top-level nodes of the parsed tree, so the parser decides
//   where a list, quote, table or fence ends, not a guess. A list whose items
//   are separated by blank lines, or a fence holding blank lines, is one node.
// - Only once the next node's first line is complete. Markdown decides how a
//   line closes the blocks before it from that line alone, so a complete line
//   can't change that later. A partial one can: "2" could still become "2. ",
//   an item that would continue the list above.
// - With `html()`, not while raw HTML opened before it is still open. The HTML
//   parser joins raw HTML across nodes, as in `<details>` around a paragraph.
//
// A link reference or footnote definition changes text elsewhere in the reply,
// so a reply that may have one isn't split at all (see `MAY_DEFINE`).

import type { Nodes, Root } from "mdast";

export const splitting = {
  /**
   * The shortest block, in characters. Blocks of a few nodes rather than one
   * each keep down the number of blocks, which React compares on every token,
   * while the last block stays quick to parse. Tests lower it to split at
   * every node.
   */
  minBlock: 1024,
};

const VOID = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

// A quote only starts a quoted attribute value right after `=`, as in
// `title="a > b"`. Elsewhere, as in `title=don't`, it's just a character. The
// alternatives can't match the same text, so this can't backtrack badly.
const TAG = /<!--[\s\S]*?-->|<(\/?)([A-Za-z][A-Za-z0-9-]*)(?:=[ \t\n]*"[^"]*"|=[ \t\n]*'[^']*'|=(?![ \t\n]*["'])|[^<>=])*?(\/?)>/g;

/** Elements whose content is SVG or MathML, where `/>` closes an element, as in `<rect/>`. */
const FOREIGN = new Set(["svg", "math"]);

/** Updates `open`, the raw HTML elements still open, with the HTML in `node`. */
function trackHtml(node: Nodes, open: string[]) {
  if (node.type === "html") {
    for (const match of node.value.matchAll(TAG)) {
      const [, closing, name, selfClosing] = match;
      if (!name) continue; // A comment.
      const tag = name.toLowerCase();
      if (closing) {
        const at = open.lastIndexOf(tag);
        if (at !== -1) open.length = at;
      } else {
        // In HTML, `/>` doesn't close an element: `<details/>` stays open and
        // takes in what follows. It only does in SVG and MathML.
        const closed = VOID.has(tag) || (!!selfClosing && (FOREIGN.has(tag) || open.some((name) => FOREIGN.has(name))));
        if (!closed) open.push(tag);
      }
    }
    return;
  }
  if ("children" in node) for (const child of node.children) trackHtml(child, open);
}

/**
 * The offsets in `source` where it can be split, given its parsed `tree`. Each
 * is the start of a line. `rawHtml` is whether raw HTML is parsed (`html()`):
 * without it, HTML shows as text, so open tags don't hold back a split.
 */
export function splitPoints(tree: Root, source: string, rawHtml = true): number[] {
  const points: number[] = [];
  const open: string[] = [];
  let previousEnd = 0;
  for (const [index, node] of tree.children.entries()) {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) return points;
    const lineStart = source.lastIndexOf("\n", start - 1) + 1;
    if (
      index > 0 &&
      open.length === 0 &&
      lineStart >= previousEnd &&
      lineStart > (points.at(-1) ?? 0) &&
      source.indexOf("\n", start) !== -1
    ) {
      points.push(lineStart);
    }
    if (rawHtml) trackHtml(node, open);
    previousEnd = end;
  }
  return points;
}

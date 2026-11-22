// Small remark (Markdown tree) and rehype (HTML tree) plugins.

import type { Element, ElementContent, Root as HastRoot } from "hast";
import type { Code, Nodes, Parent, PhrasingContent, Root } from "mdast";

/** The file a plugin's transform gets: just the source text, here. */
export interface SourceFile {
  value: unknown;
}

function visit(node: Nodes, test: string, fn: (node: Nodes, parent: Parent | undefined) => void, parent?: Parent) {
  if (node.type === test) fn(node, parent);
  if ("children" in node) for (const child of node.children) visit(child, test, fn, node);
}

/**
 * Keeps the number the agent wrote on each item of a numbered list. Markdown
 * keeps only the first item's number and counts on from it, so `1. 1. 1.`
 * would read 1, 2, 3. Sets `value` on each item, from the source text.
 */
export function remarkListNumbers() {
  return (tree: Root, file: SourceFile) => {
    const source = String(file.value);
    visit(tree, "list", (list) => {
      if (list.type !== "list" || !list.ordered) return;
      for (const item of list.children) {
        const offset = item.position?.start.offset;
        if (offset === undefined) continue;
        const number = /^[ \t]*(\d{1,9})[.)]/.exec(source.slice(offset, offset + 16))?.[1];
        if (number === undefined) continue;
        item.data = { ...item.data, hProperties: { ...item.data?.hProperties, value: number } };
      }
    });
  };
}

const LINE_ENDING = /[ \t]*\n[ \t]*/;

/**
 * Makes a single newline in a paragraph a line break, as in chat apps, rather
 * than a space as in Markdown. Agents often rely on it.
 */
export function remarkLineBreaks() {
  const split = (parent: Parent) => {
    const children: Nodes[] = [];
    let changed = false;
    for (const child of parent.children as Nodes[]) {
      if (child.type === "text" && child.value.includes("\n")) {
        changed = true;
        child.value.split(LINE_ENDING).forEach((value, i) => {
          if (i > 0) children.push({ type: "break" });
          if (value) children.push({ type: "text", value });
        });
        continue;
      }
      if ("children" in child) split(child);
      children.push(child);
    }
    if (changed) parent.children = children as PhrasingContent[];
  };
  return (tree: Root) => split(tree);
}

const BR = /^<br\s*\/?>$/i;

/**
 * Makes `<br>` in text a line break, as agents write it in table cells, where
 * Markdown has no other way to break a line. Other HTML shows as text unless
 * `html()` is on.
 */
export function remarkHtmlBreaks() {
  return (tree: Root) =>
    visit(tree, "html", (node, parent) => {
      if (node.type !== "html" || !parent || parent.type === "root" || !BR.test(node.value)) return;
      const index = parent.children.indexOf(node as never);
      parent.children[index] = { type: "break" } as never;
    });
}

/**
 * Whether a fenced code block (or `$$` maths block) has its closing fence. An
 * unclosed one runs to the end of the text, which while streaming means its
 * content is still arriving.
 */
export function isClosedFence(node: Nodes, source: string): boolean {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined) return true;
  const text = source.slice(start, end);
  const opening = /^[ \t]*(`{3,}|~{3,}|\${2,})/.exec(text)?.[1];
  // Indented code has no fence.
  if (!opening) return true;
  const newline = text.lastIndexOf("\n");
  if (newline === -1) return false;
  // The last line, after any quote markers or indentation.
  const closing = /^[ \t>]*(`+|~+|\$+)[ \t]*$/.exec(text.slice(newline + 1))?.[1];
  return !!closing && closing[0] === opening[0] && closing.length >= opening.length;
}

/** A remark plugin that turns the language off on unclosed fences in `languages`, so they show as plain code. */
export function remarkOpenFencesAsCode(languages: string[]) {
  return () => (tree: Root, file: SourceFile) => {
    const source = String(file.value);
    visit(tree, "code", (node) => {
      const code = node as Code;
      if (code.lang && languages.includes(code.lang.toLowerCase()) && !isClosedFence(code, source)) {
        code.lang = null;
        code.meta = null;
      }
    });
  };
}

const isElement = (node: ElementContent): node is Element => node.type === "element";

/**
 * Shows HTML written in the Markdown as the text it is, as it is without
 * `html()`, which parses it first. The sanitizer would otherwise drop it.
 */
export function rehypeRawAsText() {
  const walk = (node: HastRoot | Element) => {
    node.children.forEach((child, index) => {
      const raw = child as unknown as { type: string; value: string };
      if (raw.type === "raw") node.children[index] = { type: "text", value: raw.value };
      else if (child.type === "element") walk(child);
    });
  };
  return (tree: HastRoot) => walk(tree);
}

/**
 * Drops the newlines between top-level blocks, which don't render. A reply
 * rendered as separate blocks has none at the splits, so this keeps it the
 * same as one rendered whole.
 */
export function rehypeTrimBlocks() {
  return (tree: HastRoot) => {
    tree.children = tree.children.filter((child) => child.type !== "text" || child.value.trim() !== "");
  };
}

/**
 * Shows each numbered item's number as a badge, matching `MediaPreview`'s, so
 * "2." in the text matches image 2. The badge comes first in the item, and the
 * item's content is wrapped in a `div` next to it. Runs after sanitizing, so it
 * also numbers an `<ol>` written as HTML, counting on from `start`.
 */
export function rehypeListBadges() {
  const walk = (node: HastRoot | Element) => {
    for (const child of node.children) {
      if (child.type !== "element") continue;
      walk(child);
      if (child.tagName !== "ol") continue;

      const start = Number(child.properties.start);
      let next = Number.isInteger(start) ? start : 1;
      let first: number | undefined;
      for (const item of child.children) {
        if (!isElement(item) || item.tagName !== "li") continue;
        const value = Number(item.properties.value);
        const number = Number.isInteger(value) && item.properties.value !== undefined ? value : next;
        first ??= number;
        next = number + 1;
        (item.properties as Record<string, unknown>).value = number;
        item.children = [
          {
            type: "element",
            tagName: "span",
            properties: { className: ["seclai-markdown-number"] },
            children: [{ type: "text", value: String(number) }],
          },
          { type: "element", tagName: "div", properties: {}, children: item.children },
        ];
      }
      if (first !== undefined) (child.properties as Record<string, unknown>).start = first;
      // Safari drops the list role from a list styled with `list-style: none`,
      // which this one is, for its badges.
      child.properties.role = "list";
    }
  };
  return (tree: HastRoot) => walk(tree);
}

// `@seclai/react/math`: maths in MarkdownContent, rendered with KaTeX.
//
// An entry of its own, so `katex` and `remark-math` (optional peer
// dependencies) are only installed and bundled by apps that use it.

import type { Element, ElementContent, Root as HastRoot } from "hast";
import katex from "katex";
import type { Nodes, Parent, Root } from "mdast";
import { useMemo } from "react";
import type { Components, ExtraProps } from "react-markdown";
import remarkMath from "remark-math";
import type { MarkdownExtension } from "./markdown/extensions";
import { isClosedFence, remarkOpenFencesAsCode, type SourceFile } from "./markdown/plugins";
import { replaceOutsideCode } from "./markdown/text";

// `\[…\]` and `\(…\)`, which many models write, as `$$…$$` and `$…$`.
const DISPLAY = /\\\[[\s\S]*?\\\]/g;
const INLINE = /\\\([\s\S]*?\\\)/g;
const LINE_END = /[ \t]*(?:\n|$)/y;

/**
 * Rewrites the LaTeX delimiters `\[…\]` (display) and `\(…\)` (inline) as
 * `$$…$$` and `$…$`, which Markdown maths uses. Code is left alone. A delimiter
 * that isn't closed yet stays as it is.
 */
function normalizeMathDelimiters(markdown: string): string {
  if (!markdown.includes("\\[") && !markdown.includes("\\(")) return markdown;
  const display = replaceOutsideCode(markdown, DISPLAY, (match, offset, text) => {
    const inner = match.slice(2, -2);
    // On lines of its own it's a block. Elsewhere `$$…$$` is still maths, but inline.
    LINE_END.lastIndex = offset + match.length;
    const ownLines = (offset === 0 || text[offset - 1] === "\n") && LINE_END.test(text);
    return ownLines ? `$$\n${inner.trim()}\n$$` : `$$${inner}$$`;
  });
  return replaceOutsideCode(display, INLINE, (match) => `$${match.slice(2, -2)}$`);
}

/**
 * A `$$` block whose closing `$$` hasn't arrived yet shows as a code block of
 * its source, rather than as maths that's half there or a KaTeX error.
 */
function remarkOpenMathAsCode() {
  return (tree: Root, file: SourceFile) => {
    const source = String(file.value);
    const walk = (parent: Parent) => {
      parent.children.forEach((child, index) => {
        const node = child as Nodes | { type: "math"; value: string; position?: Nodes["position"] };
        if (node.type === "math" && !isClosedFence(node as Nodes, source)) {
          parent.children[index] = { type: "code", lang: null, meta: null, value: node.value, position: node.position };
        } else if ("children" in node) {
          walk(node as Parent);
        }
      });
    };
    walk(tree);
  };
}

const text = (node: Element): string =>
  node.children.map((child) => (child.type === "text" ? child.value : child.type === "element" ? text(child) : "")).join("");

/**
 * Turns maths into `seclai-math` elements, rendered by the component below:
 * `code.language-math` from `$…$` and `$$…$$`, and `pre` around it for a block,
 * as from a `$$` block or a ```` ```math ```` fence.
 */
function rehypeMathElements() {
  const isMath = (node: ElementContent | undefined): node is Element =>
    node?.type === "element" &&
    node.tagName === "code" &&
    Array.isArray(node.properties.className) &&
    node.properties.className.includes("language-math");

  const walk = (parent: HastRoot | Element) => {
    parent.children.forEach((child, index) => {
      if (child.type !== "element") return;
      const code = child.tagName === "pre" ? child.children.find(isMath) : isMath(child) ? child : undefined;
      if (!code) return walk(child);
      parent.children[index] = {
        type: "element",
        tagName: "seclai-math",
        properties: { dataDisplay: child.tagName === "pre" ? "block" : "inline" },
        children: [{ type: "text", value: text(code).replace(/\n$/, "") }],
      };
    });
  };
  return (tree: HastRoot) => walk(tree);
}

const cache = new Map<string, string | null>();

/** KaTeX's HTML for `source`, or `null` if it isn't valid. */
function renderMath(source: string, display: boolean): string | null {
  const key = `${display ? "block" : "inline"}\u0000${source}`;
  let html = cache.get(key);
  if (html === undefined) {
    try {
      html = katex.renderToString(source, {
        displayMode: display,
        throwOnError: true,
        // No `\href`, `\url`, `\includegraphics` or `\html…` commands from the reply.
        trust: false,
        strict: "ignore",
      });
    } catch {
      html = null;
    }
    if (cache.size >= 500) cache.delete(cache.keys().next().value!);
    cache.set(key, html);
  }
  return html;
}

function MathElement({ node }: ExtraProps) {
  const source = node ? text(node) : "";
  const display = node?.properties.dataDisplay === "block";
  const html = useMemo(() => renderMath(source, display), [source, display]);
  // Invalid maths shows as its source, not as a KaTeX error.
  if (html === null) {
    return display ? (
      <pre>
        <code>{source}</code>
      </pre>
    ) : (
      <code>{source}</code>
    );
  }
  const Tag = display ? "div" : "span";
  return <Tag className="seclai-markdown-math" dangerouslySetInnerHTML={{ __html: html }} />;
}

let extension: MarkdownExtension | undefined;

/**
 * Maths in `MarkdownContent`, rendered with KaTeX: `$…$` and `\(…\)` inline,
 * `$$…$$` and `\[…\]` as a block, and ```` ```math ```` fences. Maths renders
 * once its closing delimiter arrives, and invalid maths shows as its source.
 *
 * Needs `katex` and `remark-math` installed, and KaTeX's stylesheet:
 *
 * ```tsx
 * import { SeclaiMarkdownProvider } from "@seclai/react";
 * import { math } from "@seclai/react/math";
 * import "katex/dist/katex.min.css";
 *
 * <SeclaiMarkdownProvider extensions={[math()]}>…</SeclaiMarkdownProvider>
 * ```
 */
export function math(): MarkdownExtension {
  return (extension ??= {
    remarkPlugins: [remarkMath, remarkOpenMathAsCode, remarkOpenFencesAsCode(["math"])],
    rehypePlugins: [rehypeMathElements],
    components: { "seclai-math": MathElement } as Components,
    transform: normalizeMathDelimiters,
  });
}

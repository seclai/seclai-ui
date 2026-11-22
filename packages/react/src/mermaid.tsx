// `@seclai/react/mermaid`: Mermaid diagrams in MarkdownContent.
//
// An entry of its own, so `mermaid` (an optional peer dependency) is only
// installed by apps that use it. Even then it's loaded with a dynamic import
// the first time a diagram shows, so bundlers split it into its own chunk.

import type { Element, ElementContent, Root as HastRoot } from "hast";
import type { Mermaid } from "mermaid";
import { useEffect, useState } from "react";
import type { Components, ExtraProps } from "react-markdown";
import type { MarkdownExtension } from "./markdown/extensions";
import { remarkOpenFencesAsCode } from "./markdown/plugins";

export interface MermaidOptions {
  /**
   * Mermaid's theme, such as `"dark"` for a dark page. Defaults to `"default"`,
   * on a white background. Mermaid has one configuration per page, so the first
   * diagram's theme applies to all of them.
   */
  theme?: "default" | "base" | "dark" | "forest" | "neutral";
}

let loading: Promise<Mermaid> | undefined;

function loadMermaid(theme: NonNullable<MermaidOptions["theme"]>): Promise<Mermaid> {
  return (loading ??= import("mermaid").then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      // Labels are sanitized and click handlers are off.
      securityLevel: "strict",
      // A syntax error throws, rather than drawing Mermaid's error diagram.
      suppressErrorRendering: true,
      theme,
      // Labels may hold some HTML. Like images elsewhere in a reply, none of it
      // may load anything: no images, and no styles, which could hold `url(…)`.
      dompurifyConfig: {
        FORBID_TAGS: ["style", "img", "image", "picture", "source", "video", "audio", "svg", "link"],
        FORBID_ATTR: ["style", "src", "srcset", "background", "poster"],
      },
      // Settings a diagram can't change with an `%%{init: …}%%` directive:
      // Mermaid's own list, plus the ones it copies into the diagram's CSS as
      // they are, which could load outside URLs with `url(…)` or restyle the
      // page, and the label sanitizing above.
      secure: [
        "secure",
        "securityLevel",
        "startOnLoad",
        "maxTextSize",
        "suppressErrorRendering",
        "maxEdges",
        "themeCSS",
        "fontFamily",
        "altFontFamily",
        "dompurifyConfig",
      ],
    });
    return mermaid;
  }));
}

// Mermaid renders one diagram at a time.
let queue: Promise<unknown> = Promise.resolve();
let nextId = 0;
const rendered = new Map<string, string | null>();

/** The diagram's SVG, or `null` if Mermaid can't draw it. */
function renderDiagram(source: string, theme: NonNullable<MermaidOptions["theme"]>): Promise<string | null> {
  const key = `${theme}\u0000${source}`;
  const done = rendered.get(key);
  if (done !== undefined) return Promise.resolve(done);
  const result = queue.then(async () => {
    let svg: string | null = null;
    try {
      const mermaid = await loadMermaid(theme);
      if (await mermaid.parse(source, { suppressErrors: true })) {
        svg = (await mermaid.render(`seclai-mermaid-${nextId++}`, source)).svg;
      }
    } catch {
      svg = null;
    }
    if (rendered.size >= 100) rendered.delete(rendered.keys().next().value!);
    rendered.set(key, svg);
    return svg;
  });
  queue = result;
  return result;
}

const text = (node: Element): string =>
  node.children.map((child) => (child.type === "text" ? child.value : child.type === "element" ? text(child) : "")).join("");

/** Turns a ```` ```mermaid ```` code block into a `seclai-mermaid` element, rendered by the component below. */
function rehypeMermaidElements() {
  const isMermaid = (node: ElementContent): node is Element =>
    node.type === "element" &&
    node.tagName === "code" &&
    Array.isArray(node.properties.className) &&
    node.properties.className.includes("language-mermaid");

  const walk = (parent: HastRoot | Element) => {
    parent.children.forEach((child, index) => {
      if (child.type !== "element") return;
      const code = child.tagName === "pre" ? child.children.find(isMermaid) : undefined;
      if (!code) return walk(child);
      parent.children[index] = {
        type: "element",
        tagName: "seclai-mermaid",
        properties: {},
        children: [{ type: "text", value: text(code).replace(/\n$/, "") }],
      };
    });
  };
  return (tree: HastRoot) => walk(tree);
}

function diagramComponent(theme: NonNullable<MermaidOptions["theme"]>) {
  return function MermaidDiagram({ node }: ExtraProps) {
    const source = node ? text(node) : "";
    const key = `${theme}\u0000${source}`;
    // Drawn before, such as when a block re-mounts: show it straight away.
    const [svg, setSvg] = useState(() => rendered.get(key) ?? null);
    const [drawn, setDrawn] = useState(() => (rendered.get(key) !== undefined ? key : null));

    useEffect(() => {
      let current = true;
      renderDiagram(source, theme).then((result) => {
        if (!current) return;
        setSvg(result);
        setDrawn(key);
      });
      return () => {
        current = false;
      };
    }, [source, key]);

    // The source, while Mermaid loads and if it can't draw the diagram.
    if (drawn !== key || svg === null) {
      return (
        <pre className="seclai-markdown-mermaid-source">
          <code className="language-mermaid">{source}</code>
        </pre>
      );
    }
    return <div className="seclai-markdown-mermaid" data-theme={theme} dangerouslySetInnerHTML={{ __html: svg }} />;
  };
}

const extensions = new Map<string, MarkdownExtension>();

/**
 * Mermaid diagrams in `MarkdownContent`, from ```` ```mermaid ```` code blocks.
 * A diagram is drawn once its closing fence arrives; until then, and if it has
 * a syntax error, its source shows as code. Mermaid runs with
 * `securityLevel: "strict"`.
 *
 * Needs `mermaid` installed:
 *
 * ```tsx
 * import { SeclaiMarkdownProvider } from "@seclai/react";
 * import { mermaid } from "@seclai/react/mermaid";
 *
 * <SeclaiMarkdownProvider extensions={[mermaid()]}>…</SeclaiMarkdownProvider>
 * ```
 */
export function mermaid(options: MermaidOptions = {}): MarkdownExtension {
  const theme = options.theme ?? "default";
  let extension = extensions.get(theme);
  if (!extension) {
    extension = {
      remarkPlugins: [remarkOpenFencesAsCode(["mermaid"])],
      rehypePlugins: [rehypeMermaidElements],
      components: { "seclai-mermaid": diagramComponent(theme) } as Components,
    };
    extensions.set(theme, extension);
  }
  return extension;
}

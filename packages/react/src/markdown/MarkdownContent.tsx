import type { Root } from "mdast";
import { memo, useState, type ComponentProps } from "react";
import Markdown, { type Components, type ExtraProps } from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import { splitPoints, splitting } from "./blocks";
import { useMarkdownExtensions, type MarkdownExtension } from "./extensions";
import { remarkGfm } from "./gfm";
import {
  rehypeListBadges,
  rehypeRawAsText,
  rehypeTrimBlocks,
  remarkHtmlBreaks,
  remarkLineBreaks,
  remarkListNumbers,
} from "./plugins";
import { rehypeImagesInLinks, rehypeSafeReferences, sanitizeSchema } from "./sanitize";
import { holdBackPendingLine, MAY_DEFINE, normalizeBullets, normalizeNewlines } from "./text";

export interface MarkdownContentProps {
  /** The Markdown to show. */
  content: string;
  /**
   * The text is still streaming in. An unfinished last line that could still
   * become something else, such as a bare `-` or `2.`, is held back until more
   * arrives. Leave it off for finished text.
   */
  streaming?: boolean;
  /**
   * Extensions, such as `math()` and `mermaid()`. When set, they replace the
   * ones from `SeclaiMarkdownProvider`.
   */
  extensions?: readonly MarkdownExtension[];
}

type PluggableList = NonNullable<ComponentProps<typeof Markdown>["remarkPlugins"]>;

interface Pipeline {
  remarkPlugins: PluggableList;
  rehypePlugins: PluggableList;
  components: Components;
  transforms: Array<(markdown: string) => string>;
  /** Whether raw HTML is parsed, as with `html()`, rather than shown as text. */
  rawHtml: boolean;
}

const SAFE_PROTOCOL = /^(?:https?|mailto)$/i;

/**
 * Keeps http, https and mailto URLs, and relative ones (`/path`, `#id`). Others,
 * such as `javascript:`, are removed: a link without one shows as its text.
 */
export function safeUrl(url: string): string | undefined {
  const colon = url.indexOf(":");
  if (colon === -1) return url;
  for (const char of ["/", "?", "#"]) {
    const index = url.indexOf(char);
    // The colon is in the path, query or fragment: it's a relative URL.
    if (index !== -1 && index < colon) return url;
  }
  return SAFE_PROTOCOL.test(url.slice(0, colon)) ? url : undefined;
}

const isExternal = (href: string) => /^(?:https?:)?\/\//i.test(href);

const external = { target: "_blank", rel: "noopener noreferrer" } as const;

function Link({ node: _node, href, children, ...props }: ComponentProps<"a"> & ExtraProps) {
  if (!href) return <>{children}</>;
  return (
    <a {...props} href={href} {...(isExternal(href) ? external : undefined)}>
      {children}
    </a>
  );
}

// Images are shown as links rather than loaded. See `rehypeImagesInLinks`.
function Image({ src, alt, title }: ComponentProps<"img"> & ExtraProps) {
  if (typeof src !== "string" || !src) return alt ? <>{alt}</> : null;
  return (
    <a className="seclai-markdown-image" href={src} title={title} {...(isExternal(src) ? external : undefined)}>
      {alt || src}
    </a>
  );
}

// Wide tables scroll sideways rather than squeezing their columns.
function Table({ node: _node, ...props }: ComponentProps<"table"> & ExtraProps) {
  return (
    <div className="seclai-markdown-table">
      <table {...props} />
    </div>
  );
}

const components: Components = { a: Link, img: Image, table: Table };

const pipelines = new Map<string, Pipeline>();
const extensionIds = new WeakMap<MarkdownExtension, number>();
let nextExtensionId = 0;

/** One pipeline per list of extensions, so an inline `[math()]` doesn't re-render every block. */
function pipelineFor(extensions: readonly MarkdownExtension[]): Pipeline {
  const key = extensions
    .map((extension) => {
      let id = extensionIds.get(extension);
      if (id === undefined) extensionIds.set(extension, (id = nextExtensionId++));
      return id;
    })
    .join(",");
  const cached = pipelines.get(key);
  if (cached) {
    // Most recently used last, as the oldest is dropped below.
    pipelines.delete(key);
    pipelines.set(key, cached);
    return cached;
  }
  const pipeline: Pipeline = {
    remarkPlugins: [
      remarkGfm,
      ...extensions.flatMap((extension) => extension.remarkPlugins ?? []),
      remarkListNumbers,
      remarkLineBreaks,
      remarkHtmlBreaks,
    ],
    rehypePlugins: [
      ...extensions.flatMap((extension) => extension.rehypePluginsBeforeSanitize ?? []),
      rehypeRawAsText,
      [rehypeSanitize, sanitizeSchema],
      rehypeSafeReferences,
      rehypeImagesInLinks,
      rehypeListBadges,
      rehypeTrimBlocks,
      ...extensions.flatMap((extension) => extension.rehypePlugins ?? []),
    ],
    components: Object.assign({}, components, ...extensions.map((extension) => extension.components)),
    transforms: extensions.flatMap((extension) => (extension.transform ? [extension.transform] : [])),
    rawHtml: extensions.some((extension) => extension.rehypePluginsBeforeSanitize?.length),
  };
  // An extension object made on every render, rather than once, would add a
  // pipeline each time: keep the most recent ones only.
  if (pipelines.size >= 50) pipelines.delete(pipelines.keys().next().value!);
  pipelines.set(key, pipeline);
  return pipeline;
}

type OnTree = (tree: Root, source: string) => void;

function remarkOnTree(onTree: OnTree) {
  return (tree: Root, file: { value: unknown }) => onTree(tree, String(file.value));
}

interface BlockProps {
  text: string;
  pipeline: Pipeline;
  /** Set on the last block, to learn where it can be split. */
  onTree?: OnTree;
}

// `memo(...)` is a call, which a bundler keeps, along with all it refers to,
// unless it's marked pure: then apps that don't render Markdown leave it out.
const Block = /* @__PURE__ */ memo(
  function Block({ text, pipeline, onTree }: BlockProps) {
    return (
      <Markdown
        remarkPlugins={onTree ? [[remarkOnTree, onTree], ...pipeline.remarkPlugins] : pipeline.remarkPlugins}
        rehypePlugins={pipeline.rehypePlugins}
        components={pipeline.components}
        urlTransform={safeUrl}
      >
        {text}
      </Markdown>
    );
  },
  (a, b) => a.text === b.text && a.pipeline === b.pipeline && !a.onTree === !b.onTree,
);

/**
 * Remembers where a growing text was split into blocks. See `./blocks`. The
 * splits it records stay valid for any text that starts with the same lines,
 * so a new token keeps every block but the last.
 */
class Splitter {
  private doc = "";
  private pipeline: Pipeline | undefined;
  /** Where each block after the first starts. */
  private starts: number[] = [];
  /** How much of the text the splits depend on: up to the end of the last split's line. */
  private settled = 0;

  update(doc: string, pipeline: Pipeline): { starts: number[]; onTree?: OnTree } {
    const split = !MAY_DEFINE.test(doc);
    if (!split || pipeline !== this.pipeline || !doc.startsWith(this.doc.slice(0, this.settled))) {
      this.starts = [];
      this.settled = 0;
    }
    this.doc = doc;
    this.pipeline = pipeline;
    const starts = [0, ...this.starts];
    if (!split) return { starts };

    const tail = starts.at(-1)!;
    const onTree: OnTree = (tree, source) => {
      if (this.doc !== doc) return;
      for (const point of splitPoints(tree, source, pipeline.rawHtml)) {
        const at = tail + point;
        if (at - (this.starts.at(-1) ?? 0) < splitting.minBlock) continue;
        this.starts.push(at);
        this.settled = doc.indexOf("\n", at) + 1;
      }
    };
    return { starts, onTree };
  }
}

/**
 * Renders Markdown, such as an agent's reply, including while it streams in.
 * `AgentRunForm` and `AgentChat` use it for the agent's output and the user's
 * messages.
 *
 * It renders GitHub Flavored Markdown: headings, emphasis, links (and bare
 * URLs), inline code and code blocks, block quotes, lists (nested, and with
 * block content in items), tables, task lists, strikethrough, footnotes and
 * rules. Numbered items keep the number the agent wrote, shown in a badge that
 * matches `MediaPreview`'s. A single newline is a line break, `<br>` is one
 * too, and `•` works as a bullet.
 *
 * Agent output is untrusted: links are limited to http, https, mailto and
 * relative URLs, and external ones open in a new tab; images show as links
 * rather than loading; other HTML shows as text.
 *
 * HTML (sanitized), maths and Mermaid diagrams are opt-in extensions:
 * `html()`, `math()` and `mermaid()` from `@seclai/react/html`,
 * `@seclai/react/math` and `@seclai/react/mermaid`. Pass them in `extensions`,
 * or to every `MarkdownContent` at once with `SeclaiMarkdownProvider`.
 *
 * While the text streams in, it's split into blocks and only the last one is
 * parsed again as tokens arrive. Pass `streaming` until it's complete.
 */
export const MarkdownContent = /* @__PURE__ */ memo(function MarkdownContent({
  content,
  streaming = false,
  extensions,
}: MarkdownContentProps) {
  const fromProvider = useMarkdownExtensions();
  const pipeline = pipelineFor(extensions ?? fromProvider);
  const [splitter] = useState(() => new Splitter());

  let doc = normalizeNewlines(content);
  if (streaming) doc = holdBackPendingLine(doc);
  doc = normalizeBullets(doc);
  for (const transform of pipeline.transforms) doc = transform(doc);

  const { starts, onTree } = splitter.update(doc, pipeline);
  return (
    <div className="seclai-markdown">
      {starts.map((start, i) => {
        const last = i === starts.length - 1;
        return (
          <Block
            key={start}
            text={doc.slice(start, last ? undefined : starts[i + 1])}
            pipeline={pipeline}
            onTree={last ? onTree : undefined}
          />
        );
      })}
    </div>
  );
});

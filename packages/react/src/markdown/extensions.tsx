import { createContext, useContext, type ReactNode } from "react";
import type { Components, Options } from "react-markdown";

type PluggableList = NonNullable<Options["remarkPlugins"]>;

/**
 * Adds to what `MarkdownContent` renders: HTML with `html()` from
 * `@seclai/react/html`, maths with `math()` from `@seclai/react/math`, or
 * diagrams with `mermaid()` from `@seclai/react/mermaid`.
 */
export interface MarkdownExtension {
  /** remark plugins, run on the Markdown tree after the built-in syntax (GFM). */
  remarkPlugins?: PluggableList;
  /**
   * rehype plugins, run on the HTML tree before it's sanitized, such as
   * `rehype-raw` in `html()`. What they add is sanitized.
   */
  rehypePluginsBeforeSanitize?: PluggableList;
  /**
   * rehype plugins, run on the HTML tree after it's sanitized. What they add
   * isn't sanitized, so they must only add HTML they built themselves.
   */
  rehypePlugins?: PluggableList;
  /**
   * Components for elements, as in `react-markdown`. They replace the built-in
   * ones for the same element, such as `a`, `img` or `table`.
   */
  components?: Components;
  /** Rewrites the whole text before it's parsed, for syntax Markdown doesn't have. */
  transform?: (markdown: string) => string;
}

const ExtensionsContext = /* @__PURE__ */ createContext<readonly MarkdownExtension[]>([]);

export interface SeclaiMarkdownProviderProps {
  /** The extensions for every `MarkdownContent` inside, including the ones `AgentChat` and `AgentRunForm` render. */
  extensions: readonly MarkdownExtension[];
  children?: ReactNode;
}

/**
 * Sets the Markdown extensions for every `MarkdownContent` inside it, such as
 * the ones `AgentChat` and `AgentRunForm` render:
 *
 * ```tsx
 * <SeclaiMarkdownProvider extensions={[math(), mermaid()]}>
 *   <AgentChat />
 * </SeclaiMarkdownProvider>
 * ```
 */
export function SeclaiMarkdownProvider({ extensions, children }: SeclaiMarkdownProviderProps) {
  return <ExtensionsContext.Provider value={extensions}>{children}</ExtensionsContext.Provider>;
}

export function useMarkdownExtensions(): readonly MarkdownExtension[] {
  return useContext(ExtensionsContext);
}

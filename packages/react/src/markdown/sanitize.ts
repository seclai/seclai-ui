// What HTML and SVG in agent output may hold. Agent output is untrusted, and
// may be steered by whatever the agent read, so this is an allowlist: GitHub's
// (the `rehype-sanitize` default) plus inline SVG for charts, minus a few
// attributes that don't belong in a chat transcript.

import type { Element, ElementContent, Root, RootContent } from "hast";
import { defaultSchema, type Options as Schema } from "rehype-sanitize";

const SVG_TAGS = [
  "svg",
  "g",
  "defs",
  "title",
  "desc",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "textPath",
  "marker",
  "symbol",
  "use",
  "clipPath",
  "mask",
  "pattern",
  "linearGradient",
  "radialGradient",
  "stop",
  "filter",
  "feGaussianBlur",
  "feOffset",
  "feMerge",
  "feMergeNode",
  "feColorMatrix",
  "feFlood",
  "feComposite",
];

// Presentation attributes, as hast property names. `style` is left out: the
// sanitizer doesn't parse CSS, so it could carry `url(…)` loads and overlays
// drawn over the app. `class` is left out too, so SVG can't pick up the app's
// own styles. Values with `url(…)` are limited to `url(#id)` after sanitizing.
const SVG_COMMON = [
  "transform",
  "fill",
  "fillOpacity",
  "fillRule",
  "stroke",
  "strokeWidth",
  "strokeOpacity",
  "strokeLinecap",
  "strokeLinejoin",
  "strokeDasharray",
  "strokeDashoffset",
  "strokeMiterlimit",
  "opacity",
  "clipPath",
  "clipRule",
  "mask",
  "filter",
  "vectorEffect",
  "visibility",
  "display",
];

const TEXT = ["x", "y", "dx", "dy", "textAnchor", "dominantBaseline", "fontFamily", "fontSize", "fontWeight", "fontStyle"];
const BOX = ["x", "y", "width", "height"];
const GRADIENT = ["gradientUnits", "gradientTransform", "spreadMethod", "href"];

const svgAttributes: Record<string, string[]> = {
  svg: ["xmlns", "viewBox", "preserveAspectRatio", "role", "ariaLabel", "ariaLabelledBy", "ariaDescribedBy"],
  path: ["d", "pathLength"],
  rect: [...BOX, "rx", "ry"],
  circle: ["cx", "cy", "r"],
  ellipse: ["cx", "cy", "rx", "ry"],
  line: ["x1", "y1", "x2", "y2"],
  polyline: ["points"],
  polygon: ["points"],
  text: [...TEXT, "alignmentBaseline", "letterSpacing", "wordSpacing", "writingMode"],
  tspan: TEXT,
  textPath: ["startOffset", "method", "spacing", "href"],
  marker: ["markerUnits", "refX", "refY", "markerWidth", "markerHeight", "orient", "viewBox", "preserveAspectRatio"],
  symbol: ["viewBox", "preserveAspectRatio"],
  use: [...BOX, "href"],
  clipPath: ["clipPathUnits"],
  mask: [...BOX, "maskUnits", "maskContentUnits"],
  pattern: [...BOX, "patternUnits", "patternContentUnits", "patternTransform", "viewBox", "preserveAspectRatio", "href"],
  linearGradient: ["x1", "y1", "x2", "y2", ...GRADIENT],
  radialGradient: ["cx", "cy", "r", "fx", "fy", "fr", ...GRADIENT],
  stop: ["offset", "stopColor", "stopOpacity"],
  filter: [...BOX, "filterUnits", "primitiveUnits"],
  feGaussianBlur: ["in", "stdDeviation", "edgeMode", "result"],
  feOffset: ["in", "dx", "dy", "result"],
  feMerge: ["result"],
  feMergeNode: ["in"],
  feColorMatrix: ["in", "type", "values", "result"],
  feFlood: [...BOX, "floodColor", "floodOpacity", "result"],
  feComposite: ["in", "in2", "operator", "k1", "k2", "k3", "k4", "result"],
};

// GitHub allows these on every element. `accessKey` would let a reply bind a
// keyboard shortcut in the app, and `tabIndex` reorder its focus.
const DROPPED = new Set(["accessKey", "tabIndex"]);

// Built in a function marked pure, as is `memo(...)` in `MarkdownContent`, so
// apps that don't render Markdown don't bundle it, or `rehype-sanitize`.
export const sanitizeSchema: Schema = /* @__PURE__ */ (() => {
  const base = defaultSchema.attributes ?? {};
  return {
    ...defaultSchema,
    tagNames: [...(defaultSchema.tagNames ?? []), ...SVG_TAGS],
    attributes: {
      ...base,
      "*": (base["*"] ?? []).filter((attribute) => typeof attribute !== "string" || !DROPPED.has(attribute)),
      ...Object.fromEntries(SVG_TAGS.map((tag) => [tag, [...SVG_COMMON, ...(svgAttributes[tag] ?? [])]])),
    },
    protocols: {
      ...defaultSchema.protocols,
      href: ["http", "https", "mailto"],
      src: ["http", "https"],
    },
    // Dropped with their content. Other disallowed elements, such as `form`, are
    // unwrapped and their content kept.
    strip: ["script", "style", "foreignObject", "iframe", "noscript", "template"],
  };
})();

const isElement = (node: RootContent | ElementContent | Root): node is Element => node.type === "element";

function walk(node: Root | Element, visit: (element: Element, parent: Root | Element, inSvg: boolean) => void, inSvg = false) {
  for (const child of node.children) {
    if (!isElement(child)) continue;
    const svg = inSvg || child.tagName === "svg";
    visit(child, node, svg);
    walk(child, visit, svg);
  }
}

// `url(#id)`, possibly quoted, which is all an SVG attribute may reference.
const URL_REFERENCE = /url\(\s*(['"]?)([^)'"]*)\1\s*\)/gi;

/**
 * Runs after sanitizing. The sanitizer prefixes every `id` with `user-content-`,
 * so the app's own ids can't be clobbered. This points in-page references at
 * the prefixed ids, as GitHub does: `href="#x"`, and `url(#x)` in SVG. In SVG,
 * a reference to anything but an id in the same reply is removed, so a reply
 * can't load an outside resource, which could track that it was viewed.
 */
export function rehypeSafeReferences() {
  const prefix = defaultSchema.clobberPrefix ?? "user-content-";
  return (tree: Root) => {
    walk(tree, (element, _parent, inSvg) => {
      const { properties } = element;
      for (const key of Object.keys(properties)) {
        const value = properties[key];
        if (typeof value !== "string") continue;

        if (key === "href" || key === "xLinkHref") {
          // Footnote links too: their ids already had the prefix before the
          // sanitizer added it again.
          if (value.startsWith("#")) {
            properties[key] = `#${prefix}${value.slice(1)}`;
          } else if (inSvg && element.tagName !== "a") {
            delete properties[key];
          }
          continue;
        }

        if (inSvg && /url\(/i.test(value)) {
          let external = false;
          const rewritten = value.replace(URL_REFERENCE, (_, _quote, target: string) => {
            if (!target.startsWith("#")) external = true;
            return `url(#${prefix}${target.slice(1)})`;
          });
          if (external || /url\(/i.test(rewritten.replace(URL_REFERENCE, ""))) delete properties[key];
          else properties[key] = rewritten;
        }
      }
    });
  };
}

/**
 * Runs after sanitizing. An image in a reply is shown as a link to it rather
 * than loaded: a reply steered by something the agent read could otherwise use
 * an image URL to send data from the conversation to another server, or to
 * track that it was viewed. An image inside a link becomes its alt text, so
 * links don't nest.
 */
export function rehypeImagesInLinks() {
  return (tree: Root) => {
    const inLink = (node: Root | Element, linked: boolean) => {
      node.children.forEach((child, index) => {
        if (!isElement(child)) return;
        if (linked && child.tagName === "img") {
          const alt = child.properties.alt;
          node.children[index] = { type: "text", value: typeof alt === "string" ? alt : "" };
          return;
        }
        inLink(child, linked || child.tagName === "a");
      });
    };
    inLink(tree, false);
  };
}

// GitHub Flavored Markdown: tables, strikethrough, task lists, footnotes and
// autolink literals (bare URLs and emails).
//
// This is `remark-gfm` without one part. `remark-gfm` pulls in
// `mdast-util-gfm-autolink-literal`, whose second autolink pass uses regex
// lookbehind (from 2.0.1). A regex literal with lookbehind is a syntax error in
// Safari before 16.4, which then refuses to load the whole bundle. So this wires
// up the same syntax and tree extensions, but turns literal autolinks into links
// with the handlers below instead: micromark finds them while parsing (GitHub's
// first algorithm), which is what links `https://…`, `www.…` and emails in
// practice. The second pass, which only adds links micromark doesn't find, such
// as a URL written with character references, is left out.

import type { Link } from "mdast";
import type { CompileContext, Extension, Token } from "mdast-util-from-markdown";
import { gfmFootnoteFromMarkdown } from "mdast-util-gfm-footnote";
import { gfmStrikethroughFromMarkdown } from "mdast-util-gfm-strikethrough";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { gfmTaskListItemFromMarkdown } from "mdast-util-gfm-task-list-item";
import { gfm } from "micromark-extension-gfm";

function enterLiteralAutolink(this: CompileContext, token: Token) {
  this.enter({ type: "link", title: null, url: "", children: [] }, token);
}

function enterLiteralAutolinkValue(this: CompileContext, token: Token) {
  this.config.enter.autolinkProtocol!.call(this, token);
}

function exitLiteralAutolinkHttp(this: CompileContext, token: Token) {
  this.config.exit.autolinkProtocol!.call(this, token);
}

function exitLiteralAutolinkWww(this: CompileContext, token: Token) {
  this.config.exit.data!.call(this, token);
  const node = this.stack[this.stack.length - 1] as Link;
  node.url = "http://" + this.sliceSerialize(token);
}

function exitLiteralAutolinkEmail(this: CompileContext, token: Token) {
  this.config.exit.autolinkEmail!.call(this, token);
}

function exitLiteralAutolink(this: CompileContext, token: Token) {
  this.exit(token);
}

const autolinkLiteralFromMarkdown: Extension = {
  enter: {
    literalAutolink: enterLiteralAutolink,
    literalAutolinkEmail: enterLiteralAutolinkValue,
    literalAutolinkHttp: enterLiteralAutolinkValue,
    literalAutolinkWww: enterLiteralAutolinkValue,
  },
  exit: {
    literalAutolink: exitLiteralAutolink,
    literalAutolinkEmail: exitLiteralAutolinkEmail,
    literalAutolinkHttp: exitLiteralAutolinkHttp,
    literalAutolinkWww: exitLiteralAutolinkWww,
  },
};

interface ProcessorData {
  micromarkExtensions?: unknown[];
  fromMarkdownExtensions?: unknown[];
}

/** A remark plugin for GFM, as `remark-gfm` with its default options. */
export function remarkGfm(this: { data(): object }) {
  const data = this.data() as ProcessorData;
  (data.micromarkExtensions ??= []).push(gfm());
  (data.fromMarkdownExtensions ??= []).push([
    autolinkLiteralFromMarkdown,
    gfmFootnoteFromMarkdown(),
    gfmStrikethroughFromMarkdown(),
    gfmTableFromMarkdown(),
    gfmTaskListItemFromMarkdown(),
  ]);
}

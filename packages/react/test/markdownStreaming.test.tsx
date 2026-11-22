// MarkdownContent splits a streaming reply into blocks and only parses the last
// one again. These check that the result is always what rendering the whole
// text at once gives, and that it stays fast on a long reply.
import { render } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarkdownContent, type MarkdownContentProps, type MarkdownExtension } from "../src";
import { splitting } from "../src/markdown/blocks";
import { html } from "../src/html";
import { math } from "../src/math";
import { samples } from "./markdownCorpus";

type Options = Omit<MarkdownContentProps, "content">;

/** The HTML for `content` rendered on its own, in one go. */
function whole(content: string, options: Options = {}): string {
  const { container, unmount } = render(<MarkdownContent content={content} {...options} />);
  const html = container.innerHTML;
  unmount();
  return html;
}

/** Streams `content` in chunks of `step` characters, checking each render against `whole`. */
function expectStreamMatchesWhole(content: string, step: number, options: Options = {}) {
  const { container, rerender, unmount } = render(<MarkdownContent content="" {...options} />);
  for (let end = 0; end <= content.length; end = end === content.length ? end + 1 : Math.min(end + step, content.length)) {
    const prefix = content.slice(0, end);
    rerender(<MarkdownContent content={prefix} {...options} />);
    const streamed = container.innerHTML;
    if (streamed !== whole(prefix, options)) {
      // Fails with a readable diff, naming the prefix.
      expect({ prefix, html: streamed }).toEqual({ prefix, html: whole(prefix, options) });
    }
  }
  unmount();
}

/** An extension that counts how many times a block is parsed. */
function parseCounter() {
  const counter = { parses: 0, extension: {} as MarkdownExtension };
  counter.extension = {
    remarkPlugins: [
      () => () => {
        counter.parses++;
      },
    ],
  };
  return counter;
}

describe("MarkdownContent while streaming", () => {
  // Split at every node, rather than into blocks of about 1 KB, so the samples
  // have many splits to get wrong.
  beforeAll(() => {
    splitting.minBlock = 1;
  });
  afterAll(() => {
    splitting.minBlock = 1024;
  });

  const small = ["lists", "nested", "code", "tables", "quotes", "headings", "html"];

  it.each(small)("renders the %s sample as the whole text would, at every prefix", (name) => {
    expectStreamMatchesWhole(samples[name]!, 1);
  });

  it.each(small)("renders the %s sample as the whole text would, at every prefix, with streaming on", (name) => {
    expectStreamMatchesWhole(samples[name]!, 1, { streaming: true });
  });

  // With HTML on, the HTML parser joins raw HTML across blocks, as in
  // <details> around paragraphs, so a split mustn't fall inside open HTML.
  it("renders the html sample with html() as the whole text would, at every prefix", () => {
    expectStreamMatchesWhole(samples.html!, 1, { extensions: [html()] });
    expectStreamMatchesWhole(samples.html!, 1, { extensions: [html()], streaming: true });
  });

  // `/>` only closes an element in SVG and MathML: `<details/>` stays open and
  // takes in what follows. A quote in an unquoted attribute value is just a
  // character.
  it.each([
    ["<details/>", "<details/>\n\nHidden one\n\nHidden two\n"],
    ["<div/>", "<div/>\n\nInside\n\nStill inside\n"],
    ["an unquoted value with a quote", "<div title=don't>\n\nInside\n\nStill inside\n</div>\n\nAfter\n"],
    ["a quoted value with >", '<div title="a > b">\n\nInside\n\n</div>\n\nAfter\n'],
    ["self-closing SVG", "<svg><rect/>\n\n</svg>\n\n<svg/>\n\nAfter\n\nMore\n"],
  ])("renders HTML with %s with html() as the whole text would, at every prefix", (_name, content) => {
    expectStreamMatchesWhole(content, 1, { extensions: [html()] });
  });

  it("renders maths as the whole text would, at every prefix", () => {
    expectStreamMatchesWhole(samples.math!, 1, { extensions: [math()] });
    expectStreamMatchesWhole(samples.math!, 1, { extensions: [math()], streaming: true });
  });

  it("renders a reply with definitions as the whole text would, at every prefix", () => {
    expectStreamMatchesWhole(samples.definitions!, 1);
  });

  it("renders a definition in a quote in a list as the whole text would, at every prefix", () => {
    expectStreamMatchesWhole("See [x].\n\nMore.\n\n- > [x]: https://example.com\n\nAnd [x] again.\n", 1);
  });

  it("renders every sample together as the whole text would, in uneven chunks", { timeout: 60_000 }, () => {
    const all = Object.entries(samples)
      .filter(([name]) => name !== "definitions")
      .map(([, sample]) => sample)
      .join("\n\n");
    for (const step of [4, 23]) {
      expectStreamMatchesWhole(all, step, { extensions: [html(), math()] });
      expectStreamMatchesWhole(all, step, { extensions: [html(), math()], streaming: true });
    }
  });

  it("starts over when the text is replaced rather than extended", () => {
    const options = { streaming: true };
    const { container, rerender } = render(<MarkdownContent content={samples.lists!} {...options} />);
    rerender(<MarkdownContent content={`${samples.lists!}\n\nMore`} {...options} />);
    for (const next of [samples.quotes!, samples.lists!.replace("Bold", "Red"), ""]) {
      rerender(<MarkdownContent content={next} {...options} />);
      expect(container.innerHTML).toBe(whole(next, options));
    }
  });

  it("only parses the last block again as tokens arrive", () => {
    const counter = parseCounter();
    const options = { extensions: [counter.extension] };
    const content = Object.values(samples)
      .filter((sample) => sample !== samples.definitions)
      .join("\n\n");
    const { rerender } = render(<MarkdownContent content="" {...options} />);
    for (let end = 1; end <= content.length; end++) {
      rerender(<MarkdownContent content={content.slice(0, end)} {...options} />);
    }
    // The newline ends the last sample's line, so the block before it can be
    // split off. That block is parsed once more, on its own, with the next token.
    let text = `${content}\n\nOne more`;
    rerender(<MarkdownContent content={text} {...options} />);
    counter.parses = 0;
    rerender(<MarkdownContent content={(text += " paragraph")} {...options} />);
    expect(counter.parses).toBe(2);
    for (const token of [",", " longer", " still."]) {
      counter.parses = 0;
      rerender(<MarkdownContent content={(text += token)} {...options} />);
      expect(counter.parses).toBe(1);
    }
  });

  // Without html(), HTML shows as text, so a tag that's never closed, such as
  // `<String>` in `List<String>`, doesn't stop the reply being split.
  it("keeps splitting after an unclosed tag without html()", () => {
    const parsed: string[] = [];
    const options = {
      extensions: [{ remarkPlugins: [() => (_tree: unknown, file: { value: unknown }) => void parsed.push(String(file.value))] }],
    };
    let text = `Use a List<String> here.\n\n${samples.lists!}\n\nOne more`;
    const { rerender } = render(<MarkdownContent content={text} {...options} />);
    rerender(<MarkdownContent content={(text += " paragraph")} {...options} />);
    parsed.length = 0;
    rerender(<MarkdownContent content={(text += ".")} {...options} />);
    // Only the last block or two, not the reply from the top.
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).not.toContain("List<String>");
    expect(parsed[0]!.length).toBeLessThan(40);
  });

  it("parses a reply that may have a definition whole", () => {
    const counter = parseCounter();
    const options = { extensions: [counter.extension] };
    const content = `${samples.lists!}\n\n[docs]: https://example.com`;
    const { rerender } = render(<MarkdownContent content={content} {...options} />);
    rerender(<MarkdownContent content={`${content}\n\nMore`} {...options} />);
    rerender(<MarkdownContent content={`${content}\n\nMore text`} {...options} />);
    expect(counter.parses).toBe(3);
  });
});

/** About 52 KB of varied Markdown, like a long agent reply. */
function longReply(): string {
  const parts: string[] = [];
  for (let i = 0; parts.join("\n\n").length < 52_000; i++) {
    parts.push(
      `## Section ${i}`,
      `Here is **some text** with \`inline code\` and a [link](https://example.com/${i}). It goes on for a while, like a real paragraph of an agent's reply, with https://example.com/bare too.`,
      `1. First step\n2. Second step, with code:\n\n   \`\`\`ts\n   const x = ${i};\n\n   console.log(x);\n   \`\`\`\n\n3. Third step`,
      `| Name | Value |\n| --- | --- |\n| a | ${i} |\n| b | ${i * 2} |`,
      `> A quote about ${i}.\n> Over two lines.`,
      `- bullet one\n- bullet two\n  - nested`,
    );
  }
  return parts.join("\n\n");
}

/** Streams `content` in chunks, timing each render once at least `from` characters are in. */
function timeStream(content: string, chunk: number, from: number, options: Options = {}) {
  const { rerender, unmount } = render(<MarkdownContent content="" {...options} />);
  const times: number[] = [];
  for (let end = chunk; end < content.length + chunk; end += chunk) {
    const start = performance.now();
    rerender(<MarkdownContent content={content.slice(0, end)} {...options} />);
    if (end >= from) times.push(performance.now() - start);
  }
  unmount();
  times.sort((a, b) => a - b);
  return {
    mean: times.reduce((sum, time) => sum + time, 0) / times.length,
    p95: times[Math.floor(times.length * 0.95)]!,
    renders: times.length,
  };
}

/** Renders all of `content` but the last `count` chunks, then times rendering each of those. */
function timeWhole(content: string, chunk: number, count: number) {
  const { rerender, unmount } = render(<MarkdownContent content={content.slice(0, -chunk * count)} streaming />);
  let total = 0;
  for (let i = count - 1; i >= 0; i--) {
    const start = performance.now();
    rerender(<MarkdownContent content={i ? content.slice(0, -chunk * i) : content} streaming />);
    total += performance.now() - start;
  }
  unmount();
  return { mean: total / count };
}

describe("MarkdownContent performance", () => {
  it("renders each token of a 50 KB reply quickly", () => {
    const content = longReply();
    expect(content.length).toBeGreaterThanOrEqual(50_000);
    // Stream it all in 40-character chunks, and time the renders over its last 10 KB.
    const split = timeStream(content, 40, content.length - 10_000, { streaming: true });
    // The same reply parsed whole on every token, as without block splitting:
    // a definition at the start turns splitting off.
    const unsplit = timeWhole(`[x]: https://example.com\n\n${content}`, 40, 5);
    console.info(
      `50 KB reply, per token: split mean ${split.mean.toFixed(2)} ms, p95 ${split.p95.toFixed(2)} ms` +
        ` (${split.renders} renders); whole-text parse mean ${unsplit.mean.toFixed(2)} ms`,
    );
    expect(split.mean).toBeLessThan(10);
    expect(split.p95).toBeLessThan(25);
  });
});

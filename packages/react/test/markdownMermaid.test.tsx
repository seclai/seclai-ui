// mermaid() with the real Mermaid, rather than the mock in
// markdownExtensions.test.tsx, to check what a diagram can put on the page.
// jsdom doesn't lay out SVG, so text measures as a fixed size.
import { render, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";
import { MarkdownContent } from "../src";
import { mermaid } from "../src/mermaid";

beforeAll(() => {
  const prototype = SVGElement.prototype as unknown as Record<string, unknown>;
  prototype.getBBox = () => ({ x: 0, y: 0, width: 50, height: 20 });
  prototype.getComputedTextLength = () => 50;
});

async function diagram(source: string): Promise<string> {
  const { container } = render(
    <MarkdownContent content={`\`\`\`mermaid\n${source}\n\`\`\``} extensions={[mermaid()]} />,
  );
  await waitFor(() => expect(container.querySelector(".seclai-markdown-mermaid svg")).not.toBeNull(), {
    timeout: 5000,
  });
  return container.querySelector(".seclai-markdown-mermaid")!.innerHTML;
}

// Any `url(…)` other than `url(#id)`, or a URL of the test's hosts.
const OUTSIDE = /url\(\s*['"]?(?!#)|tracker\.example/;

describe("mermaid() with Mermaid", () => {
  it("ignores directives that would put outside URLs or page styles in the diagram's CSS", async () => {
    const init = {
      themeCSS: ".label { background: url(https://tracker.example/1) } & { position: fixed }",
      fontFamily: "x; background: url(https://tracker.example/2)",
      altFontFamily: "y; background: url(https://tracker.example/3)",
      themeVariables: { fontFamily: "z; background: url(https://tracker.example/4)" },
    };
    const svg = await diagram(`%%{init: ${JSON.stringify(init)}}%%\ngraph TD\n  A-->B`);
    expect(svg).toContain("<style>");
    expect(svg).not.toMatch(OUTSIDE);
    expect(svg).not.toContain("position: fixed");
    expect(svg).not.toContain("position:fixed");
  });

  it("doesn't load images or styles from labels, even when a directive allows them", async () => {
    const init = { dompurifyConfig: { ADD_TAGS: ["img"] } };
    const svg = await diagram(
      `%%{init: ${JSON.stringify(init)}}%%\ngraph TD\n` +
        `  A["<img src='https://tracker.example/i.png'> <b style='background: url(https://tracker.example/s)'>bold</b> <a href='javascript:alert(1)'>link</a>"]-->B`,
    );
    expect(svg).toContain("<b>bold</b>");
    expect(svg).not.toMatch(OUTSIDE);
    expect(svg).not.toMatch(/<img|javascript:/);
  });
});

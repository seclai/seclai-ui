import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import remarkGfmUpstream from "remark-gfm";
import { describe, expect, it, vi } from "vitest";
import { AgentRunForm, MarkdownContent, type MarkdownContentProps } from "../src";
import { html } from "../src/html";
import { remarkGfm } from "../src/markdown/gfm";
import { jsonResponse, sse, sseResponse } from "./helpers";

function md(content: string, options: Omit<MarkdownContentProps, "content"> = {}) {
  const { container, rerender } = render(<MarkdownContent content={content} {...options} />);
  const root = container.firstElementChild as HTMLElement;
  return {
    root,
    rerender: (next: string) => rerender(<MarkdownContent content={next} {...options} />),
    // Tag names of the blocks, such as ["p", "ol"].
    blocks: () => [...root.children].map((el) => el.tagName.toLowerCase()),
  };
}

/** Text with runs of whitespace, such as the newline after a `<br>`, as one space. */
const text = (el: Element | null | undefined) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();

/** Options that turn HTML on. */
const withHtml = { extensions: [html()] };

const items = (list: Element) =>
  [...list.querySelectorAll(":scope > li")].map((li) => ({
    value: (li as HTMLLIElement).value,
    number: li.querySelector(":scope > .seclai-markdown-number")?.textContent,
    text: text(li.lastElementChild),
  }));

describe("MarkdownContent", () => {
  it("keeps the seclai-markdown root", () => {
    const { root } = md("Hello");
    expect(root.tagName).toBe("DIV");
    expect(root.className).toBe("seclai-markdown");
  });

  it("splits paragraphs on blank lines and breaks lines on single newlines", () => {
    const { root, blocks } = md("First line\nsecond line\n\n\nNext paragraph");
    expect(blocks()).toEqual(["p", "p"]);
    const [first, second] = root.querySelectorAll("p");
    expect(first!.querySelectorAll("br")).toHaveLength(1);
    expect(text(first)).toBe("First line second line");
    expect(second!.textContent).toBe("Next paragraph");
  });

  it("handles Windows line endings", () => {
    const { blocks, root } = md("One\r\n\r\n1. Item");
    expect(blocks()).toEqual(["p", "ol"]);
    expect(root.textContent).not.toContain("\r");
  });

  describe("numbered lists", () => {
    it("renders them with a number badge", () => {
      const { root } = md("1. Sunset\n2. Beach");
      const ol = root.querySelector("ol")!;
      expect(ol.start).toBe(1);
      expect(ol.getAttribute("role")).toBe("list");
      expect(items(ol)).toEqual([
        { value: 1, number: "1", text: "Sunset" },
        { value: 2, number: "2", text: "Beach" },
      ]);
    });

    it("takes ) as well as . after the number, and starts a new list when it changes", () => {
      const { root, blocks } = md("1) Sunset\n2) Beach\n3. Forest");
      expect(blocks()).toEqual(["ol", "ol"]);
      const [first, second] = root.querySelectorAll("ol");
      expect(items(first!).map((item) => item.number)).toEqual(["1", "2"]);
      expect(items(second!)).toEqual([{ value: 3, number: "3", text: "Forest" }]);
    });

    it("keeps the agent's own numbers", () => {
      const { root } = md("3. Third\n4. Fourth\n7. Seventh");
      const ol = root.querySelector("ol")!;
      expect(ol.start).toBe(3);
      expect(items(ol).map((item) => [item.value, item.number])).toEqual([
        [3, "3"],
        [4, "4"],
        [7, "7"],
      ]);
    });

    it("keeps repeated numbers, which Markdown would count on from", () => {
      const { root } = md("1. One\n1. Two\n1. Three");
      expect(items(root.querySelector("ol")!).map((item) => [item.value, item.number])).toEqual([
        [1, "1"],
        [1, "1"],
        [1, "1"],
      ]);
    });

    it("keeps the numbers in a quote", () => {
      const { root } = md("> 2. Two\n> 5. Five");
      expect(items(root.querySelector("blockquote ol")!).map((item) => item.number)).toEqual(["2", "5"]);
    });

    it("numbers an HTML list on from its start", () => {
      const { root } = md('<ol start="4"><li>Four</li><li value="9">Nine</li><li>Ten</li></ol>',
        withHtml,
      );
      const ol = root.querySelector("ol")!;
      expect(ol.getAttribute("role")).toBe("list");
      expect(items(ol).map((item) => [item.value, item.number])).toEqual([
        [4, "4"],
        [9, "9"],
        [10, "10"],
      ]);
    });

    it("keeps items separated by blank lines in one list, and a paragraph splits it", () => {
      const { root, blocks } = md("1. One\n\n2. Two\n\nAside\n\n3. Three");
      expect(blocks()).toEqual(["ol", "p", "ol"]);
      const [first, second] = root.querySelectorAll("ol");
      expect(items(first!).map((item) => item.value)).toEqual([1, 2]);
      expect(second!.start).toBe(3);
    });

    it("continues an item with the lines straight after it", () => {
      const { root, blocks } = md("1. Sunset\n   Warm colours\n2. Beach");
      expect(blocks()).toEqual(["ol"]);
      expect(root.querySelector("li")!.querySelector("br")).not.toBeNull();
      expect(items(root.querySelector("ol")!)[0]!.text).toBe("Sunset Warm colours");
    });

    it("holds code blocks and paragraphs in an item without splitting the list", () => {
      const content = "1. Install it:\n\n   ```sh\n   npm install\n   ```\n\n   Then:\n2. Run it";
      const { root, blocks } = md(content);
      expect(blocks()).toEqual(["ol"]);
      const [first] = root.querySelectorAll("ol > li");
      expect(first!.querySelector("pre code")!.textContent).toBe("npm install\n");
      expect([...first!.querySelectorAll("p")].map((p) => p.textContent)).toEqual(["Install it:", "Then:"]);
      expect(items(root.querySelector("ol")!).map((item) => item.number)).toEqual(["1", "2"]);
    });
  });

  it("renders bulleted lists with -, *, + or •", () => {
    for (const marker of ["-", "*", "+", "•"]) {
      const { root, blocks } = md(`${marker} One\n${marker} Two`);
      expect(blocks()).toEqual(["ul"]);
      expect([...root.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["One", "Two"]);
    }
  });

  it("starts a new bulleted list when the marker changes", () => {
    const { blocks } = md("- One\n* Two");
    expect(blocks()).toEqual(["ul", "ul"]);
  });

  it("leaves • in code alone", () => {
    const { root } = md("```\n• not a bullet\n```\n\n`• nor this`");
    expect(root.querySelector("ul")).toBeNull();
    expect(root.querySelector("pre")!.textContent).toBe("• not a bullet\n");
  });

  it("doesn't take **bold** at the start of a line for a bullet", () => {
    const { root, blocks } = md("**Note** this is a paragraph");
    expect(blocks()).toEqual(["p"]);
    expect(root.querySelector("strong")!.textContent).toBe("Note");
    expect(root.textContent).toBe("Note this is a paragraph");
  });

  it("renders **bold**, also inside list items", () => {
    const { root } = md("A **big** and **bold** idea\n- **Title**: text\n\n1. Uses **bold**");
    expect([...root.querySelectorAll("strong")].map((el) => el.textContent)).toEqual([
      "big",
      "bold",
      "Title",
      "bold",
    ]);
    expect(root.querySelector("p")!.textContent).toBe("A big and bold idea");
  });

  it("renders bold around a code span", () => {
    const { root } = md("Saved as **`thumb.png`**");
    expect(root.querySelector("strong > code")!.textContent).toBe("thumb.png");
  });

  it("leaves ** that isn't Markdown bold as text", () => {
    const { root } = md("f(**args, **kwargs) and `**x**` and **** and ** spaced **");
    expect(root.querySelector("strong")).toBeNull();
    expect(root.textContent).toBe("f(**args, **kwargs) and **x** and **** and ** spaced **");
    expect(root.querySelector("code")!.textContent).toBe("**x**");
  });

  it("renders emphasis, strikethrough and inline code", () => {
    const { root } = md("*em* _em_ ~~gone~~ `x = 1`");
    expect([...root.querySelectorAll("em")].map((el) => el.textContent)).toEqual(["em", "em"]);
    expect(root.querySelector("del")!.textContent).toBe("gone");
    expect(root.querySelector("code")!.textContent).toBe("x = 1");
  });

  it("renders mixed content in order", () => {
    const content = [
      "Here are your thumbnails:",
      "",
      "1. **Bold** title on red",
      "2. Close-up with arrows",
      "",
      "Notes:",
      "- Both are 16:9",
      "- Text is large",
      "",
      "Want changes?",
    ].join("\n");
    const { root, blocks } = md(content);
    expect(blocks()).toEqual(["p", "ol", "p", "ul", "p"]);
    expect(items(root.querySelector("ol")!).map((item) => item.text)).toEqual([
      "Bold title on red",
      "Close-up with arrows",
    ]);
    expect(root.querySelectorAll("ul > li")).toHaveLength(2);
    expect(root.lastElementChild!.textContent).toBe("Want changes?");
  });

  it("starts a list right after a paragraph line", () => {
    const { blocks } = md("Options:\n- One\n- Two");
    expect(blocks()).toEqual(["p", "ul"]);
  });

  it("renders headings", () => {
    const { blocks, root } = md("# One\n## Two\n### Three\n#### Four\n##### Five\n###### Six\n####### Seven");
    expect(blocks()).toEqual(["h1", "h2", "h3", "h4", "h5", "h6", "p"]);
    expect(root.querySelector("h2")!.textContent).toBe("Two");
  });

  it("renders block quotes, with blocks inside", () => {
    const { root, blocks } = md("> Quoted **text**\n>\n> - a list\n\nAfter");
    expect(blocks()).toEqual(["blockquote", "p"]);
    const quote = root.querySelector("blockquote")!;
    expect(quote.querySelector("strong")!.textContent).toBe("text");
    expect(quote.querySelector("ul li")!.textContent).toBe("a list");
  });

  describe("links", () => {
    it("renders Markdown links, opening external ones in a new tab", () => {
      const { root } = md(
        "[Seclai](https://seclai.com) and [home](/home) and [top](#top) and [mail](mailto:hi@seclai.com)",
      );
      const [external, relative, hash, mail] = root.querySelectorAll("a");
      expect(external!.getAttribute("href")).toBe("https://seclai.com");
      expect(external!.target).toBe("_blank");
      expect(external!.rel).toBe("noopener noreferrer");
      expect(relative!.getAttribute("href")).toBe("/home");
      expect(relative!.hasAttribute("target")).toBe(false);
      // In-page links point at ids as the sanitizer prefixes them.
      expect(hash!.getAttribute("href")).toBe("#user-content-top");
      expect(mail!.getAttribute("href")).toBe("mailto:hi@seclai.com");
      expect(mail!.hasAttribute("target")).toBe(false);
    });

    it("links bare URLs and emails", () => {
      const { root } = md("See https://seclai.com/docs, www.seclai.com and hi@seclai.com.");
      expect([...root.querySelectorAll("a")].map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
        ["https://seclai.com/docs", "https://seclai.com/docs"],
        ["www.seclai.com", "http://www.seclai.com"],
        ["hi@seclai.com", "mailto:hi@seclai.com"],
      ]);
      expect(root.querySelector("a")!.target).toBe("_blank");
    });

    // The GFM plugin here leaves out remark-gfm's second autolink pass, which
    // uses regex lookbehind. See src/markdown/gfm.ts.
    it("links bare URLs as remark-gfm does, except ones written with character references", () => {
      const html = (content: string, plugin: typeof remarkGfm) =>
        renderToStaticMarkup(<Markdown remarkPlugins={[plugin]}>{content}</Markdown>);
      const same = [
        "Visit https://example.com. Or www.example.com/path?x=1, and me@example.com!",
        "See (https://en.wikipedia.org/wiki/Foo_(bar)) and <https://x.y> and http://a.b/c_d",
        "mailto:foo@bar.com, xmpp:foo@bar.com/res and a@b.c-d, a.b-c_d@a.b",
        "Trailing https://example.com/a). and https://example.com/path#frag;",
        "In *emphasis https://example.com* and **www.example.com** and `https://code.example.com`",
        "[link https://inner.example.com](https://outer.example.com)",
        "Unicode https://example.com/ü and 中文https://example.com and _https://example.com_",
        "Punctuation:(foo@bar.com) and x@y.z. and test.@x.com",
      ];
      for (const content of same) expect(html(content, remarkGfm)).toBe(html(content, remarkGfmUpstream));
      const references = "https&#58;//example.com and www&#46;example.com";
      expect(html(references, remarkGfm)).toBe("<p>https://example.com and www.example.com</p>");
    });

    it("links <https://…> autolinks", () => {
      const { root } = md("<https://seclai.com>");
      expect(root.querySelector("a")!.getAttribute("href")).toBe("https://seclai.com");
    });

    it("links reference-style links", () => {
      const { root } = md("See [the docs][docs].\n\n[docs]: https://seclai.com/docs");
      expect(root.querySelector("a")!.getAttribute("href")).toBe("https://seclai.com/docs");
    });
  });

  it("shows images as links to them, with the alt text", () => {
    const { root } = md("![A cat](https://example.com/cat.png) and ![](https://example.com/dog.png)");
    expect(root.querySelector("img")).toBeNull();
    const [cat, dog] = root.querySelectorAll("a.seclai-markdown-image");
    expect(cat!.textContent).toBe("A cat");
    expect(cat!.getAttribute("href")).toBe("https://example.com/cat.png");
    expect((cat as HTMLAnchorElement).target).toBe("_blank");
    expect(dog!.textContent).toBe("https://example.com/dog.png");
  });

  it("shows an image inside a link as its alt text, so links don't nest", () => {
    const { root } = md("[![Badge](https://example.com/b.svg)](https://example.com)");
    expect(root.querySelectorAll("a")).toHaveLength(1);
    expect(root.querySelector("a")!.textContent).toBe("Badge");
  });

  describe("code", () => {
    it("renders fenced code verbatim, blank lines and all", () => {
      const content = "```py\n- not a bullet\n\nf(**a**)\n```\nAfter";
      const { root, blocks } = md(content);
      expect(blocks()).toEqual(["pre", "p"]);
      expect(root.querySelector("ul, strong")).toBeNull();
      const code = root.querySelector("pre > code")!;
      expect(code.className).toBe("language-py");
      expect(code.textContent).toBe("- not a bullet\n\nf(**a**)\n");
      expect(root.lastElementChild!.textContent).toBe("After");
    });

    it("closes a fence only on a fence line at least as long, with the same character", () => {
      const content = "````md\n```\n- not a bullet\n~~~~\n```` \n- bullet";
      const { root, blocks } = md(content);
      expect(blocks()).toEqual(["pre", "ul"]);
      expect(root.querySelector("pre")!.textContent).toBe("```\n- not a bullet\n~~~~\n");
      expect(root.querySelector("li")!.textContent).toBe("bullet");
    });

    it("takes a one-line ```code``` for a code span, not a fence that never closes", () => {
      const { root, blocks } = md("Run ```ls``` first\n```ls```\n\n**Done**");
      expect(blocks()).toEqual(["p", "p"]);
      expect([...root.querySelectorAll("code")].map((code) => code.textContent)).toEqual(["ls", "ls"]);
      expect(root.querySelector("strong")!.textContent).toBe("Done");
    });

    it("renders indented code", () => {
      const { root } = md("Text\n\n    indented\n    code");
      expect(root.querySelector("pre code")!.textContent).toBe("indented\ncode\n");
    });

    it("keeps a rule inside a code fence literal", () => {
      const { root, blocks } = md("```\n---\n* * *\n```");
      expect(blocks()).toEqual(["pre"]);
      expect(root.querySelector("hr, ul")).toBeNull();
      expect(root.textContent).toBe("---\n* * *\n");
    });
  });

  describe("tables", () => {
    it("renders a table in a scrolling wrapper, with alignment", () => {
      const { root, blocks } = md("| Name | Score |\n| :-- | --: |\n| Ann | 3 |\n| Bo | 10 |");
      expect(blocks()).toEqual(["div"]);
      const wrapper = root.firstElementChild!;
      expect(wrapper.className).toBe("seclai-markdown-table");
      expect([...wrapper.querySelectorAll("th")].map((th) => th.textContent)).toEqual(["Name", "Score"]);
      expect([...wrapper.querySelectorAll("tbody td")].map((td) => td.textContent)).toEqual(["Ann", "3", "Bo", "10"]);
      expect((wrapper.querySelector("td + td") as HTMLElement).style.textAlign).toBe("right");
    });

    it("keeps <br> in a cell", () => {
      const { root } = md("| a |\n| - |\n| one<br>two |");
      expect(root.querySelector("td br")).not.toBeNull();
    });
  });

  it("renders task lists with disabled checkboxes", () => {
    const { root } = md("- [ ] todo\n- [x] done");
    const boxes = [...root.querySelectorAll<HTMLInputElement>("li input[type=checkbox]")];
    expect(boxes.map((box) => [box.checked, box.disabled])).toEqual([
      [false, true],
      [true, true],
    ]);
    expect(root.querySelector("ul")!.className).toBe("contains-task-list");
  });

  it("renders footnotes with working links", () => {
    const { root } = md("A claim.[^1]\n\n[^1]: The source.");
    const ref = root.querySelector("a[data-footnote-ref]")!;
    const target = ref.getAttribute("href")!.slice(1);
    expect(root.querySelector(`[id="${target}"]`)!.textContent).toContain("The source.");
    const back = root.querySelector("a[data-footnote-backref]")!;
    expect(root.querySelector(`[id="${back.getAttribute("href")!.slice(1)}"]`)).toBe(ref);
  });

  it("shows HTML as the text it is, unless html() is on", () => {
    const content = '<script>alert(1)</script>\n- <img src=x onerror="alert(1)">\n\n**<b>hi</b>** H<sub>2</sub>O';
    const { root } = md(content);
    expect(root.querySelector("script, img, b, sub")).toBeNull();
    expect(root.textContent).toContain("<script>alert(1)</script>");
    expect(text(root.querySelector("li"))).toBe('<img src=x onerror="alert(1)">');
    expect(root.querySelector("strong")!.textContent).toBe("<b>hi</b>");
    expect(root.querySelector("p")!.textContent).toBe("<b>hi</b> H<sub>2</sub>O");
  });

  it("renders allowed HTML with html()", () => {
    const { root } = md(
      "H<sub>2</sub>O, <kbd>Ctrl</kbd>\n\n<details>\n<summary>More</summary>\n\nHidden **text**\n\n</details>",
      withHtml,
    );
    expect(root.querySelector("sub")!.textContent).toBe("2");
    expect(root.querySelector("kbd")!.textContent).toBe("Ctrl");
    expect(root.querySelector("details summary")!.textContent).toBe("More");
    expect(root.querySelector("details strong")!.textContent).toBe("text");
  });

  it("renders inline SVG with html()", () => {
    const { root } = md(
      '<svg viewBox="0 0 10 10" role="img" aria-label="Chart"><defs><linearGradient id="g"><stop offset="0" stop-color="red"/></linearGradient></defs><rect width="10" height="5" fill="url(#g)" transform="rotate(1)"/></svg>',
      withHtml,
    );
    const svg = root.querySelector("svg")!;
    expect(svg.getAttribute("aria-label")).toBe("Chart");
    const rect = svg.querySelector("rect")!;
    // Ids are prefixed by the sanitizer, and references follow them.
    expect(svg.querySelector("linearGradient")!.id).toBe("user-content-g");
    expect(rect.getAttribute("fill")).toBe("url(#user-content-g)");
    expect(rect.getAttribute("transform")).toBe("rotate(1)");
  });

  describe("rules", () => {
    it("renders ---, ***, ___ and spaced forms as a rule", () => {
      for (const rule of ["---", "***", "___", "* * *", "- - -", "_ _ _", "  ----  ", "*\t*\t*"]) {
        const { root, blocks } = md(rule);
        expect(blocks()).toEqual(["hr"]);
        expect(root.querySelector("ul, li")).toBeNull();
      }
    });

    it("ends a list at a rule, and makes the line above --- a heading", () => {
      const { root, blocks } = md("Intro\n---\n- One\n* * *\n1. Two\n___\nOutro");
      expect(blocks()).toEqual(["h2", "ul", "hr", "ol", "hr", "p"]);
      expect(root.querySelector("h2")!.textContent).toBe("Intro");
      expect(text(root.querySelector("ul"))).toBe("One");
      expect(items(root.querySelector("ol")!)[0]!.text).toBe("Two");
    });

    it("leaves --, ** and -- note as text", () => {
      const { root, blocks } = md("--\n\n**\n\n-- note");
      expect(blocks()).toEqual(["p", "p", "p"]);
      expect(root.querySelector("hr, ul, strong")).toBeNull();
      expect(root.textContent).toBe("--**-- note");
    });
  });

  describe("nested lists", () => {
    it("nests an indented item under the item before it", () => {
      const { root, blocks } = md("- Fruit\n  - Apple\n  - Pear\n- Veg");
      expect(blocks()).toEqual(["ul"]);
      const top = root.querySelector("ul")!;
      expect(top.querySelectorAll(":scope > li")).toHaveLength(2);
      const nested = top.querySelector(":scope > li > ul")!;
      expect([...nested.children].map((li) => li.textContent)).toEqual(["Apple", "Pear"]);
      expect(text(top.lastElementChild)).toBe("Veg");
    });

    it("nests an item indented to the text of the item above, or by a tab", () => {
      const { root } = md("- One\n - Two\n\t- Three");
      const top = root.querySelector("ul")!;
      expect(top.querySelectorAll(":scope > li")).toHaveLength(2);
      expect(top.querySelector("li li")!.textContent).toBe("Three");
    });

    it("nests under a numbered item only when indented to its text", () => {
      // "10. " puts the text 4 columns in, so 3 spaces isn't enough.
      const { root, blocks } = md("10. Ten\n   - Not nested\n\n10. Ten\n    - Nested");
      expect(blocks()).toEqual(["ol", "ul", "ol"]);
      expect(root.lastElementChild!.querySelector("li ul li")!.textContent).toBe("Nested");
    });

    it("nests three levels of mixed lists and dedents back out", () => {
      // A numbered list that starts at 3 can't interrupt a paragraph, so the
      // blank line before "3. Intro" makes it a list rather than more text.
      const content = [
        "1. Thumbnails",
        "   - Red",
        "     1. Bold title",
        "     2. Small title",
        "        More detail",
        "   - Blue",
        "2. Video",
        "",
        "   3. Intro",
        "- Notes",
      ].join("\n");
      const { root, blocks } = md(content);
      expect(blocks()).toEqual(["ol", "ul"]);

      const top = root.querySelector("ol")!;
      expect(items(top).map((item) => [item.value, item.number])).toEqual([
        [1, "1"],
        [2, "2"],
      ]);
      const [first, second] = top.querySelectorAll(":scope > li");
      const colours = first!.querySelector("ul")!;
      expect(colours.querySelectorAll(":scope > li")).toHaveLength(2);

      const titles = colours.querySelector("ol")!;
      expect(titles.getAttribute("role")).toBe("list");
      expect(titles.start).toBe(1);
      expect(items(titles)).toEqual([
        { value: 1, number: "1", text: "Bold title" },
        { value: 2, number: "2", text: "Small title More detail" },
      ]);
      expect(colours.lastElementChild!.textContent).toBe("Blue");

      const intro = second!.querySelector("ol")!;
      expect(intro.start).toBe(3);
      expect(items(intro)).toEqual([{ value: 3, number: "3", text: "Intro" }]);
      expect(text(root.lastElementChild)).toBe("Notes");
    });

    it("starts a new list at a level when the marker kind changes", () => {
      const { root } = md("- Parent\n  - Bullet\n  1. Number");
      const parent = root.querySelector("ul > li")!;
      expect([...parent.children].map((el) => el.tagName.toLowerCase())).toEqual(["ul", "ol"]);
    });

    it("keeps nested items in their list across blank lines", () => {
      const { root, blocks } = md("1. One\n\n   - Sub\n\n   - Sub two\n\n2. Two\n\nAfter");
      expect(blocks()).toEqual(["ol", "p"]);
      expect(root.querySelectorAll("ol > li > div > ul > li")).toHaveLength(2);
      expect(items(root.querySelector("ol")!).map((item) => item.value)).toEqual([1, 2]);
    });
  });

  describe("while streaming", () => {
    it("holds back a last line that's only a marker so far", () => {
      for (const partial of ["1.", "1. ", "2)", "12", "- ", "*", "•", "#", "> ", "```", "~~", "$$", "|", "| --- |"]) {
        const { root } = md(`Before\n${partial}`, { streaming: true });
        expect({ partial, html: root.innerHTML }).toEqual({ partial, html: "<p>Before</p>" });
      }
    });

    it("shows the line once text follows the marker", () => {
      const { root, blocks, rerender } = md("1. Sunset\n2.", { streaming: true });
      expect(items(root.querySelector("ol")!)).toHaveLength(1);
      rerender("1. Sunset\n2. Beach");
      expect(blocks()).toEqual(["ol"]);
      expect(items(root.querySelector("ol")!).map((item) => item.value)).toEqual([1, 2]);
    });

    it("shows the line once the text is finished", () => {
      const { blocks, rerender } = md("Text\n\n---", { streaming: true });
      expect(blocks()).toEqual(["p"]);
      rerender("Text\n\n---\n");
      expect(blocks()).toEqual(["p", "hr"]);
      expect(md("Text\n\n---").blocks()).toEqual(["p", "hr"]);
    });

    it("doesn't flash the line above a bullet as a heading", () => {
      const { root, blocks, rerender } = md("Options:\n-", { streaming: true });
      expect(blocks()).toEqual(["p"]);
      rerender("Options:\n- One");
      expect(blocks()).toEqual(["p", "ul"]);
      expect(root.querySelector("h2")).toBeNull();
    });

    it("doesn't flash a rule's first characters as a bullet", () => {
      const { blocks, rerender } = md("- One\n- -", { streaming: true });
      expect(blocks()).toEqual(["ul"]);
      rerender("- One\n- - -\n");
      expect(blocks()).toEqual(["ul", "hr"]);
    });

    it("holds back a nested item's marker until its text arrives", () => {
      const { root, rerender } = md("1. One\n   -", { streaming: true });
      expect(items(root.querySelector("ol")!)[0]!.text).toBe("One");
      expect(root.querySelector("ul")).toBeNull();
      rerender("1. One\n   - Sub");
      expect(root.querySelector("ol li ul li")!.textContent).toBe("Sub");
    });

    it("shows an unclosed ** as text, then bold once it closes", () => {
      const { root, rerender } = md("A **bol", { streaming: true });
      expect(root.querySelector("strong")).toBeNull();
      expect(root.textContent).toBe("A **bol");
      rerender("A **bold**");
      expect(root.querySelector("strong")!.textContent).toBe("bold");
    });

    it("shows a list item's unclosed ** as text", () => {
      const { root } = md("1. **Sunset", { streaming: true });
      expect(root.querySelector("strong")).toBeNull();
      expect(items(root.querySelector("ol")!)[0]!.text).toBe("**Sunset");
    });

    it("shows an unclosed link as text", () => {
      const { root, rerender } = md("See [the docs](https://sec", { streaming: true });
      expect(root.textContent).toBe("See [the docs](https://sec");
      rerender("See [the docs](https://seclai.com/docs)");
      expect(root.querySelector("a")!.textContent).toBe("the docs");
    });

    it("shows an unclosed code fence as a code block to the end", () => {
      const { root, blocks } = md("```py\n- one\n\n**x**", { streaming: true });
      expect(blocks()).toEqual(["pre"]);
      expect(root.querySelector("ul, strong")).toBeNull();
      expect(root.querySelector("code")!.textContent).toBe("- one\n\n**x**\n");
    });

    it("shows a table's header row as text until its delimiter row arrives", () => {
      const { root, blocks, rerender } = md("| Name | Score |", { streaming: true });
      expect(blocks()).toEqual(["p"]);
      rerender("| Name | Score |\n| --- | -");
      expect(blocks()).toEqual(["p"]);
      expect(root.textContent).toBe("| Name | Score |");
      rerender("| Name | Score |\n| --- | --- |\n| Ann");
      expect(blocks()).toEqual(["div"]);
      expect(root.querySelector("tbody td")!.textContent).toBe("Ann");
    });
  });

  // With html() on: without it, HTML is text, as tested above.
  describe("security", () => {
    it("drops scripts and event handlers", () => {
      const { root } = md(
        '<script>alert(1)</script>\n\n<img src="https://example.com/x.png" onerror="alert(1)">\n\n<a href="https://example.com" onclick="alert(1)" onmouseover="alert(1)">x</a>',
        withHtml,
      );
      expect(root.querySelector("script")).toBeNull();
      expect(root.textContent).not.toContain("alert");
      expect(root.innerHTML).not.toMatch(/\bon[a-z]+=/i);
    });

    it("removes javascript:, data: and other unsafe URLs from links", () => {
      const { root } = md(
        '[a](javascript:alert(1)) [b](JaVaScRiPt:alert(1)) [c](data:text/html,x) [d](vbscript:x) <a href=" javascript:alert(1)">e</a> <a href="java&#x09;script:alert(1)">f</a> [g](file:///etc/passwd)',
        withHtml,
      );
      expect(root.querySelector("a")).toBeNull();
      expect(text(root)).toBe("a b c d e f g");
    });

    it("drops iframes, styles, objects and forms", () => {
      const { root } = md(
        '<iframe src="https://example.com">inside</iframe>\n\n<style>body { display: none }</style>\n\n<object data="x.swf"></object><embed src="x.swf"><form action="https://example.com"><input name="q"><button>Go</button></form>',
        withHtml,
      );
      expect(root.querySelector("iframe, style, object, embed, form, button")).toBeNull();
      // Inputs are allowed for task lists, so this one becomes a disabled checkbox.
      const input = root.querySelector("input")!;
      expect([input.type, input.disabled]).toEqual(["checkbox", true]);
      expect(root.textContent).not.toContain("display");
      expect(root.textContent).not.toContain("inside");
    });

    it("drops style, class, accesskey and tabindex attributes, and prefixes ids", () => {
      const { root } = md(
        '<a href="https://example.com" style="position:fixed;inset:0" class="seclai-button" accesskey="s" tabindex="1" id="root">x</a>',
        withHtml,
      );
      const a = root.querySelector("a")!;
      expect(a.getAttributeNames().filter((name) => name !== "class").sort()).toEqual(["href", "id", "rel", "target"]);
      expect(a.className).toBe("");
      expect(a.id).toBe("user-content-root");
    });

    it("drops scripts, foreignObject, handlers, styles and outside references from SVG", () => {
      const { root } = md(
        [
          '<svg viewBox="0 0 10 10" onload="alert(1)">',
          "<script>alert(1)</script>",
          '<foreignObject><iframe src="https://example.com"></iframe><div>html</div></foreignObject>',
          '<rect width="1" height="1" style="fill:url(https://example.com/a)" onclick="alert(1)" fill="url(https://example.com/x.svg#a)" filter="url(#f)"/>',
          '<use href="https://example.com/sprite.svg#icon"/>',
          '<use href="#local"/>',
          '<a href="javascript:alert(1)"><text>t</text></a>',
          '<image href="https://example.com/x.png"/>',
          "</svg>",
        ].join(""),
        withHtml,
      );
      const svg = root.querySelector("svg")!;
      expect(svg.querySelector("script, foreignObject, iframe, div, image")).toBeNull();
      expect(svg.innerHTML).not.toMatch(/\bon[a-z]+=|style=|example\.com|javascript/i);
      const rect = svg.querySelector("rect")!;
      expect(rect.hasAttribute("fill")).toBe(false);
      expect(rect.getAttribute("filter")).toBe("url(#user-content-f)");
      expect([...svg.querySelectorAll("use")].map((use) => use.getAttribute("href"))).toEqual([
        null,
        "#user-content-local",
      ]);
    });

    it("renders an image as a link, so a reply can't load it", () => {
      const { root } = md(
        '![x](https://tracker.example.com/p.gif?data=secret) <img src="https://tracker.example.com/q.gif">',
        withHtml,
      );
      expect(root.querySelector("img")).toBeNull();
      expect(root.querySelectorAll("a.seclai-markdown-image")).toHaveLength(2);
    });

    it("drops data: and javascript: image sources", () => {
      const { root } = md('![x](data:image/png;base64,AAAA) <img src="javascript:alert(1)" alt="y">', withHtml);
      expect(root.querySelector("img, a")).toBeNull();
      expect(text(root)).toBe("x y");
    });
  });
});

describe("performance", () => {
  // A marker then a long run of spaces used to backtrack quadratically in the
  // stopgap renderer's bare-marker check, as it could in the hold-back check.
  it.each(["-", "*", "_", "•", "1."])("renders %s followed by a long run of spaces quickly", (marker) => {
    for (const streaming of [false, true]) {
      const content = `${marker}${" ".repeat(100_000)}x`;
      const start = performance.now();
      const { root } = md(content, { streaming });
      expect(performance.now() - start).toBeLessThan(1000);
      expect(root.textContent).toContain("x");
    }
  });
});

// Safari before 16.4 can't parse a regex lookbehind, and one anywhere in the
// bundle stops the whole package from loading there. The built bundle,
// dependencies included, is checked in `package.test.ts`.
describe("browser support", () => {
  it("uses no regex lookbehind in the source", () => {
    const src = join(import.meta.dirname, "../src");
    const files = readdirSync(src, { recursive: true, encoding: "utf8" }).filter((file) => /\.tsx?$/.test(file));
    expect(files).toContain(join("markdown", "MarkdownContent.tsx"));
    for (const file of files) {
      expect({ file, lookbehind: /\(\?<[=!]/.test(readFileSync(join(src, file), "utf8")) }).toEqual({
        file,
        lookbehind: false,
      });
    }
  });
});

describe("MarkdownContent in AgentRunForm", () => {
  it("renders the agent's numbered list", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/attachment-references")) return jsonResponse({ requires_uploads: false });
        return sseResponse(
          sse("done", { run_id: "r1", status: "completed", output: "Done:\n\n1. **Red** title\n2. Blue title" }),
        );
      }),
    );
    const user = userEvent.setup();
    render(<AgentRunForm />);

    await user.type(await screen.findByLabelText("Input"), "hi");
    await user.click(screen.getByRole("button", { name: "Run" }));

    const list = await screen.findByRole("list");
    expect(items(list).map((item) => [item.number, item.text])).toEqual([
      ["1", "Red title"],
      ["2", "Blue title"],
    ]);
    expect(screen.getByText("Red").tagName).toBe("STRONG");
  });
});

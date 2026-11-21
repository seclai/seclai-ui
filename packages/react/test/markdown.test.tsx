import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AgentRunForm, MarkdownContent } from "../src";
import { jsonResponse, sse, sseResponse } from "./helpers";

function md(content: string) {
  const { container, rerender } = render(<MarkdownContent content={content} />);
  const root = container.firstElementChild as HTMLElement;
  return {
    root,
    rerender: (next: string) => rerender(<MarkdownContent content={next} />),
    // Tag names of the blocks, such as ["p", "ol"].
    blocks: () => [...root.children].map((el) => el.tagName.toLowerCase()),
  };
}

const items = (list: Element) =>
  [...list.querySelectorAll(":scope > li")].map((li) => ({
    value: (li as HTMLLIElement).value,
    number: li.querySelector(".seclai-markdown-number")?.textContent,
    text: li.lastElementChild?.textContent ?? li.textContent,
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
    expect(first!.textContent).toBe("First linesecond line");
    expect(second!.textContent).toBe("Next paragraph");
  });

  it("handles Windows line endings", () => {
    const { blocks, root } = md("One\r\n\r\n1. Item");
    expect(blocks()).toEqual(["p", "ol"]);
    expect(root.textContent).not.toContain("\r");
  });

  it("renders numbered lists with dots or parentheses, with a number badge", () => {
    const { root } = md("1. Sunset\n2) Beach");
    const ol = root.querySelector("ol")!;
    expect(ol.start).toBe(1);
    expect(items(ol)).toEqual([
      { value: 1, number: "1", text: "Sunset" },
      { value: 2, number: "2", text: "Beach" },
    ]);
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
    const [first] = root.querySelectorAll("li");
    expect(first!.querySelector("br")).not.toBeNull();
    expect(items(root.querySelector("ol")!)[0]!.text).toBe("SunsetWarm colours");
  });

  it("renders bulleted lists with -, * or •", () => {
    const { root, blocks } = md("- One\n* Two\n• Three");
    expect(blocks()).toEqual(["ul"]);
    expect([...root.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["One", "Two", "Three"]);
  });

  it("doesn't take **bold** at the start of a line for a bullet", () => {
    const { root, blocks } = md("**Note** this is a paragraph");
    expect(blocks()).toEqual(["p"]);
    expect(root.querySelector("strong")!.textContent).toBe("Note");
    expect(root.textContent).toBe("Note this is a paragraph");
  });

  it("renders **bold**, also inside list items", () => {
    const { root } = md("A **big** and **bold** idea\n- **Title**: text\n1. Uses **bold**");
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
    expect(root.querySelector("strong")!.textContent).toBe("`thumb.png`");
  });

  it("leaves ** that isn't Markdown bold as text", () => {
    const { root } = md("f(**args, **kwargs) and `**x**` and **** and ** spaced **");
    expect(root.querySelector("strong")).toBeNull();
    expect(root.textContent).toBe("f(**args, **kwargs) and `**x**` and **** and ** spaced **");
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

  it("shows other Markdown as the text it is", () => {
    const content = "# Title\n[link](https://example.com)\n| a | b |\n> quote";
    const { root } = md(content);
    expect(root.querySelector("h1, a, table, blockquote")).toBeNull();
    expect(root.querySelector("p")!.textContent).toBe(content.replaceAll("\n", ""));
    expect(root.querySelectorAll("p br")).toHaveLength(3);
  });

  it("keeps fenced code verbatim, blank lines and all", () => {
    const content = "```py\n- not a bullet\n\nf(**a**)\n```\nAfter";
    const { root, blocks } = md(content);
    expect(blocks()).toEqual(["p", "p"]);
    expect(root.querySelector("ul, strong")).toBeNull();
    expect(root.firstElementChild!.textContent).toBe("```py- not a bulletf(**a**)```");
    expect(root.lastElementChild!.textContent).toBe("After");
  });

  it("renders HTML in the input as text", () => {
    const content = '<script>alert(1)</script>\n- <img src=x onerror="alert(1)">\n\n**<b>hi</b>**';
    const { root } = md(content);
    expect(root.querySelector("script, img, b")).toBeNull();
    expect(root.textContent).toContain("<script>alert(1)</script>");
    expect(root.querySelector("li")!.textContent).toBe('<img src=x onerror="alert(1)">');
    expect(root.querySelector("strong")!.textContent).toBe("<b>hi</b>");
  });

  describe("while streaming", () => {
    it("shows a marker with nothing after it as text", () => {
      for (const partial of ["1.", "1. ", "2)", "- ", "*", "•"]) {
        const { root, blocks } = md(partial);
        expect(blocks()).toEqual(["p"]);
        expect(root.textContent).toBe(partial);
      }
    });

    it("shows the next item's bare number on its own line, then makes it an item", () => {
      const { root, blocks, rerender } = md("1. Sunset\n2.");
      expect(blocks()).toEqual(["ol", "p"]);
      expect(items(root.querySelector("ol")!)).toHaveLength(1);
      expect(root.querySelector("p")!.textContent).toBe("2.");

      rerender("1. Sunset\n2. Beach");
      expect(blocks()).toEqual(["ol"]);
      expect(items(root.querySelector("ol")!).map((item) => item.value)).toEqual([1, 2]);
    });

    it("shows an unclosed ** as text, then bold once it closes", () => {
      const { root, rerender } = md("A **bol");
      expect(root.querySelector("strong")).toBeNull();
      expect(root.textContent).toBe("A **bol");

      rerender("A **bold**");
      expect(root.querySelector("strong")!.textContent).toBe("bold");
    });

    it("shows a list item's unclosed ** as text", () => {
      const { root } = md("1. **Sunset");
      expect(root.querySelector("strong")).toBeNull();
      expect(items(root.querySelector("ol")!)[0]!.text).toBe("**Sunset");
    });

    it("shows an unclosed code fence as text to the end", () => {
      const { root, blocks } = md("```\n- one\n\n**x**");
      expect(blocks()).toEqual(["p"]);
      expect(root.querySelector("ul, strong")).toBeNull();
    });
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

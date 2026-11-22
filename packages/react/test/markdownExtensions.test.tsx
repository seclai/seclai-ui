import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentChat,
  MarkdownContent,
  SeclaiMarkdownProvider,
  type MarkdownContentProps,
  type MarkdownExtension,
} from "../src";
import { math } from "../src/math";
import { mermaid } from "../src/mermaid";
import { controlledResponse, jsonResponse, sse } from "./helpers";

// Mermaid needs a real browser to lay out diagrams, so it's mocked. The flag
// shows when the dynamic import happens.
const mermaidMock = vi.hoisted(() => ({
  imported: false,
  initialize: vi.fn(),
  parse: vi.fn(async (source: string) => (source.includes("syntax error") ? false : { diagramType: "flowchart" })),
  render: vi.fn(async (_id: string, source: string) => ({ svg: `<svg data-diagram="${source.length}"></svg>` })),
}));

vi.mock("mermaid", () => {
  mermaidMock.imported = true;
  return { default: mermaidMock };
});

function md(content: string, options: Omit<MarkdownContentProps, "content"> = {}) {
  const { container, rerender } = render(<MarkdownContent content={content} {...options} />);
  return {
    root: container.firstElementChild as HTMLElement,
    rerender: (next: string) => rerender(<MarkdownContent content={next} {...options} />),
  };
}

describe("math()", () => {
  const extensions = [math()];

  it("renders $…$ inline and $$…$$ as a block with KaTeX", () => {
    const { root } = md("Area: $\\pi r^2$.\n\n$$\n\\frac{1}{2}\n$$", { extensions });
    const inline = root.querySelector("p > span.seclai-markdown-math")!;
    expect(inline.querySelector(".katex")).not.toBeNull();
    expect(inline.querySelector("annotation")!.textContent).toBe("\\pi r^2");
    const block = root.querySelector("div.seclai-markdown-math")!;
    expect(block.querySelector(".katex-display annotation")!.textContent).toBe("\\frac{1}{2}");
  });

  it("renders \\(…\\) inline and \\[…\\] as a block", () => {
    const { root } = md("Inline \\(x^2\\) here.\n\n\\[\ny = mx + b\n\\]", { extensions });
    expect(root.querySelector("p .katex annotation")!.textContent).toBe("x^2");
    expect(root.querySelector("div.seclai-markdown-math annotation")!.textContent).toBe("y = mx + b");
  });

  it("renders a ```math fence as a block", () => {
    const { root } = md("```math\ne = mc^2\n```", { extensions });
    expect(root.querySelector("div.seclai-markdown-math annotation")!.textContent).toBe("e = mc^2");
  });

  it("leaves LaTeX delimiters in code alone", () => {
    const { root } = md("`\\(a\\)` and\n\n```\n\\[b\\] $c$\n```", { extensions });
    expect(root.querySelector(".katex")).toBeNull();
    expect(root.querySelector("p code")!.textContent).toBe("\\(a\\)");
    expect(root.querySelector("pre code")!.textContent).toBe("\\[b\\] $c$\n");
  });

  it("shows invalid maths as its source, not a KaTeX error", () => {
    const { root } = md("Bad: $\\frac{1}{$ and\n\n$$\n\\notacommand{x}\n$$", { extensions });
    expect(root.querySelector(".katex, .katex-error")).toBeNull();
    expect(root.querySelector("p code")!.textContent).toBe("\\frac{1}{");
    expect(root.querySelector("pre code")!.textContent).toBe("\\notacommand{x}");
  });

  it("doesn't run LaTeX commands that load or link", () => {
    const { root } = md("$\\href{javascript:alert(1)}{x}$ $\\includegraphics{https://example.com/x.png}$", {
      extensions,
    });
    expect(root.querySelector("a, img, [href], [src]")).toBeNull();
  });

  describe("while streaming", () => {
    it("shows a $ as text until it closes", () => {
      const { root, rerender } = md("Area $\\pi r", { extensions, streaming: true });
      expect(root.querySelector(".katex, code")).toBeNull();
      expect(root.textContent).toBe("Area $\\pi r");
      rerender("Area $\\pi r^2$");
      expect(root.querySelector(".katex")).not.toBeNull();
    });

    it("shows a $$ block as code until it closes, with no KaTeX error", () => {
      const { root, rerender } = md("$$\n\\frac{1}{", { extensions, streaming: true });
      expect(root.querySelector(".katex, .katex-error")).toBeNull();
      expect(root.querySelector("pre code")!.textContent).toBe("\\frac{1}{\n");
      rerender("$$\n\\frac{1}{2}\n$");
      expect(root.querySelector(".katex")).toBeNull();
      // Held back while the closing line could still grow.
      rerender("$$\n\\frac{1}{2}\n$$");
      expect(root.querySelector(".katex")).toBeNull();
      rerender("$$\n\\frac{1}{2}\n$$\n");
      expect(root.querySelector(".katex-display")).not.toBeNull();
    });

    it("shows a ```math fence as code until it closes", () => {
      const { root, rerender } = md("```math\n\\frac{1}{", { extensions, streaming: true });
      expect(root.querySelector(".katex")).toBeNull();
      expect(root.querySelector("pre code")!.textContent).toBe("\\frac{1}{\n");
      rerender("```math\n\\frac{1}{2}\n```\n");
      expect(root.querySelector(".katex-display")).not.toBeNull();
    });

    it("shows \\[ as text until \\] arrives", () => {
      const { root, rerender } = md("\\[\nx +", { extensions, streaming: true });
      expect(root.querySelector(".katex")).toBeNull();
      rerender("\\[\nx + y\n\\]");
      expect(root.querySelector(".katex-display")).not.toBeNull();
    });
  });

  it("leaves maths as text without the extension", () => {
    const { root } = md("Cost $x^2$ and\n\n$$\ny\n$$\n\n\\(z\\)");
    expect(root.querySelector(".katex")).toBeNull();
    expect(root.textContent).toContain("$x^2$");
    expect(root.textContent).toContain("(z)");
  });

  it("returns the same extension every time, so an inline [math()] doesn't re-render", () => {
    expect(math()).toBe(math());
  });
});

describe("mermaid()", () => {
  beforeEach(() => {
    mermaidMock.initialize.mockClear();
    mermaidMock.render.mockClear();
  });

  const diagram = "```mermaid\ngraph TD\n  A --> B\n```";

  it("draws a closed ```mermaid block, loading Mermaid only then", async () => {
    const { root, rerender } = md("No diagram here", { extensions: [mermaid()] });
    await act(async () => {});
    expect(mermaidMock.imported).toBe(false);

    rerender(`Here:\n\n${diagram}`);
    // The source shows while Mermaid loads.
    expect(root.querySelector("pre code")!.textContent).toBe("graph TD\n  A --> B");
    await waitFor(() => expect(root.querySelector(".seclai-markdown-mermaid svg")).not.toBeNull());
    expect(mermaidMock.imported).toBe(true);
    expect(mermaidMock.render).toHaveBeenCalledWith(expect.any(String), "graph TD\n  A --> B");
    expect(mermaidMock.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ securityLevel: "strict", startOnLoad: false, suppressErrorRendering: true }),
    );
    expect(root.querySelector("pre")).toBeNull();
  });

  it("shows the source as code until the fence closes", async () => {
    const { root, rerender } = md("```mermaid\ngraph TD\n  A -->", { extensions: [mermaid()], streaming: true });
    await act(async () => {});
    expect(mermaidMock.render).not.toHaveBeenCalled();
    expect(root.querySelector("pre code")!.textContent).toBe("graph TD\n  A -->\n");

    // A closing fence still being typed is held back too.
    rerender("```mermaid\ngraph TD\n  A --> B\n``");
    await act(async () => {});
    expect(mermaidMock.render).not.toHaveBeenCalled();

    rerender(`${diagram}\n`);
    await waitFor(() => expect(root.querySelector(".seclai-markdown-mermaid svg")).not.toBeNull());
  });

  it("shows the source of a diagram with a syntax error", async () => {
    const { root } = md("```mermaid\ngraph TD\n  syntax error\n```", { extensions: [mermaid()] });
    await act(async () => {});
    await act(async () => {});
    expect(mermaidMock.render).not.toHaveBeenCalled();
    expect(root.querySelector(".seclai-markdown-mermaid")).toBeNull();
    expect(root.querySelector("pre code")!.textContent).toBe("graph TD\n  syntax error");
  });

  it("shows the source if Mermaid fails to draw", async () => {
    mermaidMock.render.mockRejectedValueOnce(new Error("layout failed"));
    const { root } = md("```mermaid\ngraph LR\n  X --> Y\n```", { extensions: [mermaid()] });
    await waitFor(() => expect(mermaidMock.render).toHaveBeenCalled());
    await act(async () => {});
    expect(root.querySelector(".seclai-markdown-mermaid")).toBeNull();
    expect(root.querySelector("pre code")!.textContent).toBe("graph LR\n  X --> Y");
  });

  it("leaves ```mermaid as code without the extension", async () => {
    const { root } = md(diagram);
    await act(async () => {});
    expect(root.querySelector("pre code.language-mermaid")!.textContent).toBe("graph TD\n  A --> B\n");
  });
});

describe("extensions", () => {
  it("come from SeclaiMarkdownProvider", () => {
    const { container } = render(
      <SeclaiMarkdownProvider extensions={[math()]}>
        <MarkdownContent content="$x$" />
      </SeclaiMarkdownProvider>,
    );
    expect(container.querySelector(".katex")).not.toBeNull();
  });

  it("from the prop replace the provider's", () => {
    const { container } = render(
      <SeclaiMarkdownProvider extensions={[math()]}>
        <MarkdownContent content="$x$" extensions={[]} />
      </SeclaiMarkdownProvider>,
    );
    expect(container.querySelector(".katex")).toBeNull();
  });

  it("can replace a built-in component, such as showing images", () => {
    const images: MarkdownExtension = {
      components: { img: ({ node: _node, ...props }) => <img {...props} /> },
    };
    const { root } = md("![Cat](https://example.com/cat.png) [x](javascript:alert(1))", { extensions: [images] });
    // The URL rules still apply.
    expect(root.querySelector("img")!.getAttribute("src")).toBe("https://example.com/cat.png");
    expect(root.querySelector("a")).toBeNull();
  });

  it("can add remark and rehype plugins and rewrite the text", () => {
    const shout: MarkdownExtension = {
      transform: (markdown) => markdown.replace(/!$/gm, "!!"),
      rehypePlugins: [
        () => (tree: { children: Array<{ type: string; properties?: Record<string, unknown> }> }) => {
          for (const node of tree.children) if (node.type === "element") node.properties!.dataShout = "yes";
        },
      ],
    };
    const { root } = md("Hello!", { extensions: [shout] });
    expect(root.innerHTML).toBe('<p data-shout="yes">Hello!!</p>');
  });

  it("reach AgentChat through the provider, for its replies", async () => {
    let held: ReturnType<typeof controlledResponse> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/attachment-references")) return jsonResponse({ requires_uploads: false });
        held = controlledResponse(init!.signal);
        return held.response;
      }),
    );
    const user = userEvent.setup();
    const { container } = render(
      <SeclaiMarkdownProvider extensions={[math()]}>
        <AgentChat />
      </SeclaiMarkdownProvider>,
    );
    await user.type(screen.getByLabelText("Message"), "area?");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(held).toBeDefined());
    held!.push(sse("stream_token", { token: "It's $\\pi r" }));
    await screen.findByText(/It's/);
    expect(container.querySelector(".katex")).toBeNull();
    held!.push(sse("stream_token", { token: "^2$." }));
    await waitFor(() => expect(container.querySelector(".katex")).not.toBeNull());
    held!.push(sse("done", { run_id: "r1", status: "completed", output: "It's $\\pi r^2$." }));
    held!.close();
    await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeTruthy());
    expect(container.querySelector(".seclai-turn-assistant .katex")).not.toBeNull();
  });
});

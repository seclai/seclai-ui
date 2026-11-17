import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  attachmentFileName,
  MediaGallery,
  MediaPreview,
  MediaSkeleton,
  MediaViewer,
  type AgentAttachment,
} from "../src";

// jsdom has HTMLDialogElement but not its methods.
beforeAll(() => {
  const proto = HTMLDialogElement.prototype;
  proto.showModal ??= function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  proto.close ??= function (this: HTMLDialogElement) {
    if (!this.open) return;
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function file(id: string, mime: string, name: string | null = null): AgentAttachment {
  return { id, name, mime, bytes: 1, url: `/api/seclai/download?attachmentId=${id}` };
}

const frameOf = (img: HTMLElement) => img.closest(".seclai-media-frame") as HTMLElement;

describe("MediaPreview", () => {
  it("shows an image in a frame with the given aspect ratio and a number badge", () => {
    render(<MediaPreview attachment={file("a", "image/png", "out.png")} aspectRatio={16 / 9} number={2} />);

    const img = screen.getByAltText("out.png");
    const frame = frameOf(img);
    expect(frame.style.aspectRatio).toBe(String(16 / 9));
    expect(within(frame).getByText("2").className).toBe("seclai-media-badge");
  });

  it("takes a string aspect ratio as is", () => {
    render(<MediaPreview attachment={file("a", "image/png")} aspectRatio="4 / 3" />);
    expect(frameOf(screen.getByAltText("Image")).style.aspectRatio).toBe("4 / 3");
  });

  it("uses the image's own ratio once it loads, and the CSS default before", () => {
    render(<MediaPreview attachment={file("a", "image/png", "wide.png")} />);
    const img = screen.getByAltText("wide.png") as HTMLImageElement;
    expect(frameOf(img).style.aspectRatio).toBe("");

    Object.defineProperty(img, "naturalWidth", { value: 1200 });
    Object.defineProperty(img, "naturalHeight", { value: 800 });
    fireEvent.load(img);

    expect(frameOf(img).style.aspectRatio).toBe("1200 / 800");
  });

  it("prefers the aspectRatio prop over the image's own ratio", () => {
    render(<MediaPreview attachment={file("a", "image/png", "x.png")} aspectRatio="1 / 1" />);
    const img = screen.getByAltText("x.png");
    Object.defineProperty(img, "naturalWidth", { value: 1200 });
    Object.defineProperty(img, "naturalHeight", { value: 800 });
    fireEvent.load(img);
    expect(frameOf(img).style.aspectRatio).toBe("1 / 1");
  });

  it("downloads under the attachment's name", () => {
    render(<MediaPreview attachment={file("a", "image/png", "out.png")} />);
    const link = screen.getByRole("link", { name: "Download out.png" });
    expect(link.getAttribute("download")).toBe("out.png");
    expect(link.getAttribute("href")).toBe("/api/seclai/download?attachmentId=a");
  });

  it("falls back to a filename with an extension from the mime type", () => {
    render(<MediaPreview attachment={file("a", "image/jpeg")} number={3} />);
    expect(screen.getByAltText("Image 3")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Download Image 3" }).getAttribute("download")).toBe(
      "image-3.jpg",
    );
  });

  it.each([
    [file("abc", "image/webp"), "abc.webp"],
    [file("abc", "image/svg+xml"), "abc.svg"],
    [file("abc", "image/png; charset=binary"), "abc.png"],
    [file("abc", "audio/x-wav"), "abc.wav"],
    [file("abc", "application/vnd.api+json"), "abc.json"],
    [file("abc", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"), "abc.bin"],
    [file("abc", "image/png", "named"), "named"],
  ])("names %o as %s", (attachment, expected) => {
    expect(attachmentFileName(attachment)).toBe(expected);
  });

  it("renders actions after the download link", () => {
    render(
      <MediaPreview
        attachment={file("a", "image/png", "out.png")}
        actions={<button type="button">Refine</button>}
      />,
    );
    const bar = screen.getByRole("link", { name: "Download out.png" }).parentElement!;
    expect(within(bar).getByRole("button", { name: "Refine" })).toBeTruthy();
  });

  it("calls a render-prop actions with the attachment", () => {
    const actions = vi.fn((a: AgentAttachment) => <button type="button">Use {a.name}</button>);
    const attachment = file("a", "image/png", "out.png");
    render(<MediaPreview attachment={attachment} actions={actions} />);
    expect(actions).toHaveBeenCalledWith(attachment);
    expect(screen.getByRole("button", { name: "Use out.png" })).toBeTruthy();
  });

  it("leaves out the actions wrapper when there are none", () => {
    const { container } = render(
      <MediaPreview attachment={file("a", "image/png")} actions={() => false} />,
    );
    expect(container.querySelector(".seclai-media-actions")).toBeNull();
  });

  it("makes the image a button when it can be opened", async () => {
    const onOpen = vi.fn();
    render(<MediaPreview attachment={file("a", "image/png", "out.png")} number={1} onOpen={onOpen} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Open out.png full size" }));
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("isn't a button without onOpen", () => {
    render(<MediaPreview attachment={file("a", "image/png", "out.png")} />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("says so when the image can't be loaded, and keeps the frame", () => {
    render(<MediaPreview attachment={file("a", "image/png", "out.png")} aspectRatio="1 / 1" />);
    const frame = frameOf(screen.getByAltText("out.png"));
    fireEvent.error(screen.getByAltText("out.png"));
    expect(within(frame).getByText("Couldn't load the image.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Download out.png" })).toBeTruthy();
  });

  it("says so when the image failed before hydration, without an error event", () => {
    // A server-rendered image that failed before React attached onError.
    vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(true);
    vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(0);
    render(<MediaPreview attachment={file("a", "image/png", "early.png")} aspectRatio="1 / 1" />);
    expect(screen.getByText("Couldn't load the image.")).toBeTruthy();
    expect(screen.queryByAltText("early.png")).toBeNull();
  });

  it("measures an image that loaded before hydration", () => {
    vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(true);
    vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(640);
    vi.spyOn(HTMLImageElement.prototype, "naturalHeight", "get").mockReturnValue(480);
    render(<MediaPreview attachment={file("a", "image/png", "early.png")} />);
    expect(frameOf(screen.getByAltText("early.png")).style.aspectRatio).toBe("640 / 480");
  });

  it("keeps the download link fallback for files that aren't images", () => {
    const { container } = render(
      <MediaPreview attachment={file("doc", "application/zip", "out.zip")} number={1} aspectRatio={1} />,
    );
    const link = screen.getByRole("link", { name: "out.zip" });
    expect(link.getAttribute("download")).toBe("out.zip");
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".seclai-media-frame")).toBeNull();
    expect(container.querySelector(".seclai-media-badge")).toBeNull();
  });

  it("names an unnamed file from its id and mime type", () => {
    render(<MediaPreview attachment={file("doc", "application/pdf")} />);
    expect(screen.getByRole("link", { name: "doc.pdf" }).getAttribute("download")).toBe("doc.pdf");
  });

  it("renders on the server", () => {
    const html = renderToString(<MediaPreview attachment={file("a", "image/png", "out.png")} number={1} />);
    expect(html).toContain('alt="out.png"');
  });
});

describe("MediaSkeleton", () => {
  it("reserves a numbered frame and names itself for screen readers", () => {
    render(<MediaSkeleton number={2} aspectRatio="16 / 9" />);
    const skeleton = screen.getByRole("img", { name: "Image 2 is being generated" });
    expect(skeleton.classList).toContain("seclai-media-skeleton");
    const frame = skeleton.querySelector(".seclai-media-frame") as HTMLElement;
    expect(frame.style.aspectRatio).toBe("16 / 9");
    expect(within(frame).getByText("2")).toBeTruthy();
  });

  it("takes a custom label, and leaves out the badge without a number", () => {
    const { container } = render(<MediaSkeleton label="Drawing…" />);
    expect(screen.getByRole("img", { name: "Drawing…" })).toBeTruthy();
    expect(container.querySelector(".seclai-media-badge")).toBeNull();
  });
});

describe("MediaGallery", () => {
  const images = [
    file("a", "image/png", "first.png"),
    file("b", "image/png"),
    file("c", "image/jpeg"),
  ];

  it("numbers the images and shows other files after them", () => {
    const { container } = render(
      <MediaGallery attachments={[images[0]!, file("z", "application/zip", "all.zip"), ...images.slice(1)]} />,
    );
    const badges = Array.from(container.querySelectorAll(".seclai-gallery-grid .seclai-media-badge"));
    expect(badges.map((b) => b.textContent)).toEqual(["1", "2", "3"]);
    expect(screen.getByRole("link", { name: "Download Image 2" }).getAttribute("download")).toBe(
      "image-2.png",
    );
    expect(screen.getByRole("link", { name: "Download Image 3" }).getAttribute("download")).toBe(
      "image-3.jpg",
    );
    const zip = screen.getByRole("link", { name: "all.zip" });
    expect(zip.closest(".seclai-gallery-grid")).toBeNull();
  });

  it("applies the aspect ratio to every card", () => {
    render(<MediaGallery attachments={images} aspectRatio="16 / 9" pending={1} />);
    const frames = Array.from(document.querySelectorAll<HTMLElement>(".seclai-media-frame"));
    expect(frames).toHaveLength(4);
    expect(frames.every((f) => f.style.aspectRatio === "16 / 9")).toBe(true);
  });

  it("passes each card's attachment and number to actions", () => {
    render(
      <MediaGallery
        attachments={images}
        actions={(attachment, number) => <button type="button">Refine {number}</button>}
      />,
    );
    expect(screen.getAllByRole("button", { name: /^Refine/ }).map((b) => b.textContent)).toEqual([
      "Refine 1",
      "Refine 2",
      "Refine 3",
    ]);
  });

  it("offers Download all only for more than one image", () => {
    const { rerender } = render(<MediaGallery attachments={images} />);
    expect(screen.getByRole("button", { name: "Download all 3" })).toBeTruthy();

    rerender(<MediaGallery attachments={[images[0]!, file("z", "application/zip", "all.zip")]} />);
    expect(screen.queryByRole("button", { name: /Download all/ })).toBeNull();
  });

  it("downloads all the images one at a time", async () => {
    vi.useFakeTimers();
    const saved: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      saved.push(`${this.download} ${this.getAttribute("href")}`);
    });
    render(<MediaGallery attachments={images} />);

    fireEvent.click(screen.getByRole("button", { name: "Download all 3" }));
    expect(saved).toEqual(["first.png /api/seclai/download?attachmentId=a"]);
    const button = screen.getByRole("button", { name: "Downloading…" });
    expect(button.getAttribute("aria-disabled")).toBe("true");

    // Clicking again while it's going doesn't start a second round.
    fireEvent.click(button);
    expect(saved).toHaveLength(1);

    await act(() => vi.advanceTimersByTimeAsync(399));
    expect(saved).toHaveLength(1);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(saved).toHaveLength(2);
    await act(() => vi.advanceTimersByTimeAsync(400));

    expect(saved).toEqual([
      "first.png /api/seclai/download?attachmentId=a",
      "image-2.png /api/seclai/download?attachmentId=b",
      "image-3.jpg /api/seclai/download?attachmentId=c",
    ]);
    expect(screen.getByRole("button", { name: "Download all 3" }).getAttribute("aria-disabled")).toBe(
      "false",
    );
    // The temporary links are cleaned up.
    expect(document.querySelectorAll("body > a")).toHaveLength(0);
  });

  it("skips URLs that aren't http(s), blob or relative when downloading all", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const saved: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      saved.push(this.getAttribute("href")!);
    });
    const urls = [
      "javascript:alert(1)",
      "https://cdn.example.com/a.png",
      " JavaScript:alert(2)",
      "data:text/html,<script>alert(3)</script>",
      "blob:https://app.example.com/1234",
      "/relative/b.png",
      "vbscript:msgbox(4)",
    ];
    render(
      <MediaGallery attachments={urls.map((url, i) => ({ ...file(String(i), "image/png"), url }))} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Download all 7" }));
    await act(() => vi.advanceTimersByTimeAsync(400 * urls.length));

    expect(saved).toEqual(["https://cdn.example.com/a.png", "blob:https://app.example.com/1234", "/relative/b.png"]);
    expect(warn).toHaveBeenCalledTimes(4);
    expect(document.querySelectorAll("body > a")).toHaveLength(0);
  });

  it("stops downloading when it unmounts", async () => {
    vi.useFakeTimers();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const { unmount } = render(<MediaGallery attachments={images} />);

    fireEvent.click(screen.getByRole("button", { name: "Download all 3" }));
    unmount();
    await vi.advanceTimersByTimeAsync(2000);

    expect(click).toHaveBeenCalledOnce();
  });

  it("shows numbered skeletons after the images while more are coming", () => {
    render(<MediaGallery attachments={images.slice(0, 1)} pending={2} />);
    expect(screen.getByRole("img", { name: "Image 2 is being generated" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Image 3 is being generated" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Download all/ })).toBeNull();
  });

  it("renders nothing much for no attachments", () => {
    const { container } = render(<MediaGallery attachments={[]} />);
    expect(container.querySelector(".seclai-gallery")!.childElementCount).toBe(0);
  });
});

describe("MediaViewer", () => {
  const images = [
    file("a", "image/png", "first.png"),
    file("b", "image/png"),
    file("c", "image/jpeg"),
  ];

  const dialog = () => document.querySelector("dialog")!;
  const viewerImage = () => dialog().querySelector("img")!;

  async function openSecond() {
    const user = userEvent.setup();
    render(<MediaGallery attachments={images} />);
    const opener = screen.getByRole("button", { name: "Open Image 2 full size" });
    await user.click(opener);
    return { user, opener };
  }

  it("opens on the clicked image, with focus inside", async () => {
    expect(document.querySelector("dialog")).toBeNull();
    await openSecond();

    expect(dialog().open).toBe(true);
    expect(viewerImage().getAttribute("alt")).toBe("Image 2");
    expect(viewerImage().getAttribute("src")).toBe(images[1]!.url);
    expect(within(dialog()).getByText("2 of 3")).toBeTruthy();
    expect(document.activeElement).toBe(within(dialog()).getByRole("button", { name: "Close" }));
    expect(dialog().getAttribute("aria-labelledby")).toBe(
      within(dialog()).getByText("Image 2").closest("p")!.id,
    );
  });

  it("has a download button with the image's filename", async () => {
    await openSecond();
    const link = within(dialog()).getByRole("link", { name: "Download" });
    expect(link.getAttribute("download")).toBe("image-2.png");
    expect(link.getAttribute("href")).toBe(images[1]!.url);
  });

  it("goes to the previous and next image with the buttons", async () => {
    const { user } = await openSecond();
    const view = within(dialog());

    await user.click(view.getByRole("button", { name: "Next" }));
    expect(viewerImage().getAttribute("alt")).toBe("Image 3");
    expect(view.getByRole("button", { name: "Next" }).getAttribute("aria-disabled")).toBe("true");

    // At the end, Next stays focused and does nothing.
    await user.click(view.getByRole("button", { name: "Next" }));
    expect(viewerImage().getAttribute("alt")).toBe("Image 3");
    expect(document.activeElement).toBe(view.getByRole("button", { name: "Next" }));

    await user.click(view.getByRole("button", { name: "Previous" }));
    await user.click(view.getByRole("button", { name: "Previous" }));
    expect(viewerImage().getAttribute("alt")).toBe("first.png");
    expect(view.getByRole("button", { name: "Previous" }).getAttribute("aria-disabled")).toBe("true");
  });

  it("goes to the previous and next image with the arrow keys", async () => {
    const { user } = await openSecond();

    await user.keyboard("{ArrowRight}");
    expect(viewerImage().getAttribute("alt")).toBe("Image 3");
    await user.keyboard("{ArrowRight}");
    expect(viewerImage().getAttribute("alt")).toBe("Image 3");
    await user.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(viewerImage().getAttribute("alt")).toBe("first.png");
    await user.keyboard("{ArrowLeft}");
    expect(viewerImage().getAttribute("alt")).toBe("first.png");
  });

  it("keeps the keys it handles from reaching the host page", async () => {
    const { user } = await openSecond();
    const seen: string[] = [];
    const listener = (event: KeyboardEvent) => seen.push(event.key);
    document.addEventListener("keydown", listener);
    window.addEventListener("keydown", listener);
    try {
      await user.keyboard("{ArrowRight}{ArrowLeft}{a}");
      expect(viewerImage().getAttribute("alt")).toBe("Image 2");
      await user.keyboard("{Escape}");
      expect(dialog().open).toBe(false);
      // Only the key the viewer doesn't handle gets through, to both listeners.
      expect(seen).toEqual(["a", "a"]);
    } finally {
      document.removeEventListener("keydown", listener);
      window.removeEventListener("keydown", listener);
    }
  });

  it("closes on Escape and gives focus back to the card", async () => {
    const { user, opener } = await openSecond();
    await user.keyboard("{Escape}");

    expect(dialog().open).toBe(false);
    expect(viewerImage()).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("closes with the close button", async () => {
    const { user, opener } = await openSecond();
    await user.click(within(dialog()).getByRole("button", { name: "Close" }));
    expect(dialog().open).toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  it("closes on a click on the backdrop, but not on the image", async () => {
    const { user } = await openSecond();

    await user.click(viewerImage());
    expect(dialog().open).toBe(true);

    await user.click(dialog());
    expect(dialog().open).toBe(false);
  });

  it("closes when the browser cancels it", async () => {
    await openSecond();
    fireEvent(dialog(), new Event("cancel", { cancelable: true }));
    expect(dialog().open).toBe(false);
  });

  it("is controlled, and calls onClose once per close", async () => {
    const onClose = vi.fn();
    function Harness() {
      const [index, setIndex] = useState<number | null>(0);
      return (
        <>
          <button type="button" onClick={() => setIndex(0)}>
            Open
          </button>
          <MediaViewer
            attachments={images}
            index={index}
            onIndexChange={setIndex}
            onClose={() => {
              onClose();
              setIndex(null);
            }}
          />
        </>
      );
    }
    const user = userEvent.setup();
    render(<Harness />);
    expect(dialog().open).toBe(true);

    await user.keyboard("{Escape}");
    expect(dialog().open).toBe(false);
    expect(onClose).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: "Open" }));
    expect(dialog().open).toBe(true);
  });

  it("leaves out previous and next for a single image", () => {
    render(<MediaViewer attachments={images.slice(0, 1)} index={0} onIndexChange={() => {}} onClose={() => {}} />);
    expect(within(dialog()).queryByRole("button", { name: "Next" })).toBeNull();
    expect(within(dialog()).queryByText(/of 1/)).toBeNull();
  });

  it("stays closed for an index out of range", () => {
    render(<MediaViewer attachments={images} index={5} onIndexChange={() => {}} onClose={() => {}} />);
    expect(dialog().open).toBe(false);
  });
});

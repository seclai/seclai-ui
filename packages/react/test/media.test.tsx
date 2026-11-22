import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { renderToString } from "react-dom/server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  attachmentFileName,
  MediaGallery,
  MediaPreview,
  MediaSkeleton,
  MediaViewer,
  saveFile,
  saveFiles,
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

  it.each([
    [file("abc", "image/png"), "image-2.png"],
    [file("abc", "audio/mpeg"), "audio-2.mp3"],
    [file("abc", "Video/MP4; codecs=avc1"), "video-2.mp4"],
    [file("abc", "application/pdf"), "pdf-2.pdf"],
    [file("abc", "application/zip"), "file-2.zip"],
  ])("names a numbered %o after its kind, as %s", (attachment, expected) => {
    expect(attachmentFileName(attachment, 2)).toBe(expected);
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
    // A PDF used to be the example here; it gets a card now.
    render(<MediaPreview attachment={file("doc", "application/zip")} />);
    expect(screen.getByRole("link", { name: "doc.zip" }).getAttribute("download")).toBe("doc.zip");
  });

  it("renders on the server", () => {
    const html = renderToString(<MediaPreview attachment={file("a", "image/png", "out.png")} number={1} />);
    expect(html).toContain('alt="out.png"');
  });
});

describe("MediaPreview for audio, video and PDF", () => {
  const audio = (c: HTMLElement) => c.querySelector("audio")!;
  const video = (c: HTMLElement) => c.querySelector("video")!;
  const object = (c: HTMLElement) => c.querySelector("object")!;

  it("plays audio with the browser's controls, loading only its metadata up front", () => {
    const { container } = render(<MediaPreview attachment={file("a", "audio/mpeg", "speech.mp3")} number={2} />);
    const el = audio(container);
    expect(el.getAttribute("src")).toBe("/api/seclai/download?attachmentId=a");
    expect(el.hasAttribute("controls")).toBe(true);
    expect(el.getAttribute("preload")).toBe("metadata");
    expect(el.getAttribute("aria-label")).toBe("speech.mp3");
    // No aspect-ratio frame for audio.
    expect(container.querySelector(".seclai-media-frame")).toBeNull();
    expect(container.querySelector("figure")!.className).toBe("seclai-media seclai-media-card seclai-media-audio");
    expect(within(container.querySelector(".seclai-media-head")!).getByText("speech.mp3")).toBeTruthy();
  });

  it("plays video with the browser's controls, inline, in a frame", () => {
    const { container } = render(
      <MediaPreview attachment={file("v", "video/mp4", "clip.mp4")} aspectRatio="16 / 9" number={1} />,
    );
    const el = video(container);
    expect(el.getAttribute("src")).toBe("/api/seclai/download?attachmentId=v");
    expect(el.hasAttribute("controls")).toBe(true);
    expect(el.getAttribute("preload")).toBe("metadata");
    expect(el.hasAttribute("playsinline")).toBe(true);
    expect(el.getAttribute("aria-label")).toBe("clip.mp4");
    expect(frameOf(el).style.aspectRatio).toBe("16 / 9");
    expect(within(frameOf(el)).getByText("1").className).toBe("seclai-media-badge");
  });

  it("uses the video's own ratio once its metadata loads, and the CSS default before", () => {
    const { container } = render(<MediaPreview attachment={file("v", "video/webm")} />);
    const el = video(container);
    expect(frameOf(el).style.aspectRatio).toBe("");
    Object.defineProperty(el, "videoWidth", { value: 1920 });
    Object.defineProperty(el, "videoHeight", { value: 1080 });
    fireEvent.loadedMetadata(el);
    expect(frameOf(el).style.aspectRatio).toBe("1920 / 1080");
  });

  it("prefers the aspectRatio prop over the video's own ratio", () => {
    const { container } = render(<MediaPreview attachment={file("v", "video/webm")} aspectRatio={1} />);
    const el = video(container);
    Object.defineProperty(el, "videoWidth", { value: 1920 });
    Object.defineProperty(el, "videoHeight", { value: 1080 });
    fireEvent.loadedMetadata(el);
    expect(frameOf(el).style.aspectRatio).toBe("1");
  });

  it("measures a video whose metadata loaded before hydration", () => {
    vi.spyOn(HTMLMediaElement.prototype, "readyState", "get").mockReturnValue(1);
    vi.spyOn(HTMLVideoElement.prototype, "videoWidth", "get").mockReturnValue(640);
    vi.spyOn(HTMLVideoElement.prototype, "videoHeight", "get").mockReturnValue(360);
    const { container } = render(<MediaPreview attachment={file("v", "video/mp4")} />);
    expect(frameOf(video(container)).style.aspectRatio).toBe("640 / 360");
  });

  it("shows a PDF in an <object>, with a download link for browsers without a viewer", () => {
    const { container } = render(<MediaPreview attachment={file("p", "application/pdf", "report.pdf")} number={3} />);
    const el = object(container);
    expect(el.getAttribute("type")).toBe("application/pdf");
    expect(el.getAttribute("data")).toBe("/api/seclai/download?attachmentId=p");
    expect(el.getAttribute("aria-label")).toBe("report.pdf");
    const fallback = within(el).getByRole("link", { name: "Download report.pdf" });
    expect(fallback.getAttribute("href")).toBe("/api/seclai/download?attachmentId=p");
    expect(fallback.getAttribute("download")).toBe("report.pdf");
    expect(el.textContent).toContain("This browser can't show the PDF here.");
    expect(within(container.querySelector(".seclai-media-head")!).getByText("3").className).toBe(
      "seclai-media-badge",
    );
    // The PDF keeps its own shape, whatever the aspectRatio.
    expect(frameOf(el).style.aspectRatio).toBe("");
  });

  it("names the fallback link and the object after the number for an unnamed PDF", () => {
    const { container } = render(<MediaPreview attachment={file("p", "application/pdf")} number={2} />);
    expect(object(container).getAttribute("aria-label")).toBe("PDF 2");
    expect(within(object(container)).getByRole("link", { name: "Download PDF 2" }).getAttribute("download")).toBe(
      "pdf-2.pdf",
    );
  });

  it("never previews SVG as anything but an image, nor HTML at all", () => {
    const { container, rerender } = render(<MediaPreview attachment={file("s", "image/svg+xml", "x.svg")} />);
    expect(container.querySelector("img")!.getAttribute("src")).toBe("/api/seclai/download?attachmentId=s");
    expect(container.querySelectorAll("object, embed, iframe, video, audio")).toHaveLength(0);

    rerender(<MediaPreview attachment={file("h", "text/html", "x.html")} number={1} />);
    expect(container.querySelectorAll("img, object, embed, iframe, video, audio")).toHaveLength(0);
    expect(screen.getByRole("link", { name: "x.html" }).getAttribute("download")).toBe("x.html");
  });

  it.each([
    ["audio/mpeg; codecs=mp3", "audio"],
    ["AUDIO/WAV", "audio"],
    ["Video/MP4; codecs=\"avc1.42E01E\"", "video"],
    ["APPLICATION/PDF", "object"],
    ["application/pdf; charset=binary", "object"],
    ["IMAGE/PNG", "img"],
  ])("matches %s case-insensitively and without parameters", (mime, tag) => {
    const { container } = render(<MediaPreview attachment={file("x", mime)} />);
    expect(container.querySelector(tag)).toBeTruthy();
  });

  it.each([
    ["audio/ogg", "Audio 4"],
    ["video/mp4", "Video 4"],
    ["application/pdf", "PDF 4"],
  ])("names an unnamed %s file %s", (mime, label) => {
    const { container } = render(<MediaPreview attachment={file("x", mime)} number={4} />);
    const el = container.querySelector("audio, video, object")!;
    expect(el.getAttribute("aria-label")).toBe(label);
    expect(screen.getAllByRole("link", { name: `Download ${label}` }).length).toBeGreaterThan(0);
  });

  it("treats an empty name as no name", () => {
    const { container } = render(
      <>
        <MediaPreview attachment={file("a", "audio/mpeg", "")} number={1} />
        <MediaPreview attachment={file("z", "application/zip", "")} number={2} />
      </>,
    );
    expect(container.querySelector(".seclai-media-title")!.textContent).toBe("Audio");
    expect(screen.getByRole("link", { name: "file-2.zip" }).getAttribute("download")).toBe("file-2.zip");
  });

  it.each([
    ["audio/mpeg", "audio"],
    ["video/mp4", "video"],
    ["application/pdf", "PDF"],
  ])("gives a %s card the number badge, download link and actions", (mime, kind) => {
    const actions = vi.fn((a: AgentAttachment) => <button type="button">Use {a.id}</button>);
    const attachment = file("x", mime, `out.${kind}`);
    const { container } = render(<MediaPreview attachment={attachment} number={5} actions={actions} />);
    expect(actions).toHaveBeenCalledWith(attachment);
    expect(container.querySelector(".seclai-media-badge")!.textContent).toBe("5");
    const bar = container.querySelector("figcaption.seclai-media-bar") as HTMLElement;
    const link = within(bar).getByRole("link", { name: `Download out.${kind}` });
    expect(link.getAttribute("href")).toBe(attachment.url);
    expect(link.getAttribute("download")).toBe(`out.${kind}`);
    expect(within(bar).getByRole("button", { name: "Use x" })).toBeTruthy();
  });

  it.each([
    ["audio/mpeg", "audio", "Couldn't load the audio."],
    ["video/mp4", "video", "Couldn't load the video."],
  ])("says so when the %s can't be loaded, and keeps the download link", (mime, tag, message) => {
    const { container } = render(<MediaPreview attachment={file("x", mime, "out")} number={1} />);
    fireEvent.error(container.querySelector(tag)!);
    expect(container.querySelector(tag)).toBeNull();
    expect(screen.getByText(message).className).toBe("seclai-media-error");
    expect(screen.getByRole("link", { name: "Download out" })).toBeTruthy();
    expect(container.querySelector(".seclai-media-badge")!.textContent).toBe("1");
  });

  it("keeps the video's frame when it can't be loaded", () => {
    const { container } = render(<MediaPreview attachment={file("x", "video/mp4")} aspectRatio="4 / 3" />);
    fireEvent.error(video(container));
    expect(frameOf(screen.getByText("Couldn't load the video.")).style.aspectRatio).toBe("4 / 3");
  });

  it("says so when the PDF can't be loaded, and keeps the download link", () => {
    const { container } = render(<MediaPreview attachment={file("p", "application/pdf", "r.pdf")} />);
    // React doesn't pass on an <object>'s error event, so this is a native one.
    act(() => {
      object(container).dispatchEvent(new Event("error"));
    });
    expect(container.querySelector("object")).toBeNull();
    expect(screen.getByText("Couldn't load the PDF.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Download r.pdf" })).toBeTruthy();
  });

  it("tries again when a failed file's URL changes", () => {
    const { container, rerender } = render(<MediaPreview attachment={file("p", "application/pdf")} />);
    act(() => {
      object(container).dispatchEvent(new Event("error"));
    });
    rerender(<MediaPreview attachment={file("q", "application/pdf")} />);
    expect(object(container).getAttribute("data")).toBe("/api/seclai/download?attachmentId=q");
    // And still listens for the new one failing.
    act(() => {
      object(container).dispatchEvent(new Event("error"));
    });
    expect(screen.getByText("Couldn't load the PDF.")).toBeTruthy();

    const { container: media, rerender: rerenderMedia } = render(<MediaPreview attachment={file("a", "audio/mpeg")} />);
    fireEvent.error(audio(media));
    rerenderMedia(<MediaPreview attachment={file("b", "audio/mpeg")} />);
    expect(audio(media).getAttribute("src")).toBe("/api/seclai/download?attachmentId=b");
  });

  it.each([
    ["audio/mpeg", "Couldn't load the audio."],
    ["video/mp4", "Couldn't load the video."],
  ])("says so when the %s failed before hydration, without an error event", (mime, message) => {
    // jsdom's media elements have no `error`.
    Object.defineProperty(HTMLMediaElement.prototype, "error", { configurable: true, get: () => ({ code: 4 }) });
    try {
      render(<MediaPreview attachment={file("x", mime)} />);
      expect(screen.getByText(message)).toBeTruthy();
    } finally {
      delete (HTMLMediaElement.prototype as { error?: unknown }).error;
    }
  });

  it("doesn't make a video or PDF a button, even with onOpen", () => {
    const onOpen = vi.fn();
    render(
      <>
        <MediaPreview attachment={file("v", "video/mp4")} onOpen={onOpen} />
        <MediaPreview attachment={file("p", "application/pdf")} onOpen={onOpen} />
        <MediaPreview attachment={file("a", "audio/mpeg")} onOpen={onOpen} />
      </>,
    );
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders each kind on the server", () => {
    const html = renderToString(
      <>
        <MediaPreview attachment={file("a", "audio/mpeg", "a.mp3")} number={1} />
        <MediaPreview attachment={file("v", "video/mp4", "v.mp4")} number={2} />
        <MediaPreview attachment={file("p", "application/pdf", "p.pdf")} number={3} />
      </>,
    );
    expect(html).toContain('<audio src="/api/seclai/download?attachmentId=a" controls="" preload="metadata"');
    expect(html).toContain("<video");
    expect(html).toContain('<object type="application/pdf" data="/api/seclai/download?attachmentId=p"');
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

  describe("with audio, video and PDFs", () => {
    const mixed = [
      file("i1", "image/png", "cover.png"),
      file("z", "application/zip", "all.zip"),
      file("au", "audio/mpeg"),
      file("i2", "image/jpeg"),
      file("t", "text/html", "page.html"),
      file("vi", "VIDEO/MP4; codecs=avc1"),
      file("pd", "application/pdf", "report.pdf"),
    ];

    const cardsOf = (container: HTMLElement) =>
      Array.from(container.querySelectorAll(".seclai-gallery-grid > li > figure"));

    it("lays them out as cards in the attachments' order, numbered like the agent's list", () => {
      const { container } = render(<MediaGallery attachments={mixed} />);
      const cards = cardsOf(container).map((c) => [
        c.className.split(" ").at(-1),
        c.querySelector(".seclai-media-badge")!.textContent,
      ]);
      expect(cards).toEqual([
        ["seclai-media-image", "1"],
        ["seclai-media-audio", "2"],
        ["seclai-media-image", "3"],
        ["seclai-media-video", "4"],
        ["seclai-media-pdf", "5"],
      ]);
      expect(container.querySelector("audio")!.getAttribute("aria-label")).toBe("Audio 2");
      expect(container.querySelector("video")!.getAttribute("aria-label")).toBe("Video 4");
      expect(screen.getByRole("link", { name: "Download Image 3" }).getAttribute("download")).toBe("image-3.jpg");
      expect(screen.getByRole("link", { name: "Download Video 4" }).getAttribute("download")).toBe("video-4.mp4");
    });

    it("keeps other files as download links after the cards", () => {
      const { container } = render(<MediaGallery attachments={mixed} />);
      const zip = screen.getByRole("link", { name: "all.zip" });
      const html = screen.getByRole("link", { name: "page.html" });
      for (const link of [zip, html]) {
        expect(link.closest(".seclai-gallery-grid")).toBeNull();
        expect(container.querySelector(".seclai-gallery-grid")!.compareDocumentPosition(link)).toBe(
          Node.DOCUMENT_POSITION_FOLLOWING,
        );
      }
    });

    it("passes each card's attachment and number to actions", () => {
      const actions = vi.fn((attachment: AgentAttachment, number: number) => (
        <button type="button">Act {number}</button>
      ));
      render(<MediaGallery attachments={mixed} actions={actions} />);
      expect(actions.mock.calls.map(([a, n]) => `${a.id} ${n}`)).toEqual(["i1 1", "au 2", "i2 3", "vi 4", "pd 5"]);
      expect(screen.getAllByRole("button", { name: /^Act/ })).toHaveLength(5);
    });

    it("gives the aspect ratio to image and video frames, not to the PDF", () => {
      const { container } = render(<MediaGallery attachments={mixed} aspectRatio="16 / 9" />);
      const ratios = Array.from(container.querySelectorAll<HTMLElement>(".seclai-media-frame")).map(
        (f) => f.style.aspectRatio,
      );
      expect(ratios).toEqual(["16 / 9", "16 / 9", "16 / 9", ""]);
    });

    it("opens the viewer from image cards only, with the image's card number", async () => {
      const user = userEvent.setup();
      render(<MediaGallery attachments={mixed} />);
      expect(screen.getAllByRole("button", { name: /full size/ }).map((b) => b.getAttribute("aria-label"))).toEqual([
        "Open cover.png full size",
        "Open Image 3 full size",
      ]);

      await user.click(screen.getByRole("button", { name: "Open Image 3 full size" }));
      const dialog = document.querySelector("dialog")!;
      expect(dialog.querySelector("img")!.getAttribute("alt")).toBe("Image 3");
      expect(within(dialog).getByText("2 of 2")).toBeTruthy();
      expect(within(dialog).getByRole("link", { name: "Download" }).getAttribute("download")).toBe("image-3.jpg");
    });

    it("downloads every card's file with Download all, but not the other files", async () => {
      vi.useFakeTimers();
      const saved: string[] = [];
      vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
        saved.push(this.download);
      });
      render(<MediaGallery attachments={mixed} />);

      fireEvent.click(screen.getByRole("button", { name: "Download all 5" }));
      await act(() => vi.advanceTimersByTimeAsync(400 * 5));
      expect(saved).toEqual(["cover.png", "audio-2.mp3", "image-3.jpg", "video-4.mp4", "report.pdf"]);
    });

    it("offers Download all for an image and an audio file", () => {
      render(<MediaGallery attachments={[mixed[0]!, mixed[2]!]} />);
      expect(screen.getByRole("button", { name: "Download all 2" })).toBeTruthy();
    });

    it("numbers pending skeletons on from the last card", () => {
      render(<MediaGallery attachments={mixed} pending={2} />);
      const items = Array.from(document.querySelectorAll(".seclai-gallery-grid > li"));
      expect(items).toHaveLength(7);
      expect(within(items[5] as HTMLElement).getByRole("img", { name: "Image 6 is being generated" })).toBeTruthy();
      expect(within(items[6] as HTMLElement).getByRole("img", { name: "Image 7 is being generated" })).toBeTruthy();
    });
  });

  it("renders nothing much for no attachments", () => {
    const { container } = render(<MediaGallery attachments={[]} />);
    expect(container.querySelector(".seclai-gallery")!.childElementCount).toBe(0);
  });
});

describe("saveFile", () => {
  function recordClicks() {
    const saved: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      saved.push(`${this.download} ${this.getAttribute("href")}`);
    });
    return saved;
  }

  it("saves a URL through a temporary download link", () => {
    const saved = recordClicks();
    saveFile("https://cdn.example.com/a.png", "thumbnail.png");
    expect(saved).toEqual(["thumbnail.png https://cdn.example.com/a.png"]);
    expect(document.querySelectorAll("body > a")).toHaveLength(0);
  });

  it("refuses a javascript: URL with a warning", () => {
    const saved = recordClicks();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    saveFile("javascript:alert(1)", "evil.png");
    expect(saved).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("not downloading evil.png"));
  });

  describe("with a Blob", () => {
    // jsdom has no object URLs.
    const create = vi.fn(() => "blob:https://app.example.com/1234");
    const revoke = vi.fn();
    const { createObjectURL, revokeObjectURL } = URL;
    beforeAll(() => {
      Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    });
    afterAll(() => {
      Object.assign(URL, { createObjectURL, revokeObjectURL });
    });
    afterEach(() => {
      create.mockClear();
      revoke.mockClear();
    });

    it("saves it through an object URL and revokes the URL later", async () => {
      vi.useFakeTimers();
      const saved = recordClicks();
      const blob = new Blob(["jpeg"], { type: "image/jpeg" });

      saveFile(blob, "thumbnail.jpg");

      expect(create).toHaveBeenCalledWith(blob);
      expect(saved).toEqual(["thumbnail.jpg blob:https://app.example.com/1234"]);
      expect(document.querySelectorAll("body > a")).toHaveLength(0);
      // The download may not have read the URL yet.
      await vi.advanceTimersByTimeAsync(39_999);
      expect(revoke).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(revoke).toHaveBeenCalledWith("blob:https://app.example.com/1234");
    });

    it("saves Blobs in saveFiles too", async () => {
      vi.useFakeTimers();
      const saved = recordClicks();
      const done = saveFiles([
        { source: "/a.png", filename: "a.png" },
        { source: new Blob(["b"]), filename: "b.jpg" },
      ]);
      await vi.advanceTimersByTimeAsync(400);
      await done;
      expect(saved).toEqual(["a.png /a.png", "b.jpg blob:https://app.example.com/1234"]);
    });
  });

  it("does nothing without a document", () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("document", undefined);
    expect(() => saveFile("/a.png", "a.png")).not.toThrow();
    expect(() => saveFile(new Blob(["a"]), "a.png")).not.toThrow();
    vi.unstubAllGlobals();
    expect(click).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("saveFiles", () => {
  const files = ["a", "b", "c"].map((id) => ({ source: `/files/${id}.png`, filename: `${id}.png` }));

  function recordClicks() {
    const saved: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      saved.push(this.download);
    });
    return saved;
  }

  it("waits 400 ms between files by default", async () => {
    vi.useFakeTimers();
    const saved = recordClicks();
    let finished = false;
    void saveFiles(files).then(() => (finished = true));

    expect(saved).toEqual(["a.png"]);
    await vi.advanceTimersByTimeAsync(399);
    expect(saved).toEqual(["a.png"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(saved).toEqual(["a.png", "b.png"]);
    await vi.advanceTimersByTimeAsync(400);
    expect(saved).toEqual(["a.png", "b.png", "c.png"]);
    expect(finished).toBe(true);
  });

  it("takes another delay", async () => {
    vi.useFakeTimers();
    const saved = recordClicks();
    void saveFiles(files, { delayMs: 1000 });
    await vi.advanceTimersByTimeAsync(999);
    expect(saved).toEqual(["a.png"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(saved).toEqual(["a.png", "b.png"]);
  });

  it("stops when the signal aborts", async () => {
    vi.useFakeTimers();
    const saved = recordClicks();
    const controller = new AbortController();
    const done = saveFiles(files, { signal: controller.signal });
    await vi.advanceTimersByTimeAsync(400);
    controller.abort();
    await vi.advanceTimersByTimeAsync(2000);
    await done;
    expect(saved).toEqual(["a.png", "b.png"]);
  });

  it("resolves as soon as the signal aborts, without waiting out the delay", async () => {
    vi.useFakeTimers();
    const saved = recordClicks();
    const controller = new AbortController();
    let finished = false;
    void saveFiles(files, { delayMs: 60_000, signal: controller.signal }).then(() => (finished = true));
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(finished).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(saved).toEqual(["a.png"]);
  });

  it("saves nothing when the signal has already aborted", async () => {
    const saved = recordClicks();
    await saveFiles(files, { signal: AbortSignal.abort() });
    expect(saved).toEqual([]);
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

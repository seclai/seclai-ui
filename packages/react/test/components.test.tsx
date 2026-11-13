import { act, createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Profiler } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  AgentChat,
  AgentRunForm,
  SeclaiAgent,
  type AgentChatMessage,
  type AgentChatTurn,
} from "../src";
import { controlledResponse, jsonResponse, sse, sseResponse } from "./helpers";

const RUN = "3f2b8c1e-7a4d-4e9b-9c11-0d5e6f7a8b9c";

interface Routes {
  refs?: unknown;
  upload?: (file: File) => Response | Promise<Response>;
  run?: (body: Record<string, unknown>, init: RequestInit) => Response;
}

function stubApi({ refs = { requires_uploads: false }, upload, run }: Routes) {
  const runBodies: Record<string, unknown>[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/attachment-references")) return jsonResponse(refs);
    if (url.endsWith("/upload")) {
      return upload!((init!.body as FormData).get("file") as File);
    }
    if (url.endsWith("/run")) {
      const body = JSON.parse(init!.body as string);
      runBodies.push(body);
      return run!(body, init!);
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, runBodies };
}

const completed = (output: string, extra: object = {}) =>
  sseResponse(sse("done", { run_id: RUN, status: "completed", output, ...extra }));

describe("AgentRunForm", () => {
  const photoSlot = {
    name: "photo",
    label: "Photo",
    min: 1,
    max: 2,
    content_types: ["image/*", "application/pdf"],
  };

  it("runs a text-only agent", async () => {
    const { runBodies } = stubApi({ run: () => completed("Answer") });
    const user = userEvent.setup();
    render(<AgentRunForm />);

    await user.type(await screen.findByLabelText("Input"), "hello");
    await user.click(screen.getByRole("button", { name: "Run" }));

    expect(await screen.findByText("Answer")).toBeTruthy();
    expect(runBodies[0]).toEqual({ input: "hello" });
  });

  it("renders a file slot from the attachment references", async () => {
    stubApi({ refs: { requires_uploads: true, accepted_attachments: [photoSlot] } });
    render(<AgentRunForm />);

    const input = (await screen.findByLabelText("Photo (required)")) as HTMLInputElement;
    expect(input.type).toBe("file");
    expect(input.accept).toBe("image/*,application/pdf");
    expect(input.multiple).toBe(true);
  });

  it("allows only one file when the slot's max is 1", async () => {
    stubApi({
      refs: { requires_uploads: true, accepted_attachments: [{ name: "doc", max: 1 }] },
    });
    render(<AgentRunForm />);
    const input = (await screen.findByLabelText("doc")) as HTMLInputElement;
    expect(input.multiple).toBe(false);
  });

  it("uploads every file, then runs with the text and all the upload ids together", async () => {
    let nextId = 0;
    const uploaded: string[] = [];
    const { runBodies } = stubApi({
      refs: { requires_uploads: true, accepted_attachments: [photoSlot] },
      upload: (file) => {
        uploaded.push(file.name);
        return jsonResponse({ id: `up-${nextId++}`, status: "ready" });
      },
      run: () => completed("Done"),
    });
    const user = userEvent.setup();
    render(<AgentRunForm />);

    const input = await screen.findByLabelText("Photo (required)");
    await user.upload(input, [
      new File(["a"], "a.png", { type: "image/png" }),
      new File(["b"], "b.png", { type: "image/png" }),
    ]);
    await user.type(screen.getByLabelText("Input"), "describe these");
    await user.click(screen.getByRole("button", { name: "Run" }));

    expect(await screen.findByText("Done")).toBeTruthy();
    expect(uploaded.sort()).toEqual(["a.png", "b.png"]);
    expect(runBodies[0]!.input).toBe("describe these");
    expect((runBodies[0]!.uploadIds as string[]).sort()).toEqual(["up-0", "up-1"]);
  });

  it("stops before uploading when a required slot is empty", async () => {
    const { fetchMock } = stubApi({
      refs: { requires_uploads: true, accepted_attachments: [photoSlot] },
    });
    const user = userEvent.setup();
    render(<AgentRunForm />);

    await user.type(await screen.findByLabelText("Input"), "hello");
    await user.click(screen.getByRole("button", { name: "Run" }));

    expect((await screen.findByRole("alert")).textContent).toContain("at least 1 file");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops when a slot has too many files", async () => {
    const { fetchMock } = stubApi({
      refs: { requires_uploads: true, accepted_attachments: [photoSlot] },
    });
    const user = userEvent.setup();
    render(<AgentRunForm />);

    await user.upload(await screen.findByLabelText("Photo (required)"), [
      new File(["a"], "a.png", { type: "image/png" }),
      new File(["b"], "b.png", { type: "image/png" }),
      new File(["c"], "c.png", { type: "image/png" }),
    ]);
    await user.click(screen.getByRole("button", { name: "Run" }));

    expect((await screen.findByRole("alert")).textContent).toContain("at most 2 files");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("asks for something when the form is empty", async () => {
    const { runBodies } = stubApi({ run: () => completed("x") });
    const user = userEvent.setup();
    render(<AgentRunForm />);

    await user.click(await screen.findByRole("button", { name: "Run" }));

    expect((await screen.findByRole("alert")).textContent).toContain("Enter some text");
    expect(runBodies).toHaveLength(0);
  });

  it("does not run if an upload fails", async () => {
    const { runBodies } = stubApi({
      refs: { requires_uploads: true, accepted_attachments: [photoSlot] },
      upload: () => jsonResponse({ error: "File too large", status: 413 }, 413),
      run: () => completed("x"),
    });
    const user = userEvent.setup();
    render(<AgentRunForm />);

    await user.upload(
      await screen.findByLabelText("Photo (required)"),
      new File(["a"], "a.png", { type: "image/png" }),
    );
    await user.click(screen.getByRole("button", { name: "Run" }));

    expect((await screen.findByRole("alert")).textContent).toBe("File too large");
    expect(runBodies).toHaveLength(0);
    expect((screen.getByRole("button", { name: "Run" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows an error if the references can't be loaded", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "Agent not found", status: 404 }, 404)),
    );
    render(<AgentRunForm />);
    expect((await screen.findByRole("alert")).textContent).toBe("Agent not found");
  });

  it("shows image and file output through the download proxy", async () => {
    stubApi({
      run: () =>
        completed("", {
          attachments: [
            { id: "img", name: "out.png", mime: "image/png", bytes: 1, download_url: "https://api/x" },
            { id: "doc", name: "out.zip", mime: "application/zip", bytes: 1, download_url: "https://api/y" },
          ],
        }),
    });
    const user = userEvent.setup();
    render(<AgentRunForm />);

    await user.type(await screen.findByLabelText("Input"), "draw");
    await user.click(screen.getByRole("button", { name: "Run" }));

    const image = (await screen.findByAltText("out.png")) as HTMLImageElement;
    expect(image.getAttribute("src")).toBe(
      `/api/seclai/download?runId=${RUN}&attachmentId=img&name=out.png`,
    );
    expect(screen.getByRole("link", { name: "out.zip" }).getAttribute("href")).toContain(
      "attachmentId=doc",
    );
    expect(document.body.innerHTML).not.toContain("https://api/");
  });

  it("reports the result to onFinish", async () => {
    stubApi({ run: () => completed("Answer") });
    const onFinish = vi.fn();
    const user = userEvent.setup();
    render(<AgentRunForm onFinish={onFinish} />);

    await user.type(await screen.findByLabelText("Input"), "hi");
    await user.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() => expect(onFinish).toHaveBeenCalledOnce());
    expect(onFinish.mock.calls[0]![0]).toMatchObject({ status: "completed", text: "Answer" });
  });

  it("does not render agent output as HTML", async () => {
    stubApi({ run: () => completed("<img src=x onerror=alert(1)>") });
    const user = userEvent.setup();
    render(<AgentRunForm />);

    await user.type(await screen.findByLabelText("Input"), "hi");
    await user.click(screen.getByRole("button", { name: "Run" }));

    expect(await screen.findByText("<img src=x onerror=alert(1)>")).toBeTruthy();
    expect(document.querySelector("img")).toBeNull();
  });
});

describe("AgentChat", () => {
  async function say(user: ReturnType<typeof userEvent.setup>, text: string) {
    await user.type(screen.getByLabelText("Message"), text);
    await user.click(screen.getByRole("button", { name: "Send" }));
  }

  it("reuses one session id across turns and keeps the history", async () => {
    let turn = 0;
    const { runBodies } = stubApi({ run: () => completed(`Reply ${++turn}`) });
    const user = userEvent.setup();
    render(<AgentChat />);

    await say(user, "first");
    expect(await screen.findByText("Reply 1")).toBeTruthy();
    await say(user, "second");
    expect(await screen.findByText("Reply 2")).toBeTruthy();

    expect(runBodies.map((b) => b.input)).toEqual(["first", "second"]);
    expect(typeof runBodies[0]!.sessionId).toBe("string");
    expect(runBodies[1]!.sessionId).toBe(runBodies[0]!.sessionId);

    for (const text of ["first", "Reply 1", "second", "Reply 2"]) {
      expect(screen.getByText(text)).toBeTruthy();
    }
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("");
  });

  it("gets a different session id per chat", async () => {
    const { runBodies } = stubApi({ run: () => completed("ok") });
    const user = userEvent.setup();

    const first = render(<AgentChat />);
    await say(user, "a");
    await screen.findByText("ok");
    first.unmount();

    render(<AgentChat />);
    await say(user, "b");
    await screen.findByText("ok");

    expect(runBodies[0]!.sessionId).not.toBe(runBodies[1]!.sessionId);
  });

  it("works without crypto.randomUUID, as on plain-http hosts", async () => {
    vi.stubGlobal("crypto", {
      getRandomValues: (bytes: Uint8Array) => bytes.fill(7),
    });
    const { runBodies } = stubApi({ run: () => completed("ok") });
    const user = userEvent.setup();
    render(<AgentChat />);

    await say(user, "hi");
    await screen.findByText("ok");

    expect(runBodies[0]!.sessionId).toBe("07".repeat(16));
  });

  it("sends on Enter and adds a newline on Shift+Enter", async () => {
    const { runBodies } = stubApi({ run: () => completed("ok") });
    const user = userEvent.setup();
    render(<AgentChat />);

    await user.type(screen.getByLabelText("Message"), "line one{Shift>}{Enter}{/Shift}line two{Enter}");
    await screen.findByText("ok");

    expect(runBodies[0]!.input).toBe("line one\nline two");
  });

  it("keeps a failed turn visible and can carry on", async () => {
    let turn = 0;
    stubApi({
      run: () =>
        ++turn === 1
          ? jsonResponse({ error: "Out of credits", status: 402 }, 402)
          : completed("Back again"),
    });
    const user = userEvent.setup();
    render(<AgentChat />);

    await say(user, "first");
    expect((await screen.findByRole("alert")).textContent).toBe("Out of credits");

    await say(user, "second");
    expect(await screen.findByText("Back again")).toBeTruthy();
    expect(screen.getByText("first")).toBeTruthy();
    expect(screen.getByText("Out of credits")).toBeTruthy();
  });

  it("shows attachments on the turn that produced them", async () => {
    stubApi({
      run: () =>
        completed("Here", {
          attachments: [{ id: "img", name: "cat.png", mime: "image/png", bytes: 1 }],
        }),
    });
    const user = userEvent.setup();
    render(<AgentChat />);

    await say(user, "draw a cat");
    expect(await screen.findByAltText("cat.png")).toBeTruthy();
  });
});

describe("AgentChat attachments", () => {
  const imageSlot = { name: "images", label: "Images", max: 2, content_types: ["image/*"] };
  const withSlots = (...slots: object[]) => ({
    requires_uploads: false,
    accepted_attachments: slots,
  });
  const png = (name: string) => new File([name], name, { type: "image/png" });

  function idUploads() {
    let next = 0;
    return () => jsonResponse({ id: `up-${next++}`, status: "ready" });
  }

  /** An upload the test finishes by hand. */
  function heldUploads() {
    const pending: (() => void)[] = [];
    let next = 0;
    const upload = () =>
      new Promise<Response>((resolve) => {
        const id = `up-${next++}`;
        pending.push(() => resolve(jsonResponse({ id, status: "ready" })));
      });
    return { upload, release: () => pending.splice(0).forEach((finish) => finish()) };
  }

  const sendButton = () => screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;
  const chips = () => within(screen.getByRole("list", { name: "Files to send" })).getAllByRole("listitem");

  it("shows no attach control when the agent accepts no files", async () => {
    const { fetchMock } = stubApi({ refs: withSlots() });
    render(<AgentChat />);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/seclai/attachment-references", expect.anything()),
    );
    await act(async () => {});
    expect(screen.queryByLabelText("Attach")).toBeNull();
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });

  it("shows an Attach control, a label around a visually hidden input", async () => {
    stubApi({ refs: withSlots(imageSlot) });
    render(<AgentChat />);

    const input = (await screen.findByLabelText("Attach")) as HTMLInputElement;
    expect(input.type).toBe("file");
    expect(input.accept).toBe("image/*");
    expect(input.multiple).toBe(true);
    expect(input.closest("label")?.textContent).toBe("Attach");
    expect(input.className).toBe("seclai-sr-only");
    expect(input.hidden).toBe(false);
    expect(input.style.display).not.toBe("none");
    expect(getComputedStyle(input).display).not.toBe("none");
  });

  it("uploads a file when it's added and sends its id with the next message", async () => {
    const { runBodies } = stubApi({
      refs: withSlots(imageSlot),
      upload: idUploads(),
      run: () => completed("Nice photo"),
    });
    const user = userEvent.setup();
    render(<AgentChat />);

    await user.upload(await screen.findByLabelText("Attach"), png("me.png"));
    await waitFor(() => expect(chips()[0]!.dataset.status).toBe("ready"));

    await user.type(screen.getByLabelText("Message"), "what do you see");
    await user.click(sendButton());

    expect(await screen.findByText("Nice photo")).toBeTruthy();
    expect(runBodies[0]).toMatchObject({ input: "what do you see", uploadIds: ["up-0"] });
    expect(screen.queryByRole("list", { name: "Files to send" })).toBeNull();
    const sent = screen.getByRole("list", { name: "Attached files" });
    expect(within(sent).getByText("me.png")).toBeTruthy();
  });

  it("sends files with no text", async () => {
    const { runBodies } = stubApi({
      refs: withSlots(imageSlot),
      upload: idUploads(),
      run: () => completed("ok"),
    });
    const user = userEvent.setup();
    render(<AgentChat />);

    await user.upload(await screen.findByLabelText("Attach"), png("a.png"));
    await waitFor(() => expect(sendButton().disabled).toBe(false));
    await user.click(sendButton());

    await screen.findByText("ok");
    expect(runBodies[0]!.input).toBeUndefined();
    expect(runBodies[0]!.uploadIds).toEqual(["up-0"]);
  });

  it("keeps Send disabled while a file uploads", async () => {
    const held = heldUploads();
    stubApi({ refs: withSlots(imageSlot), upload: held.upload });
    const user = userEvent.setup();
    render(<AgentChat />);

    await user.upload(await screen.findByLabelText("Attach"), png("a.png"));
    await user.type(screen.getByLabelText("Message"), "hi");
    expect(chips()[0]!.textContent).toContain("Uploading…");
    expect(sendButton().disabled).toBe(true);

    held.release();
    await waitFor(() => expect(sendButton().disabled).toBe(false));
  });

  it("refuses files over the slot's max per message", async () => {
    const { fetchMock } = stubApi({ refs: withSlots(imageSlot), upload: idUploads() });
    const user = userEvent.setup();
    render(<AgentChat />);

    const input = (await screen.findByLabelText("Attach")) as HTMLInputElement;
    await user.upload(input, [png("a.png"), png("b.png"), png("c.png")]);

    expect(chips()).toHaveLength(2);
    expect(screen.getByRole("alert").textContent).toContain("up to 2 files per message");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(input.disabled).toBe(true);
    expect(input.closest("label")!.getAttribute("aria-disabled")).toBe("true");
  });

  it("refuses a file of a type the agent doesn't accept", async () => {
    const { fetchMock } = stubApi({ refs: withSlots(imageSlot), upload: idUploads() });
    const user = userEvent.setup({ applyAccept: false });
    render(<AgentChat />);

    await user.upload(
      await screen.findByLabelText("Attach"),
      new File(["x"], "notes.pdf", { type: "application/pdf" }),
    );

    expect(screen.getByRole("alert").textContent).toContain("notes.pdf");
    expect(screen.queryByRole("list", { name: "Files to send" })).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("lets a file with no reported type through and leaves the decision to the server", async () => {
    const { fetchMock } = stubApi({ refs: withSlots(imageSlot), upload: idUploads() });
    const user = userEvent.setup({ applyAccept: false });
    render(<AgentChat />);

    await user.upload(await screen.findByLabelText("Attach"), new File(["x"], "photo.heic", { type: "" }));

    expect(screen.queryByRole("alert")).toBeNull();
    expect(chips()[0]!.textContent).toContain("photo.heic");
    await waitFor(() => expect(chips()[0]!.dataset.status).toBe("ready"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("removes a chip, which frees its place and leaves it out of the run", async () => {
    const { runBodies } = stubApi({
      refs: withSlots(imageSlot),
      upload: idUploads(),
      run: () => completed("ok"),
    });
    const user = userEvent.setup();
    render(<AgentChat />);

    const input = (await screen.findByLabelText("Attach")) as HTMLInputElement;
    await user.upload(input, [png("a.png"), png("b.png")]);
    await waitFor(() => expect(chips().every((c) => c.dataset.status === "ready")).toBe(true));
    expect(input.disabled).toBe(true);

    await user.click(screen.getByRole("button", { name: "Remove a.png" }));
    expect(chips()).toHaveLength(1);
    expect(input.disabled).toBe(false);

    await user.click(sendButton());
    await screen.findByText("ok");
    expect(runBodies[0]!.uploadIds).toEqual(["up-1"]);
  });

  it("shows a failed upload on its chip and doesn't send it", async () => {
    stubApi({
      refs: withSlots(imageSlot),
      upload: () => jsonResponse({ error: "File too large", status: 413 }, 413),
    });
    const user = userEvent.setup();
    render(<AgentChat />);

    await user.upload(await screen.findByLabelText("Attach"), png("big.png"));
    await waitFor(() => expect(chips()[0]!.dataset.status).toBe("error"));
    expect(chips()[0]!.textContent).toContain("File too large");
    expect(sendButton().disabled).toBe(true);
  });

  it("accepts files dropped on the composer", async () => {
    const { fetchMock } = stubApi({ refs: withSlots(imageSlot), upload: idUploads() });
    render(<AgentChat />);
    await screen.findByLabelText("Attach");

    const form = screen.getByLabelText("Message").closest("form")!;
    const dataTransfer = { files: [png("dropped.png")], types: ["Files"] };
    fireEvent.dragOver(form, { dataTransfer });
    expect(form.classList.contains("seclai-dropping")).toBe(true);
    fireEvent.drop(form, { dataTransfer });

    expect(form.classList.contains("seclai-dropping")).toBe(false);
    expect(chips()[0]!.textContent).toContain("dropped.png");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("accepts files pasted into the message box", async () => {
    stubApi({ refs: withSlots(imageSlot), upload: idUploads() });
    render(<AgentChat />);
    await screen.findByLabelText("Attach");

    const event = createEvent.paste(screen.getByLabelText("Message"), {
      clipboardData: { files: [png("pasted.png")], types: ["Files"], getData: () => "" },
    });
    fireEvent(screen.getByLabelText("Message"), event);

    expect(event.defaultPrevented).toBe(true);
    expect(chips()[0]!.textContent).toContain("pasted.png");
    await waitFor(() => expect(chips()[0]!.dataset.status).toBe("ready"));
  });

  it("pastes text, not the image next to it, when the clipboard has both", async () => {
    const { fetchMock } = stubApi({ refs: withSlots(imageSlot), upload: idUploads() });
    render(<AgentChat />);
    await screen.findByLabelText("Attach");

    const box = screen.getByLabelText("Message");
    const event = createEvent.paste(box, {
      clipboardData: {
        files: [png("cells.png")],
        types: ["text/plain", "Files"],
        getData: (format: string) => (format === "text/plain" ? "A1\tB1" : ""),
      },
    });
    fireEvent(box, event);

    expect(event.defaultPrevented).toBe(false);
    expect(screen.queryByRole("list", { name: "Files to send" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("shows an image thumbnail on the chip and in the sent turn", async () => {
    // jsdom has no object URLs.
    let n = 0;
    const revoked: string[] = [];
    URL.createObjectURL = () => `blob:thumb-${n++}`;
    URL.revokeObjectURL = (url) => void revoked.push(url);
    onTestFinished(() => {
      delete (URL as { createObjectURL?: unknown }).createObjectURL;
      delete (URL as { revokeObjectURL?: unknown }).revokeObjectURL;
    });
    stubApi({ refs: withSlots(imageSlot), upload: idUploads(), run: () => completed("ok") });
    const user = userEvent.setup();
    const { container, unmount } = render(<AgentChat />);

    await user.upload(await screen.findByLabelText("Attach"), png("me.png"));
    expect(container.querySelector(".seclai-file-thumb")!.getAttribute("src")).toBe("blob:thumb-0");

    await waitFor(() => expect(sendButton().disabled).toBe(false));
    await user.click(sendButton());
    await screen.findByText("ok");
    expect(container.querySelector(".seclai-turn-user .seclai-file-thumb")!.getAttribute("src")).toBe(
      "blob:thumb-0",
    );

    unmount();
    expect(revoked).toEqual(["blob:thumb-0"]);
  });

  it("renders named attach buttons and passes their tags to onBeforeSend", async () => {
    const onBeforeSend = vi.fn(
      ({ input, files }: AgentChatMessage) =>
        `${files.map((f) => `${f.name} is the ${f.tag}.`).join(" ")} ${input}`,
    );
    const { runBodies } = stubApi({
      refs: withSlots(imageSlot),
      upload: idUploads(),
      run: () => completed("ok"),
    });
    const user = userEvent.setup();
    render(
      <AgentChat
        attachButtons={[
          { label: "+ Headshot", tag: "headshot" },
          { label: "+ Style reference", tag: "style" },
        ]}
        onBeforeSend={onBeforeSend}
      />,
    );

    await user.upload(await screen.findByLabelText("+ Headshot"), png("me.png"));
    await user.upload(screen.getByLabelText("+ Style reference"), png("ref.png"));
    expect(screen.queryByLabelText("Attach")).toBeNull();
    expect(chips()[0]!.textContent).toContain("headshot");

    await waitFor(() => expect(sendButton().disabled).toBe(false));
    await user.type(screen.getByLabelText("Message"), "make it pop");
    await user.click(sendButton());
    await screen.findByText("ok");

    expect(onBeforeSend).toHaveBeenCalledWith({
      input: "make it pop",
      files: [
        { uploadId: "up-0", name: "me.png", contentType: "image/png", tag: "headshot" },
        { uploadId: "up-1", name: "ref.png", contentType: "image/png", tag: "style" },
      ],
    });
    expect(runBodies[0]!.input).toBe("me.png is the headshot. ref.png is the style. make it pop");
    // The transcript keeps what the user typed.
    expect(screen.getByText("make it pop")).toBeTruthy();
  });

  it("combines several slots into one limit and type list", async () => {
    stubApi({
      refs: withSlots(imageSlot, { name: "doc", max: 1, content_types: ["application/pdf"] }),
    });
    render(<AgentChat />);

    const input = (await screen.findByLabelText("Attach")) as HTMLInputElement;
    expect(input.accept).toBe("image/*,application/pdf");
  });

  it("still chats when the attachment references can't be loaded", async () => {
    const runBodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/attachment-references")) {
          return jsonResponse({ error: "Agent not found", status: 404 }, 404);
        }
        runBodies.push(JSON.parse(init!.body as string));
        return completed("ok");
      }),
    );
    const user = userEvent.setup();
    render(<AgentChat />);

    await user.type(screen.getByLabelText("Message"), "hi");
    await user.click(sendButton());
    await screen.findByText("ok");
    expect(screen.queryByLabelText("Attach")).toBeNull();
    expect(runBodies[0]).toMatchObject({ input: "hi" });
  });
});

describe("AgentChat saved sessions", () => {
  const imageSlot = { name: "images", max: 2, content_types: ["image/*"] };
  const png = (name: string) => new File([name], name, { type: "image/png" });

  async function say(user: ReturnType<typeof userEvent.setup>, text: string) {
    await user.type(screen.getByLabelText("Message"), text);
    await user.click(screen.getByRole("button", { name: "Send" }));
  }

  const saved: AgentChatTurn[] = [
    {
      input: "Here's me",
      files: [{ uploadId: "up-1", name: "me.png", contentType: "image/png", tag: "headshot" }],
      output: "Here's a thumbnail",
      attachments: [{ id: "img", name: "thumb.png", mime: "image/png", bytes: 10 }],
      runId: "run-1",
      status: "completed",
      error: null,
    },
    { input: "again", output: "", runId: null, status: "failed", error: "Out of credits" },
    { input: "and again", output: "Half a", runId: "run-3", status: "cancelled" },
  ];

  it("sends a controlled sessionId with every run", async () => {
    const { runBodies } = stubApi({ run: () => completed("ok") });
    const onTurnComplete = vi.fn();
    const user = userEvent.setup();
    render(<AgentChat sessionId="session-1" onTurnComplete={onTurnComplete} />);

    await say(user, "first");
    await waitFor(() => expect(onTurnComplete).toHaveBeenCalledTimes(1));
    await say(user, "second");
    await waitFor(() => expect(onTurnComplete).toHaveBeenCalledTimes(2));

    expect(runBodies.map((b) => b.sessionId)).toEqual(["session-1", "session-1"]);
    expect(onTurnComplete.mock.calls.map((call) => call[1])).toEqual([
      { sessionId: "session-1" },
      { sessionId: "session-1" },
    ]);
  });

  it("reports the generated session id when there's no sessionId prop", async () => {
    const { runBodies } = stubApi({ run: () => completed("ok") });
    const onTurnComplete = vi.fn();
    const user = userEvent.setup();
    render(<AgentChat onTurnComplete={onTurnComplete} />);

    await say(user, "first");
    await waitFor(() => expect(onTurnComplete).toHaveBeenCalledTimes(1));
    await say(user, "second");
    await waitFor(() => expect(onTurnComplete).toHaveBeenCalledTimes(2));

    const generated = runBodies[0]!.sessionId;
    expect(typeof generated).toBe("string");
    expect(runBodies[1]!.sessionId).toBe(generated);
    expect(onTurnComplete.mock.calls[1]![1]).toEqual({ sessionId: generated });
  });

  it("renders initialTurns: text, files, output, images, errors and stops", () => {
    stubApi({});
    const { container } = render(<AgentChat initialTurns={saved} />);

    expect(screen.getByText("Here's me")).toBeTruthy();
    const files = screen.getByRole("list", { name: "Attached files" });
    expect(within(files).getByText("me.png")).toBeTruthy();
    expect(within(files).getByText("headshot")).toBeTruthy();
    expect(container.querySelector(".seclai-file-thumb")).toBeNull();

    expect(screen.getByText("Here's a thumbnail")).toBeTruthy();
    expect((screen.getByAltText("thumb.png") as HTMLImageElement).getAttribute("src")).toBe(
      "/api/seclai/download?runId=run-1&attachmentId=img&name=thumb.png",
    );

    expect(screen.getByRole("alert").textContent).toBe("Out of credits");
    expect(screen.getByText("Half a")).toBeTruthy();
    expect(screen.getByText("Stopped.")).toBeTruthy();
    expect(container.querySelectorAll(".seclai-turn")).toHaveLength(6);
  });

  it("rebuilds attachment URLs against the current basePath and agentId", () => {
    stubApi({});
    render(<AgentChat basePath="/x" agentId="a1" initialTurns={saved} />);
    expect(screen.getByAltText("thumb.png").getAttribute("src")).toBe(
      "/x/a1/download?runId=run-1&attachmentId=img&name=thumb.png",
    );
  });

  it("calls onTurnComplete once per run, for completed, failed and cancelled runs", async () => {
    let turn = 0;
    stubApi({
      run: (_body, init) => {
        turn++;
        if (turn === 1) {
          return completed("Done", {
            attachments: [{ id: "img", name: "cat.png", mime: "image/png", bytes: 1 }],
          });
        }
        if (turn === 2) return jsonResponse({ error: "Out of credits", status: 402 }, 402);
        const held = controlledResponse(init.signal);
        held.push(sse("init", { run_id: "run-3" }));
        held.push(sse("stream_token", { token: "Half" }));
        return held.response;
      },
    });
    const onTurnComplete = vi.fn();
    const user = userEvent.setup();
    render(<AgentChat sessionId="s" onTurnComplete={onTurnComplete} />);

    await say(user, "one");
    await waitFor(() => expect(onTurnComplete).toHaveBeenCalledTimes(1));
    await say(user, "two");
    await waitFor(() => expect(onTurnComplete).toHaveBeenCalledTimes(2));
    await say(user, "three");
    expect(await screen.findByText("Half")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(onTurnComplete).toHaveBeenCalledTimes(3));
    await act(async () => {});
    expect(onTurnComplete).toHaveBeenCalledTimes(3);

    expect(onTurnComplete.mock.calls.map((call) => call[0])).toEqual([
      {
        input: "one",
        files: [],
        output: "Done",
        attachments: [{ id: "img", name: "cat.png", mime: "image/png", bytes: 1 }],
        runId: RUN,
        status: "completed",
        error: null,
      },
      {
        input: "two",
        files: [],
        output: "",
        attachments: [],
        runId: null,
        status: "failed",
        error: "Out of credits",
      },
      {
        input: "three",
        files: [],
        output: "Half",
        attachments: [],
        runId: "run-3",
        status: "cancelled",
        error: null,
      },
    ]);
  });

  it("stores the typed text, and the sent input when onBeforeSend changes it", async () => {
    stubApi({ run: () => completed("ok") });
    const onTurnComplete = vi.fn();
    const user = userEvent.setup();
    render(
      <AgentChat
        onBeforeSend={({ input }) => (input === "same" ? input : `Note: ${input}`)}
        onTurnComplete={onTurnComplete}
      />,
    );

    await say(user, "hello");
    await waitFor(() => expect(onTurnComplete).toHaveBeenCalledTimes(1));
    await say(user, "same");
    await waitFor(() => expect(onTurnComplete).toHaveBeenCalledTimes(2));

    expect(onTurnComplete.mock.calls[0]![0]).toMatchObject({
      input: "hello",
      sentInput: "Note: hello",
    });
    expect(onTurnComplete.mock.calls[1]![0]).toMatchObject({ input: "same" });
    expect(onTurnComplete.mock.calls[1]![0]).not.toHaveProperty("sentInput");
  });

  it("round-trips: turns from onTurnComplete restore the same transcript", async () => {
    let turn = 0;
    let upload = 0;
    stubApi({
      refs: { requires_uploads: false, accepted_attachments: [imageSlot] },
      upload: () => jsonResponse({ id: `up-${upload++}`, status: "ready" }),
      run: () =>
        ++turn === 1
          ? completed("Here's a cat", {
              attachments: [{ id: "img", name: "cat.png", mime: "image/png", bytes: 1 }],
            })
          : jsonResponse({ error: "Out of credits", status: 402 }, 402),
    });
    const store: AgentChatTurn[] = [];
    const user = userEvent.setup();
    const live = render(
      <AgentChat
        sessionId="s"
        attachButtons={[{ label: "+ Photo", tag: "photo" }]}
        onBeforeSend={({ input, files }) => `${files.length} files. ${input}`}
        onTurnComplete={(t) => store.push(JSON.parse(JSON.stringify(t)))}
      />,
    );

    await user.upload(await screen.findByLabelText("+ Photo"), png("me.png"));
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(false),
    );
    await say(user, "draw a cat");
    await waitFor(() => expect(store).toHaveLength(1));
    await say(user, "another");
    await waitFor(() => expect(store).toHaveLength(2));
    await act(async () => {});

    const transcript = (container: HTMLElement) =>
      container.querySelector(".seclai-turns")!.innerHTML;
    const before = transcript(live.container);
    expect(before).toContain("cat.png");
    expect(before).toContain("me.png");
    live.unmount();

    const restored = render(<AgentChat sessionId="s" initialTurns={store} />);
    expect(transcript(restored.container)).toBe(before);
  });

  it("resets the transcript and stops the stream when sessionId changes", async () => {
    let held: ReturnType<typeof controlledResponse> | undefined;
    const { runBodies } = stubApi({
      run: (_body, init) => {
        if (runBodies.length === 1) {
          held = controlledResponse(init.signal);
          return held.response;
        }
        return completed("Fresh reply");
      },
    });
    const onTurnComplete = vi.fn();
    const user = userEvent.setup();
    const other: AgentChatTurn[] = [
      { input: "Old question", output: "Old answer", runId: "r", status: "completed" },
    ];
    const { rerender } = render(
      <AgentChat sessionId="a" initialTurns={saved} onTurnComplete={onTurnComplete} />,
    );

    await say(user, "pending");
    await waitFor(() => expect(held).toBeDefined());
    held!.push(sse("stream_token", { token: "Streaming" }));
    expect(await screen.findByText("Streaming")).toBeTruthy();
    await user.type(screen.getByLabelText("Message"), "draft");

    rerender(<AgentChat sessionId="b" initialTurns={other} onTurnComplete={onTurnComplete} />);

    expect(screen.queryByText("Here's me")).toBeNull();
    expect(screen.queryByText("pending")).toBeNull();
    expect(screen.getByText("Old question")).toBeTruthy();
    expect(screen.getByText("Old answer")).toBeTruthy();
    await waitFor(() => expect(onTurnComplete).toHaveBeenCalledTimes(1));
    expect(onTurnComplete).toHaveBeenCalledWith(
      expect.objectContaining({ input: "pending", output: "Streaming", status: "cancelled" }),
      { sessionId: "a" },
    );
    expect(screen.queryByText("Streaming")).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("");

    await say(user, "next");
    expect(await screen.findByText("Fresh reply")).toBeTruthy();
    expect(runBodies[1]!.sessionId).toBe("b");
    expect(screen.queryByText("pending")).toBeNull();
    expect(screen.getAllByRole("listitem")).toHaveLength(4);
  });

  it("adopts its own generated id as sessionId without resetting or stopping the stream", async () => {
    let held: ReturnType<typeof controlledResponse> | undefined;
    const { runBodies } = stubApi({
      run: (_body, init) => {
        if (runBodies.length === 2) {
          held = controlledResponse(init.signal);
          return held.response;
        }
        return completed("ok");
      },
    });
    const onTurnComplete = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(<AgentChat onTurnComplete={onTurnComplete} />);

    await say(user, "one");
    await waitFor(() => expect(onTurnComplete).toHaveBeenCalledTimes(1));
    const generated = onTurnComplete.mock.calls[0]![1].sessionId as string;
    expect(runBodies[0]!.sessionId).toBe(generated);

    await say(user, "two");
    await waitFor(() => expect(held).toBeDefined());
    held!.push(sse("stream_token", { token: "Streaming" }));
    expect(await screen.findByText("Streaming")).toBeTruthy();
    await user.type(screen.getByLabelText("Message"), "draft");

    // The app saved under context.sessionId and now passes it back.
    rerender(
      <AgentChat sessionId={generated} initialTurns={[]} onTurnComplete={onTurnComplete} />,
    );

    expect(screen.getByText("one")).toBeTruthy();
    expect(screen.getByText("two")).toBeTruthy();
    expect(screen.getByText("Streaming")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("draft");

    held!.push(sse("stream_token", { token: " on" }));
    held!.push(sse("done", { run_id: RUN, status: "completed", output: "Streaming on" }));
    held!.close();
    expect(await screen.findByText("Streaming on")).toBeTruthy();
    await waitFor(() => expect(onTurnComplete).toHaveBeenCalledTimes(2));
    expect(onTurnComplete.mock.calls[1]).toEqual([
      expect.objectContaining({ input: "two", output: "Streaming on", status: "completed" }),
      { sessionId: generated },
    ]);

    await user.clear(screen.getByLabelText("Message"));
    await say(user, "three");
    await waitFor(() => expect(onTurnComplete).toHaveBeenCalledTimes(3));
    expect(runBodies.map((b) => b.sessionId)).toEqual([generated, generated, generated]);
    expect(screen.getByText("one")).toBeTruthy();
    expect(screen.getByText("Streaming on")).toBeTruthy();
  });

  it("treats any other id after an uncontrolled start as a switch", async () => {
    stubApi({ run: () => completed("ok") });
    const user = userEvent.setup();
    const { rerender } = render(<AgentChat />);

    await say(user, "one");
    await screen.findByText("ok");
    rerender(<AgentChat sessionId="someone-else" />);

    expect(screen.queryByText("one")).toBeNull();
    expect(screen.queryByText("ok")).toBeNull();
  });

  it("never shows the old run's stream under the new session, not even for one commit", async () => {
    let held: ReturnType<typeof controlledResponse> | undefined;
    const { runBodies } = stubApi({
      run: (_body, init) => {
        held = controlledResponse(init.signal);
        return held.response;
      },
    });
    const user = userEvent.setup();
    let session = "a";
    const commits: { session: string; text: string; busy: string | null }[] = [];
    // Profiler's onRender runs in the commit, after the DOM has been updated.
    const record = () =>
      commits.push({
        session,
        text: document.body.textContent ?? "",
        busy: document.querySelector(".seclai-turns")?.getAttribute("aria-busy") ?? null,
      });
    const chat = () => (
      <Profiler id="chat" onRender={record}>
        <AgentChat sessionId={session} />
      </Profiler>
    );
    const { rerender } = render(chat());

    await say(user, "pending");
    await waitFor(() => expect(held).toBeDefined());
    held!.push(sse("stream_token", { token: "Streaming" }));
    expect(await screen.findByText("Streaming")).toBeTruthy();

    session = "b";
    rerender(chat());
    await waitFor(() => expect(screen.queryByRole("button", { name: "Stop" })).toBeNull());

    const after = commits.filter((c) => c.session === "b");
    expect(after.length).toBeGreaterThan(0);
    for (const commit of after) {
      expect(commit.text).not.toContain("Streaming");
      expect(commit.text).not.toContain("Thinking");
      expect(commit.text).not.toContain("pending");
      expect(commit.busy).toBe("false");
    }
    expect(runBodies).toHaveLength(1);
  });

  it("starts a new generated session id when the sessionId prop is removed", async () => {
    const { runBodies } = stubApi({ run: () => completed("ok") });
    const user = userEvent.setup();
    const { rerender } = render(<AgentChat />);

    await say(user, "one");
    await screen.findByText("ok");
    rerender(<AgentChat sessionId="x" />);
    rerender(<AgentChat />);
    await say(user, "two");
    await screen.findByText("ok");

    expect(runBodies[1]!.sessionId).not.toBe(runBodies[0]!.sessionId);
  });

  it("ignores changes to initialTurns after mount", () => {
    stubApi({});
    const { rerender } = render(<AgentChat sessionId="a" initialTurns={saved} />);
    rerender(
      <AgentChat
        sessionId="a"
        initialTurns={[{ input: "Replaced", output: "Nope", status: "completed" }]}
      />,
    );

    expect(screen.getByText("Here's me")).toBeTruthy();
    expect(screen.queryByText("Replaced")).toBeNull();
  });
});

describe("SeclaiAgent", () => {
  it("boots a form or a chat from its mode, against the agent's path", async () => {
    const { fetchMock } = stubApi({});

    const { unmount } = render(<SeclaiAgent mode="form" agentId="a1" basePath="/x" />);
    expect(await screen.findByRole("button", { name: "Run" })).toBeTruthy();
    expect(fetchMock.mock.calls[0]![0]).toBe("/x/a1/attachment-references");
    unmount();

    render(<SeclaiAgent mode="chat" />);
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
  });

  it.each(["form", "chat"] as const)("renders %s mode on the server", (mode) => {
    expect(() => renderToString(<SeclaiAgent mode={mode} />)).not.toThrow();
  });
});

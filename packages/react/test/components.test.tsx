import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AgentChat, AgentRunForm, SeclaiAgent } from "../src";
import { jsonResponse, sse, sseResponse } from "./helpers";

const RUN = "3f2b8c1e-7a4d-4e9b-9c11-0d5e6f7a8b9c";

interface Routes {
  refs?: unknown;
  upload?: (file: File) => Response;
  run?: (body: Record<string, unknown>) => Response;
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
      return run!(body);
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
    // The image is a card in a gallery, which opens it full size.
    expect(screen.getByRole("button", { name: "Open out.png full size" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Download all/ })).toBeNull();
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

  it("numbers a turn's images and offers to download them all", async () => {
    stubApi({
      run: () =>
        completed("Here are two", {
          attachments: [
            { id: "one", name: null, mime: "image/png", bytes: 1 },
            { id: "two", name: null, mime: "image/png", bytes: 1 },
          ],
        }),
    });
    const user = userEvent.setup();
    render(<AgentChat />);

    await say(user, "draw two cats");
    expect(await screen.findByAltText("Image 1")).toBeTruthy();
    expect(screen.getByAltText("Image 2")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Download all 2" })).toBeTruthy();
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

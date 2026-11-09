import type { SeclaiHandlers } from "@seclai/handlers";

/**
 * Sample responses for when no API key is set, so the real components can be seen
 * and clicked through with no setup. Nothing here contacts Seclai. The responses
 * follow the same shapes as the real handlers.
 */
const RUN_ID = "00000000-0000-4000-8000-000000000000";
const IMAGE_ID = "00000000-0000-4000-8000-000000000001";
const TOKEN_DELAY_MS = 70;

const SAMPLE_IMAGE = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270" viewBox="0 0 480 270">
  <rect width="480" height="270" fill="#581c87"/>
  <path d="M0 270 L170 70 L300 200 L380 120 L480 230 V270 Z" fill="#d8b4fe"/>
  <circle cx="390" cy="65" r="30" fill="#f3edff"/>
</svg>`;

const encoder = new TextEncoder();

function frame(event: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function sampleReply(input: string | undefined, fileCount: number): string {
  const files = fileCount ? ` and ${fileCount} file${fileCount === 1 ? "" : "s"}` : "";
  const received = input ? `"${input}"${files}` : files ? files.slice(5) : "your request";
  return `This is a sample reply, not a real agent. It received ${received}, and the words appear one at a time, the way a real run streams them.`;
}

function runStream(agentId: string, input: string | undefined, fileCount: number): ReadableStream<Uint8Array> {
  let cancelled = false;
  const tokens = sampleReply(input, fileCount).split(/(?<= )/);
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        if (!cancelled) controller.enqueue(frame(event, data));
      };

      send("init", { run_id: RUN_ID, status: "processing" });
      send("step_progress", { step_id: "read", step_name: "Read input", message: "completed" });
      await wait(400);
      send("step_progress", { step_id: "reply", step_name: "Write reply", message: "in progress" });

      for (const [seq, token] of tokens.entries()) {
        if (cancelled) return;
        send("stream_token", { step_id: "reply", token, seq });
        await wait(TOKEN_DELAY_MS);
      }

      send("step_progress", { step_id: "reply", step_name: "Write reply", message: "completed" });
      send("done", {
        run_id: RUN_ID,
        status: "completed",
        output: tokens.join(""),
        attempts: [],
        attachments:
          agentId === "demo-image"
            ? [{ id: IMAGE_ID, name: "sample.svg", mime: "image/svg+xml", bytes: SAMPLE_IMAGE.length }]
            : [],
      });
      if (!cancelled) controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
}

export async function demoResponse(
  agentId: string,
  action: keyof SeclaiHandlers,
  request: Request,
): Promise<Response> {
  switch (action) {
    case "attachmentReferences":
      return Response.json({
        requires_uploads: agentId === "demo-file",
        accepted_attachments:
          agentId === "demo-file"
            ? [{ name: "file", label: "File", min: 1, max: 2 }]
            : [],
      });

    case "upload": {
      const form = await request.formData();
      const file = form.get("file");
      const name = typeof file === "string" || !file ? "file" : file.name;
      return Response.json({
        id: crypto.randomUUID(),
        status: "ready",
        filename: name,
        content_type: typeof file === "string" || !file ? "" : file.type,
        file_size: typeof file === "string" || !file ? 0 : file.size,
      });
    }

    case "run": {
      const { input, uploadIds } = (await request.json()) as { input?: string; uploadIds?: string[] };
      return new Response(runStream(agentId, input, uploadIds?.length ?? 0), {
        headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
      });
    }

    case "download":
      return new Response(SAMPLE_IMAGE, { headers: { "content-type": "image/svg+xml" } });
  }
}

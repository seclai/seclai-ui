# @seclai/react

React components and hooks for running [Seclai](https://seclai.com) agents. They talk to [`@seclai/handlers`](https://www.npmjs.com/package/@seclai/handlers) on your server, never to the Seclai API directly. Works in React 18+, Next.js and Astro islands.

## Install

```sh
npm install @seclai/react
```

`react` and `react-dom` 18 or later are peer dependencies. Mount the handlers on your server first: see the [`@seclai/handlers` README](https://www.npmjs.com/package/@seclai/handlers#usage).

## Usage

```tsx
import { SeclaiAgent } from "@seclai/react";
import "@seclai/react/styles.css"; // optional

export function App() {
  return <SeclaiAgent mode="form" />;
}
```

| Prop | Default | |
|---|---|---|
| `mode` | Required | `"form"` for a one-shot run, `"chat"` for a conversation |
| `basePath` | `/api/seclai` | Where the handlers are mounted |
| `agentId` | | For a server hosting several agents: requests go to `${basePath}/${agentId}/run`. The server still decides which agents it serves |

### Components

- **`AgentRunForm`** builds a text input and file inputs from the agent's accepted attachments, uploads the files, then runs with text and files together.
- **`AgentChat`** sends each message as a run with a shared session id and streams the reply.
- **`SeclaiAgent`** renders one of the two based on `mode`.

### Files in `AgentChat`

When the agent accepts attachments, `AgentChat` shows an **Attach** button. Files can also be dropped on the composer or pasted into the message box. Each file uploads as soon as it's added and shows as a chip, with a thumbnail for images, and its upload id goes with the next message. Send stays disabled while a file is uploading. The files a user sent show in their turn. Agents that take no files get the text-only chat, with no attach button.

The chat applies the agent's attachment slots to each message as a whole: it accepts the content types of all the slots, and up to the sum of their `max` (no limit if any slot has none). A file that doesn't fit is refused with a message under the box. A file the browser reports no type for (such as HEIC on Windows, or `.md`) isn't refused for its type: the server decides. A run takes one flat list of upload ids, so the chat can't fill slots separately.

To tell files apart, add named buttons with tags, then use the tags in `onBeforeSend` to describe the files to the agent. Whatever it returns is sent as the run's input, and the transcript keeps what the user typed:

```tsx
<AgentChat
  attachButtons={[
    { label: "+ Headshot", tag: "headshot" },
    { label: "+ Style reference", tag: "style" },
  ]}
  onBeforeSend={({ input, files }) =>
    [...files.map((f, i) => `Image ${i + 1} (${f.name}) is the ${f.tag ?? "image"}.`), input].join("\n")
  }
/>
```

| Prop | |
|---|---|
| `attachButtons` | `{ label: string; tag?: string }[]`. Replaces the single Attach button. Dropped and pasted files have no tag |
| `onBeforeSend` | `({ input, files }) => string \| void`, where `files` are `{ uploadId, name, contentType, tag? }`. Return a string to send it in place of the typed text |

### `useAgentRun`

Build your own UI on the hook:

```tsx
const { status, text, steps, attachments, error, start, cancel } = useAgentRun();

await start({ input: "Hello", uploadIds: ["..."], sessionId: "..." });
```

- `status` is `idle`, `running`, `completed`, `failed` or `cancelled`.
- `text` holds streamed tokens while running, then the run's final output.
- `attachments` have a `url` that goes through your download handler.
- `start` resolves with the final state and doesn't reject. Failures appear in `status` and `error`.
- `cancel` stops streaming, but the run carries on at Seclai.

### Building your own UI

To upload files and run the agent from your own UI, use the helpers the components are built on:

- **`createEndpoints({ basePath, agentId })`** returns the handler URLs (`AgentEndpoints`): `attachmentReferences`, `upload`, `run`, and `download(runId, attachmentId, name?)`. Pass it the same options as `useAgentRun`.
- **`uploadFile(endpoints, file, { signal }?)`** uploads one file and resolves with its `id`.
- **`fetchAttachmentReferences(endpoints, { signal }?)`** resolves with the files the agent accepts (`accepted_attachments`) and whether it needs any (`requires_uploads`).

On an error response, `uploadFile` and `fetchAttachmentReferences` reject with an `Error` whose message comes from the handler. On a network failure or an aborted `signal`, they reject as `fetch` does.

Upload the files first, then start the run with their ids:

```tsx
import { createEndpoints, uploadFile, useAgentRun } from "@seclai/react";

const endpoints = createEndpoints({ agentId: "my-agent" });

function Ask() {
  const { start } = useAgentRun({ agentId: "my-agent" });

  async function send(input: string, files: File[]) {
    const uploads = await Promise.all(files.map((file) => uploadFile(endpoints, file)));
    await start({ input, uploadIds: uploads.map((upload) => upload.id) });
  }
  // ...
}
```

A run's `attachments` already have a `url`. To show a file from a run you stored earlier, build the URL with `download` rather than by hand:

```tsx
<a href={endpoints.download(saved.runId, saved.attachmentId, saved.name)}>{saved.name}</a>
```

## Styling

The components are unstyled apart from the optional stylesheet, which uses Seclai's colours by default. It's built on CSS variables you can set on `:root` or any ancestor, along with `seclai-*` class names:

```css
:root {
  --seclai-accent: #0f766e;
  --seclai-accent-hover: #115e59;
  --seclai-on-accent: #ffffff;
  --seclai-radius: 4px;
}
```

Fonts and text colour come from your page. The default colours follow your page's `color-scheme`, using CSS `light-dark()`, so they need a browser from 2024 or later. Setting a variable to a plain colour works in any browser that supports `color-mix()`.

**On a dark page, declare `color-scheme: dark`** (or `light dark`). Without it the defaults stay in their light versions, and the purple links and focus rings are too dark to read.

## Placeholders

These are exported so the API is in place, but they're minimal until they're ported from the main Seclai app:

| Export | For now | Coming |
|---|---|---|
| `MarkdownContent` | Plain text | GFM tables, KaTeX, mermaid, sanitized SVG |
| `MediaPreview` | Images inline, a download link for everything else | Image, audio, video, PDF, download fallback |

## License

MIT

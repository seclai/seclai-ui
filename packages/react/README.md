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

### Saved sessions

By default `AgentChat` makes up a session id on the first message and keeps the transcript in memory, so a reload starts over. To let users go back to a conversation, give it the session id and the turns you saved, and save each new turn as it finishes:

```tsx
import { AgentChat, type AgentChatTurn } from "@seclai/react";

function SavedChat({ sessionId, turns }: { sessionId: string; turns: AgentChatTurn[] }) {
  return (
    <AgentChat
      sessionId={sessionId}
      initialTurns={turns}
      onTurnComplete={(turn, { sessionId }) =>
        fetch(`/api/chats/${sessionId}/turns`, { method: "POST", body: JSON.stringify(turn) })
      }
    />
  );
}

// Load the turns from your API first, e.g. GET /api/chats/:id/turns, then:
<SavedChat sessionId={id} turns={turns} />;
```

Each `AgentChatTurn` is one exchange, a message and its reply, as plain JSON:

```ts
{
  input: string;               // what the user typed
  sentInput?: string;          // what was sent, when onBeforeSend changed it
  files?: { uploadId, name, contentType, tag? }[];
  output: string;              // for a failed or cancelled run, whatever had streamed
  attachments?: { id, name, mime, bytes }[];
  runId?: string | null;
  status: "completed" | "failed" | "cancelled";
  error?: string | null;
}
```

- `onTurnComplete` is called once per run, when it completes, fails or is cancelled. Store what it gives you as is, and pass the list back as `initialTurns`. Its second argument has the run's `sessionId`, which is the generated one when you don't pass `sessionId`. Always save under that `context.sessionId`, not a session id captured from the surrounding scope: a run cut short by a switch reports through the latest `onTurnComplete`, after your app has moved on to the next conversation.
- Attachments are stored without URLs. The chat rebuilds them from `runId` and the attachment id through your download handler, so they don't go stale, and restored images show as they did live. Restored user files show as name chips, without thumbnails.
- `initialTurns` is read when the chat mounts and when `sessionId` changes. Later changes to it are ignored, as with an input's `defaultValue`.
- Changing `sessionId` switches conversations: the transcript resets to `initialTurns`, the composer clears, and a reply still streaming stops. That run is still reported to `onTurnComplete`, as cancelled, with the old session id. Remounting with a `key` works too.
- The one exception: a chat started without `sessionId` can be handed the id it generated (the `context.sessionId` you saved under), and it keeps its transcript, composer and any reply still streaming. For a new chat, though, prefer generating the id up front (for example with `crypto.randomUUID()`) and passing it from the first message, so the id you save under and the one you pass never differ.

Saving from the browser misses turns when the user closes the tab mid-run. If your server uses the `onRunEnd` hook of `@seclai/handlers`, saving there is more reliable, and the chat then only needs `sessionId` and `initialTurns`.

| Prop | |
|---|---|
| `sessionId` | Sent with every run. Generated on the first message when left out |
| `initialTurns` | `AgentChatTurn[]` to show on mount, or when `sessionId` changes |
| `onTurnComplete` | `(turn: AgentChatTurn, { sessionId }) => void`, once per finished run |

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

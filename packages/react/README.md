# @seclai/react

React components and hooks for running [Seclai](https://seclai.com) agents. They talk to [`@seclai/handlers`](../handlers) on your server, never to the Seclai API directly. Works in React 18+, Next.js and Astro islands.

## Install

```sh
npm install @seclai/react
```

`react` and `react-dom` 18 or later are peer dependencies. Mount the handlers on your server first: see the [`@seclai/handlers` README](../handlers/README.md#usage).

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

The components are unstyled apart from the optional stylesheet. It's built on CSS variables you can override, along with `seclai-*` class names:

```css
.seclai-agent {
  --seclai-radius: 4px;
  --seclai-gap: 16px;
  --seclai-error: crimson;
}
```

## Placeholders

These are exported so the API is in place, but they're minimal until they're ported from the main Seclai app:

| Export | For now | Coming |
|---|---|---|
| `MarkdownContent` | Plain text | GFM tables, KaTeX, mermaid, sanitized SVG |
| `MediaPreview` | Images inline, a download link for everything else | Image, audio, video, PDF, download fallback |
| `KnowledgeBaseChat` | A notice | Knowledge base chat |

## License

MIT

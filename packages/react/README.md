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

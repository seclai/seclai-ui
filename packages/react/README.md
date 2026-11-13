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

## Media

`AgentRunForm` and `AgentChat` show a run's attachments in a `MediaGallery`. The media components are exported too, for your own UI:

```tsx
import { MediaGallery, MediaPreview, MediaSkeleton, MediaViewer } from "@seclai/react";

<MediaGallery
  attachments={run.attachments}
  aspectRatio="16 / 9"
  pending={run.status === "running" ? 4 : 0}
  actions={(attachment, number) => <button onClick={() => refine(number)}>Refine</button>}
/>
```

- **`MediaPreview`** shows one attachment. An image gets a card: a fixed-ratio frame so the layout doesn't jump while it loads, an optional number badge and a download link. Files that aren't images are a download link.
- **`MediaGallery`** lays out a run's images as numbered cards that open a full-size viewer, with "Download all" when there's more than one. It downloads the files one at a time, because browsers block a burst of simultaneous downloads. Other files follow the images as download links.
- **`MediaSkeleton`** is a placeholder card for an image that's still being generated. It pulses, unless the user prefers reduced motion.
- **`MediaViewer`** is the gallery's full-size viewer, a modal `<dialog>` with previous and next (also on the arrow keys) and a download button. Escape, the close button or a click on the backdrop closes it, and focus goes back to where it was. It's controlled: pass the `index` to show, or `null` when closed.
- **`attachmentFileName(attachment, number?)`** is the filename the components save a file as: its own name, or else `image-<number>` (or its id) with an extension from the mime type, such as `image-2.png`.

| `MediaPreview` prop | |
|---|---|
| `attachment` | Required. The file to show |
| `aspectRatio` | The frame's ratio, as a number (`16 / 9`) or a string (`"16 / 9"`). Without it the frame takes the image's own ratio once it loads, and `--seclai-media-aspect-ratio` (square) until then |
| `number` | A badge on the image, matching the agent's numbered list. Also names an unnamed download `image-<number>` |
| `actions` | App-specific buttons after the download link: a node, or a function of the attachment |
| `onOpen` | Makes the image a button, for opening a viewer |

| `MediaGallery` prop | |
|---|---|
| `attachments` | Required. A run's attachments |
| `aspectRatio` | Every card's ratio. Without it each card takes its image's own ratio |
| `pending` | How many skeleton cards to show after the images, numbered on from them |
| `actions` | `(attachment, number) => ReactNode`, for each image card |

The stylesheet adds these variables for media: `--seclai-media-aspect-ratio` (a frame's ratio before its image loads, `1 / 1`), `--seclai-media-fit` (`object-fit` in the frame, `scale-down`, so small images keep their natural size), `--seclai-media-min-width` (a gallery column's minimum width, `220px`) and `--seclai-media-max-width` (a card's width outside a gallery, `480px`). The viewer is dark in both colour schemes.

## Placeholders

These are exported so the API is in place, but they're minimal until they're ported from the main Seclai app:

| Export | For now | Coming |
|---|---|---|
| `MarkdownContent` | Plain text | GFM tables, KaTeX, mermaid, sanitized SVG |
| `MediaPreview` | Image cards (see [Media](#media)), a download link for everything else | Audio, video and PDF previews |

## License

MIT

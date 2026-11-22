# @seclai/react

React components and hooks for running [Seclai](https://seclai.com) agents. They talk to [`@seclai/handlers`](https://www.npmjs.com/package/@seclai/handlers) on your server, never to the Seclai API directly. Works in React 18+, Next.js and Astro islands.

## Install

```sh
npm install @seclai/react
```

`react` and `react-dom` 18 or later are peer dependencies. Mount the handlers on your server first: see the [`@seclai/handlers` README](https://www.npmjs.com/package/@seclai/handlers#usage).

### Module format

`@seclai/react` ships as ES modules only. Bundlers and `import` work as usual. CommonJS code, such as a server-rendering setup, can `require` it on Node 22.12 or later; Node 22.12 and Node 23.0 to 23.4 print an `ExperimentalWarning` the first time, and Node 22.13+ and 23.5+ don't.

In a TypeScript CommonJS project, set `module` to `nodenext` (TypeScript 5.8+) or `node20` (TypeScript 5.9+), so the compiler allows that `require`. With `node16` or `node18` it reports error TS1479 on the import. `commonjs` with `moduleResolution` `node10` and the `bundler` setting work as they are.

Jest's default CommonJS mode doesn't transform packages in `node_modules`, so tell it to transform this one, for example with `transformIgnorePatterns: ["/node_modules/(?!(\\.pnpm/)?@seclai[/+])"]` (the `.pnpm` part covers pnpm's layout), using a transform that converts ES modules to CommonJS, such as `babel-jest` with `@babel/preset-env`. Vitest needs no setup.

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
- **`RunProgress`** shows a running run's steps and elapsed time. See [below](#runprogress).
- **`MarkdownContent`** renders the agent's replies, including while they stream. See [Markdown](#markdown).

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
const { status, text, steps, attachments, error, startedAt, start, cancel, reset } = useAgentRun({
  onEvent: (event) => console.debug(event.event, event.data),
});

await start({ input: "Hello", uploadIds: ["..."], sessionId: "..." });
```

- `status` is `idle`, `running`, `completed`, `failed` or `cancelled`.
- `text` holds streamed tokens while running, then the run's final output.
- `attachments` have a `url` that goes through your download handler.
- `startedAt` is when `start` began, from `Date.now()`. It's kept after the run ends and is `null` before the first run and after `reset`.
- `start` resolves with the final state and doesn't reject. Failures appear in `status` and `error`. A run stopped by `cancel()` or `reset()` resolves as `cancelled`.
- `cancel` stops streaming, but the run carries on at Seclai.
- `reset` returns to `idle` and clears `text`, `steps`, `attachments`, `error`, `runId` and `startedAt`. During a run it stops streaming as `cancel` does, so the run also carries on at Seclai.
- `onEvent` is called with each event from the run stream, `{ event, data }`, in order, as the hook updates its state. Events from a stopped run aren't passed on. The latest callback is always used, so an inline function is fine. If it throws, the error goes to `console.error` and the run carries on.

Options also take `basePath` and `agentId`, as the components do.

### `RunProgress`

Runs that generate images can take a minute or two. `RunProgress` shows a running run's steps and the time elapsed, and renders nothing otherwise:

```tsx
import { RunProgress, useAgentRun } from "@seclai/react";

const run = useAgentRun();

<RunProgress
  run={run}
  message={(seconds) => (seconds < 150 ? "Generating images usually takes a minute or two." : "Still working…")}
/>
```

- It shows "Starting the run…" until the first step, then each step's name and message, with ✓ for finished steps and ● for the current one.
- The clock reads `m:ss`, and screen readers get "42 seconds elapsed". Steps and the message are announced as they change, but the clock isn't, so keep the seconds out of `message`.
- `run` needs only `status`, `steps` and `startedAt`, so a plain object works too.
- `AgentChat` shows it until the reply starts streaming.

| Prop | |
|---|---|
| `run` | Required. `{ status, steps, startedAt }`, such as a `useAgentRun` result |
| `showSteps` | Show the step list. Defaults to `true` |
| `message` | A note next to the clock: a node, or `(seconds) => ReactNode` |
| `className` | Added to the outer element |

For just the clock, `useElapsed(startedAt, running)` returns whole seconds since `startedAt`, ticking while `running`. It's 0 on the first render, so server and client markup match.

### Building your own UI

To upload files and run the agent from your own UI, use the helpers the components are built on:

- **`createEndpoints({ basePath, agentId })`** returns the handler URLs (`AgentEndpoints`): `attachmentReferences`, `upload`, `run`, and `download(runId, attachmentId, name?)`. Pass it the same options as `useAgentRun`.
- **`uploadFile(endpoints, file, { signal, params }?)`** uploads one file and resolves with its `id`. `params` is added to the upload URL's query string, for the server's upload hooks. See [Sending data with an upload](#sending-data-with-an-upload).
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

#### Sending data with an upload

Pass `params` to tell the server what an upload is for, such as the session it belongs to or its role. They're added to the upload URL, after any query string it already has, and `@seclai/handlers` passes them to `authorizeUpload` and `upload.onUpload`. They're visible in the URL, so keep secrets out of them.

If the server's `onUpload` returns its own record, name its type:

```ts
type MyUpload = { id: string; uploadId: string; sessionId: string; kind: "headshot" | "style" };

const upload = await uploadFile<MyUpload>(endpoints, file, { params: { sessionId, kind: "headshot" } });
upload.kind; // "headshot" | "style"
```

The type isn't checked at run time: it's whatever the server sends. Without one, the result is an `UploadResult`. When the record replaces the default JSON, start the run with the Seclai upload id it holds (`uploadId` here), not your record's own `id`.

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

### Saving files

The gallery's downloads are exported, for your own buttons:

```tsx
import { MediaGallery, saveFile } from "@seclai/react";

<MediaGallery
  attachments={run.attachments}
  actions={(attachment, number) => (
    <button onClick={async () => saveFile(await toJpeg(attachment.url), `thumbnail-${number}.jpg`)}>
      Save as JPEG
    </button>
  )}
/>
```

Here `toJpeg` is your own code that draws the image on a canvas and returns `canvas.toBlob()`'s result.

- **`saveFile(urlOrBlob, filename)`** saves a URL or a `Blob` through a temporary `<a download>`. A URL that isn't `http:`, `https:`, `blob:` or relative (such as `javascript:`) is skipped with a warning. For a `Blob` it makes an object URL and revokes it 40 seconds later, once the browser has had time to start the download. Without a `document`, as in server rendering, it does nothing.
- **`saveFiles(files, { delayMs, signal })`** saves `{ source, filename }` files one at a time with `saveFile`, waiting `delayMs` (400 ms) between them, as "Download all" does. A `source` is a URL or a `Blob`. It stops when `signal` aborts.

## Markdown

`AgentRunForm` and `AgentChat` show the agent's replies, and the user's messages, with `MarkdownContent`. It's exported for your own UI too:

```tsx
import { MarkdownContent } from "@seclai/react";

<MarkdownContent content={run.text} streaming={run.status === "running"} />
```

| Prop | |
|---|---|
| `content` | Required. The Markdown |
| `streaming` | The text is still arriving. See [Streaming](#streaming) |
| `extensions` | Extensions such as `math()`, in place of the ones from `SeclaiMarkdownProvider` |

It renders [GitHub Flavored Markdown](https://github.github.com/gfm/):

- paragraphs, headings, **bold**, *emphasis*, ~~strikethrough~~, block quotes and rules;
- links, and bare URLs and emails, which become links;
- inline code and code blocks, fenced or indented, in a monospace font. Code blocks scroll sideways rather than wrap;
- lists, nested by indenting an item to the text of the item above, with paragraphs and code blocks inside items;
- tables, which scroll sideways when they're too wide;
- task lists (`- [ ]`, `- [x]`), as disabled checkboxes, and footnotes.

Agent replies get a few extras:

- **Numbered items keep the number the agent wrote.** Markdown only keeps a list's first number and counts on from it, so `1. 1. 1.` would read 1, 2, 3. Each number shows in a badge like `MediaPreview`'s, so "2." in the text matches image 2. The list is still an `<ol>` with `start` and `value` set.
- **A single newline is a line break**, as in chat apps, rather than a space. `<br>` is one too, as agents write it in table cells.
- **`•` works as a bullet**, as well as `-`, `*` and `+`.

Maths, Mermaid diagrams and HTML are opt-in: see [Extensions](#extensions).

### Streaming

`MarkdownContent` re-renders on every token. To stay fast on long replies, it splits the text into top-level blocks, such as paragraphs, lists, tables and code blocks, and only parses the last one again: about 2 ms per token on a 50 KB reply, where parsing the whole reply takes over 100 ms. Blocks are split where the parser ended one, so a list with blank lines between its items, or a code block holding a blank line, stays whole. A reply with a link reference definition (`[docs]: https://…`) or a footnote is parsed whole, as those change text elsewhere in it.

Partial text renders as what it is so far, without errors or garbage:

- An unclosed code fence is a code block to the end.
- A table's header row is text until its delimiter row arrives.
- An unclosed `**`, `` ` `` or `[link](` is text until it closes.
- Maths and diagrams render once they're complete: see [Extensions](#extensions).

With `streaming` set (`AgentRunForm` and `AgentChat` set it while a reply streams), an unfinished last line that could still turn into something else is held back until more of it arrives: a bare list marker (`-`, `2.`), the start of a rule or heading underline (`-`, `--`, `* *`), a fence (```` ``` ````, `$$`), a table's delimiter row (`| --- |`) or a bare `#`. Shown as they are, these would flash as an empty list item, or turn the line above into a heading, for a token or two.

### Extensions

HTML, maths and Mermaid diagrams are extensions, each in an entry of its own, so an app that doesn't use one doesn't bundle it. Pass them to every `MarkdownContent` at once, including the ones `AgentRunForm` and `AgentChat` render, with `SeclaiMarkdownProvider`:

```tsx
import { AgentChat, SeclaiMarkdownProvider } from "@seclai/react";
import { html } from "@seclai/react/html";
import { math } from "@seclai/react/math";
import { mermaid } from "@seclai/react/mermaid";
import "katex/dist/katex.min.css"; // for math()

const extensions = [html(), math(), mermaid()];

export function App() {
  return (
    <SeclaiMarkdownProvider extensions={extensions}>
      <AgentChat />
    </SeclaiMarkdownProvider>
  );
}
```

Or pass them to one `MarkdownContent` with its `extensions` prop, which replaces the provider's. Each factory returns the same extension every time, so calling them inline is fine.

| Extension | Install | Renders |
|---|---|---|
| `html()` from `@seclai/react/html` | Nothing more | HTML in the Markdown, such as `<sub>`, `<kbd>`, `<details>` and inline `<svg>` charts, sanitized (see [Security](#security)). Without it, HTML shows as the text it is. It bundles an HTML parser, about 50 KB gzipped |
| `math()` from `@seclai/react/math` | `katex` and `remark-math` | `$…$` and `\(…\)` inline, `$$…$$` and `\[…\]` as a block, and ```` ```math ```` fences, with [KaTeX](https://katex.org). Import KaTeX's stylesheet, `katex/dist/katex.min.css`, once in your app: without it the maths shows twice, as text and as MathML |
| `mermaid()` from `@seclai/react/mermaid` | `mermaid` | ```` ```mermaid ```` code blocks as [Mermaid](https://mermaid.js.org) diagrams. Mermaid is loaded on demand the first time a diagram shows, so bundlers split it into chunks of its own |

**Before turning on `html()`:** with it, angle brackets in prose are read as HTML tags, and a tag that isn't on the allowlist is removed. Agents write such text all the time outside backticks, and the reader sees words go missing with no sign of why:

| The agent writes | Shows with `html()` |
|---|---|
| `Return a List<String> of names` | Return a List of names |
| `Pass the <filename> argument` | Pass the  argument |
| `If a<b and c>d then swap.` | If a**d then swap.** (read as a `<b>` tag) |

Text in backticks, such as `` `List<String>` ``, is safe. So turn `html()` on only for agents that are meant to produce HTML or SVG, and prompt them to put code, types and placeholders in backticks. A tag left open also makes the rest of the reply re-parse whole on every streamed token, which slows long replies down.

`katex`, `remark-math` and `mermaid` are optional peer dependencies: install them only for the extensions you use.

```sh
npm install katex remark-math   # for math()
npm install mermaid             # for mermaid()
```

How they handle partial and invalid input:

- **Maths** renders once its closing delimiter arrives. Until then, `$…` is text, and a `$$` block or ```` ```math ```` fence shows its source as a code block. Invalid LaTeX shows as its source in code, not as a KaTeX error. `\(…\)` and `\[…\]` are rewritten to `$…$` and `$$…$$` before parsing, except in code. As in most Markdown maths, `$5 and $10` on one line is read as maths.
- **A Mermaid diagram** is drawn once its closing fence arrives. Until then, while Mermaid loads, and if the diagram has a syntax error, its source shows as a code block. `mermaid({ theme: "dark" })` picks Mermaid's theme (`"default"`, on a white background, unless set). Mermaid has one configuration per page, so the first theme used applies to every diagram.

To write your own, a `MarkdownExtension` is an object with any of `remarkPlugins`, `rehypePluginsBeforeSanitize`, `rehypePlugins`, `components` and `transform`. `rehypePlugins` run after sanitizing, so they must only add HTML they built. `components` replace the built-in ones, as in [react-markdown](https://github.com/remarkjs/react-markdown#components). Create an extension once, outside your components, rather than on every render: a new object is a new set of plugins, which renders every block again. For example, to show images inline rather than as links (see [Security](#security)):

```tsx
const images: MarkdownExtension = {
  components: { img: ({ node: _, ...props }) => <img {...props} loading="lazy" /> },
};
```

### Security

Agent output is untrusted: a reply can be steered by whatever the agent read. So:

- **Links** keep only `http:`, `https:` and `mailto:` URLs, and relative ones (`/path`, `#id`). Anything else, such as `javascript:` or `data:`, is removed, and the link shows as its text. `http:` and `https:` links open in a new tab with `rel="noopener noreferrer"`.
- **Images show as links** to the image (with its alt text, or else its URL), rather than loading. A reply could otherwise use an image URL to send data from the conversation to another server, or to track that it was viewed. An image inside a link shows as its alt text. To show images anyway, replace the `img` component with an extension, as above; the URL rules still apply, so only `http:`, `https:` and relative image URLs load.
- **HTML shows as text** unless `html()` is on. With it, HTML is sanitized to an allowlist: [GitHub's](https://github.com/syntax-tree/hast-util-sanitize#defaultschema), plus SVG shapes, text, gradients, markers, masks and filters. `<script>`, `<style>`, `<iframe>`, `<foreignObject>`, `<template>` and `<noscript>` are removed with their content; other elements not on the list, such as `<form>` or `<object>`, are removed but keep their text. `on*` event handlers, `style`, `class`, `accesskey` and `tabindex` attributes are removed. Every `id` is prefixed with `user-content-`, so a reply can't clobber the app's own ids, and in-page links (`#id`) follow the prefix. In SVG, `href` and `url(…)` can only point at an id in the same reply.
- **KaTeX** runs with `trust: false`, so `\href`, `\url`, `\includegraphics` and the `\html…` commands don't produce links, images or attributes.
- **Mermaid** runs with `securityLevel: "strict"` and `startOnLoad: false`, and syntax errors show the source rather than Mermaid's error diagram. Labels can't hold images or `style` attributes, and a diagram's `%%{init: …}%%` directive can't set `themeCSS`, `fontFamily`, `altFontFamily` or the label sanitizing, which Mermaid copies into the diagram as they are, so a diagram can't load outside URLs or restyle the page.

### Styling Markdown

The stylesheet styles Markdown with the same `--seclai-*` variables, in light and dark colour schemes. The root is a `div.seclai-markdown`, and its elements are plain HTML (`p`, `h1` to `h6`, `pre > code`, `table`, `blockquote` and so on), so `.seclai-markdown h2` and the like work for your own styles. It also uses:

| Class | |
|---|---|
| `.seclai-markdown-number` | A numbered item's badge, the first child of its `li`. The item's content is in a `div` after it |
| `.seclai-markdown-table` | The scrolling wrapper around a table |
| `.seclai-markdown-image` | The link an image shows as |
| `.seclai-markdown-math` | KaTeX's output: a `span` inline, a `div` for a block |
| `.seclai-markdown-mermaid` | A drawn diagram, with `data-theme` set to its Mermaid theme |
| `.task-list-item`, `.contains-task-list` | A task list's items, and the list |
| `section.footnotes` | The footnotes, at the end |

Two more variables: `--seclai-code-font` (the monospace font for code) and `--seclai-code-surface` (the background of code blocks and inline code).

## Placeholders

`MediaPreview` is exported so the API is in place, but it's minimal until it's ported from the main Seclai app: it shows image cards (see [Media](#media)) and a download link for everything else. Audio, video and PDF previews are still to come.

## License

MIT

# Seclai playground

A private local test app that wires `@seclai/handlers` and `@seclai/react` together through `workspace:*`. It is never published.

It covers four cases against real agents: text in and text out, file in, image out, and multi-turn chat.

## Run it

```sh
# From the repo root
pnpm install
pnpm build

cd starters/playground
pnpm dev
```

Then open http://localhost:4321. Run `pnpm build` at the root again after changing a package, since the playground uses each package's `dist`.

With no API key, every tab runs on sample replies from `src/lib/demo.ts` and nothing contacts Seclai. To use real agents, run `cp .env.example .env`, add your API key and agent ids, and restart.

## What each case needs with real agents

| Case | `.env` variable | Agent |
|---|---|---|
| Text in, text out | `SECLAI_AGENT_ID_TEXT` | `dynamic_input` trigger. Add a `streaming_result` step to see tokens stream |
| File in | `SECLAI_AGENT_ID_FILE` | `dynamic_input` trigger with accepted attachments |
| Image out | `SECLAI_AGENT_ID_IMAGE` | Any agent whose run output includes an image attachment |
| Multi-turn chat | `SECLAI_AGENT_ID_CHAT` | Keys its conversation on `{{metadata.session_id}}` |

Markdown renders as plain text, because `MarkdownContent` is still a placeholder. Images show as cards that open full size, but other files are download links until `MediaPreview` gets audio, video and PDF previews.

## Astro version

Astro is pinned to 7.4.1, the newest release that runs on Node 22.22. Later 7.x releases need Node 22.23.4 or newer, so the pin can go once everyone is on that.

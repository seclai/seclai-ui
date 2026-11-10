# Seclai UI

Official Seclai UI components and server handlers for building apps on Seclai agents.

| Package | What it is |
|---|---|
| [`@seclai/handlers`](packages/handlers) | Framework-free server handlers (upload, run + SSE relay, download proxy) over [`@seclai/sdk`](https://github.com/seclai/seclai-javascript). Runs on Vercel, Netlify, Cloudflare Workers, Node, Deno, Bun. |
| [`@seclai/react`](packages/react) | React components and hooks for running agents: run form and chat. Markdown and media output are placeholders for now, to be ported from the main Seclai app. Works in React, Next.js and Astro. |

Deploy-ready starters will live in their own public repos. `starters/` holds only the private [playground](starters/playground), a local test app that is never published.

## Development

```sh
pnpm install
pnpm build      # run before typecheck: the playground's types come from each package's dist
pnpm typecheck
pnpm test
```

## Releasing

Packages are versioned independently with [Changesets](https://github.com/changesets/changesets).

```sh
pnpm changeset   # describe your change, pick the packages it affects
```

Merging to `main` opens a "Version Packages" PR; merging that PR publishes to npm.

## License

MIT

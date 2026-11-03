# @seclai/handlers

Server handlers for running [Seclai](https://seclai.com) agents from a web app. They use only the Web `Request` and `Response` APIs, and hold your API key on the server so the browser never sees it.

## Install

```sh
npm install @seclai/handlers
```

## Usage

`createSeclaiHandlers` returns one function per endpoint, each taking a `Request` and returning a `Promise<Response>`. Routing is up to your framework.

```ts
import { createSeclaiHandlers } from "@seclai/handlers";

const seclai = createSeclaiHandlers({
  apiKey: process.env.SECLAI_API_KEY!,
  agentId: process.env.SECLAI_AGENT_ID!,
});

// Next.js route handler: app/api/seclai/run/route.ts
export const POST = seclai.run;
```

`@seclai/react` expects these routes under its base path, which defaults to `/api/seclai`:

| Route | Handler | Request | Response |
|---|---|---|---|
| `GET /attachment-references` | `attachmentReferences` | | Which files the agent accepts |
| `POST /upload` | `upload` | Multipart form with a `file` field | `{ id, status, filename, content_type, file_size }` |
| `POST /run` | `run` | JSON `{ input?, uploadIds?, sessionId? }` | Server-sent event stream |
| `GET /download` | `download` | `?runId=&attachmentId=&name=` | The file's bytes |

`run` needs `input`, `uploadIds`, or both. `sessionId` reaches the agent as `metadata.session_id`, which is what chat agents key a conversation on.

### Options

| Option | Default | |
|---|---|---|
| `apiKey` | Required | Your Seclai API key |
| `agentId` | Required | The agent to run |
| `apiVersion` | `2026-10-28` | Dated API version. Must be `2026-10-16` or later |
| `runTimeoutMs` | 11 minutes | How long a streaming run may take |

## The run stream

`run` relays the API's events unchanged, including `init`, `step_progress`, `stream_token`, `stream_end` and `done`, and sends a `: keepalive` comment every 15 seconds.

- If the API rejects a run up front (a file the agent doesn't accept, no credits), `run` returns a real HTTP error with `{ error, status }`, not a stream.
- If the stream fails after it has started, it ends with an `error` event carrying `{ error }`.
- When the browser disconnects, the upstream connection closes. **The run itself keeps going on Seclai** and may keep using credits.

## Limits to know before deploying

- **The endpoints have no auth.** Anyone who can reach them can run your agent on your credits. Put your own access control or rate limiting in front of a public deployment.
- **The API key is account-wide.** `download` checks that ids are well formed, but the API only checks that a run belongs to the account, not to this agent. Anyone holding a run's id and a file's id from the same account could fetch that file. Run ids are random UUIDs, so they can't be guessed.
- **Uploads pass through your function**, so your platform's body limit applies, not the API's 200 MB: about 4.5 MB on Vercel and 6 MB on Netlify. The API has no CORS, so the browser can't upload to it directly.
- **Your platform's function duration limit** may end a long run before `runTimeoutMs` does.

## Runtimes

The handlers need only Web APIs and a global `fetch`, so they are designed for Vercel, Netlify, Cloudflare Workers, Node 18+, Deno and Bun.

On Cloudflare Workers, the `nodejs_compat` flag isn't needed. Create the handlers inside your `fetch` handler, since that's where `env` holds your API key.

## License

MIT

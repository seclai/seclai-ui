# @seclai/handlers

Server handlers for running [Seclai](https://seclai.com) agents from a web app. They use only the Web `Request` and `Response` APIs, and hold your API key on the server so the browser never sees it.

## Install

```sh
npm install @seclai/handlers
```

## Usage

`createSeclaiHandlers` returns a function per endpoint, each taking a `Request` and returning a `Promise<Response>`, plus `handle`, which serves all of them from one catch-all route.

```ts
// Next.js: app/api/seclai/[action]/route.ts
import { createSeclaiHandlers } from "@seclai/handlers";

const seclai = createSeclaiHandlers({
  apiKey: process.env.SECLAI_API_KEY!,
  agentId: process.env.SECLAI_AGENT_ID!,
});

export const GET = seclai.handle;
export const POST = seclai.handle;
```

```ts
// Astro: src/pages/api/seclai/[action].ts
export const prerender = false;
export const ALL: APIRoute = ({ request }) => seclai.handle(request);
```

`handle` picks the handler from the last segment of the URL path and returns a 404 for anything else. To mount routes one by one instead, use `seclai.run`, `seclai.upload` and the rest directly.

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
| `upload` | None | Size limit, content-type check and hook for `upload`, below |

### Upload options

```ts
const seclai = createSeclaiHandlers({
  apiKey: process.env.SECLAI_API_KEY!,
  agentId: process.env.SECLAI_AGENT_ID!,
  upload: {
    maxBytes: 4 * 1024 * 1024,
    checkContentType: true,
    async onUpload(file, result, req) {
      await saveCopy(result.id, file);
    },
  },
});
```

| Option | Default | |
|---|---|---|
| `maxBytes` | No limit | Largest file accepted, in bytes. A bigger one gets a 413 |
| `checkContentType` | `false` | Give a 415 to a file whose type none of the agent's attachment slots accepts |
| `onUpload(file, result, req)` | None | Called after a successful upload. Return a `Response` to replace the default JSON |

All three refuse a file before it reaches the API, and `onUpload` runs only after the API has accepted one.

- **`maxBytes`** is checked against `content-length` first, so a request that declares an oversized body is refused before it's read. Without `content-length`, as with a chunked body, the bytes are counted as they stream and reading stops with a 413 once they pass the limit. Both checks allow 64 KB for the multipart envelope, and the file's own size is checked once the form is read.
- **`checkContentType`** reads the slots with `getAgentAttachmentReferences` and reuses them for 60 seconds, so an edit to the agent's slots takes up to a minute to apply. A slot type is exact, like `application/pdf`, or a wildcard, like `image/*`. A slot with no types accepts every file. A file of unknown type isn't checked and goes on to the API, which decides: browsers send no type for `.md`, some `.csv` files or HEIC on Windows, and such a file arrives as `application/octet-stream`. An agent with no slots takes no typed files, so they all get a 415. If the lookup fails, the upload is refused with the error from the API, usually a 502, and the next upload tries again. Slots' `name_pattern` isn't checked here: the API checks it when the run starts. The slots are kept per `createSeclaiHandlers` instance, so where the handlers are created per request, as on Cloudflare Workers, every upload makes its own lookup.
- **`onUpload`** receives the `File`, the `{ id, status, filename, content_type, file_size }` the handler would return, and the `Request`, whose body has already been read. Returning nothing keeps the default response. If it throws, the browser gets a 500 with a generic message. The file is already on Seclai by then.

## The run stream

`run` relays the API's events unchanged, including `init`, `step_progress`, `stream_token`, `stream_end` and `done`, and sends a `: keepalive` comment every 15 seconds.

- If the API rejects a run up front (a file the agent doesn't accept, no credits), `run` returns a real HTTP error with `{ error, status }`, not a stream.
- If the stream fails after it has started, it ends with an `error` event carrying `{ error }`.
- When the browser disconnects, the upstream connection closes. **The run itself keeps going on Seclai** and may keep using credits.

## Limits to know before deploying

- **The endpoints have no auth.** Anyone who can reach them can run your agent on your credits. Put your own access control or rate limiting in front of a public deployment.
- **The API key is account-wide.** `download` checks that ids are well formed, but the API only checks that a run belongs to the account, not to this agent. Anyone holding a run's id and a file's id from the same account could fetch that file. Run ids are random UUIDs, so they can't be guessed.
- **Uploads pass through your function**, so your platform's body limit applies, not the API's 200 MB: about 4.5 MB on Vercel and 6 MB on Netlify. The API has no CORS, so the browser can't upload to it directly. Set `upload.maxBytes` below that limit so the browser gets a clear 413 instead of the platform's error, and `upload.checkContentType` to refuse files the agent can't use before they're sent on.
- **Your platform's function duration limit** may end a long run before `runTimeoutMs` does.

## Runtimes

The handlers need only Web APIs and a global `fetch`, so they are designed for Vercel, Netlify, Cloudflare Workers, Node 18+, Deno and Bun.

On Cloudflare Workers, the `nodejs_compat` flag isn't needed. Create the handlers inside your `fetch` handler, since that's where `env` holds your API key.

## License

MIT

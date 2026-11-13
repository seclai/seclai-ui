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
| `context` | None | `(req)`: your per-request context, such as the signed-in user, passed to every hook. See [Access control](#access-control) |
| `authorizeRun` | None | `(req, body, ctx)`: refuse or rewrite a run. See [Access control](#access-control) |
| `authorizeUpload` | None | `(req, file, ctx)`: refuse an upload before it reaches Seclai |
| `authorizeDownload` | None | `(req, { runId, attachmentId }, ctx)`: return `true` to serve the file |

### Access control

Three hooks check requests against your own data before they reach the API. They apply to the individual handlers and to `handle`, and may be sync or async.

```ts
import { createSeclaiHandlers, deny } from "@seclai/handlers";

const seclai = createSeclaiHandlers({
  apiKey: process.env.SECLAI_API_KEY!,
  agentId: process.env.SECLAI_AGENT_ID!,

  // Runs once per hooked request, only when a hook needs it.
  async context(req) {
    const user = await getUser(req);
    if (!user) throw deny(401, "Sign in first.");
    return { user };
  },

  async authorizeRun(req, body, { user }) {
    if (body.sessionId && !(await db.sessionBelongsTo(body.sessionId, user.id))) {
      return deny(403, "That isn't your conversation.");
    }
    // Returning nothing runs the body as it is.
  },

  authorizeUpload: (req, file, { user }) => user.canUpload,

  async authorizeDownload(req, { runId }, { user }) {
    return db.runBelongsTo(runId, user.id);
  },
});
```

**Allowing and refusing**

| Hook | Allow | Refuse |
|---|---|---|
| `authorizeRun` | Return nothing or `true`, or a rewritten body to run instead | `false` (403), or a `Response` |
| `authorizeUpload` | Return nothing or `true` | `false` (403), or a `Response` |
| `authorizeDownload` | Return `true` | `false` (404), or a `Response`. Returning nothing also refuses, and logs a warning |

- **Any hook can refuse by throwing a `Response`**, or by returning one, so a check deep in your data layer can `throw deny(...)`. The `context` function can too, which refuses every hooked request at once.
- **`deny(status, message)`** builds the same `{ error, status }` JSON the handlers use for their own errors. `@seclai/react` shows the `error` text to the user.
- **`authorizeDownload` fails closed** because it guards stored files: anything but `true` or a `Response` is a 404, the same as a missing file, so a refusal doesn't confirm the file exists.
- **Rewrites.** `authorizeRun` gets the body after `run` has validated it. It may return a rewritten body, for example to add context to `input` or swap in server-side `uploadIds`. The rewrite is validated again.
- **Errors.** If a hook or `context` throws anything other than a `Response`, the browser gets a 500 with a generic message, and the error is logged with `console.error`. A rewrite that fails validation is also a logged 500, with the reason.

**Context your framework already has**

When your framework has already resolved the user, pass it with `withContext` instead of the `context` option. It returns the same handlers with that context bound, so they keep the `(req) => Response` shape:

```ts
// React Router: app/routes/api.seclai.$action.ts
const seclai = createSeclaiHandlers<{ userId: string }>({ apiKey, agentId, authorizeRun, authorizeDownload });

export const loader = ({ request, context }: Route.LoaderArgs) =>
  seclai.withContext({ userId: context.get(userContext).id }).handle(request);
export const action = loader;
```

The context's type is inferred from the `context` option, or set as the type parameter. Without a `context` option, a typed context is only reachable through `withContext`: TypeScript doesn't offer `seclai.handle` on its own, so a route can't call the hooks without the context. A context type that includes `undefined` keeps the plain handlers.

## The run stream

`run` relays the API's events unchanged, including `init`, `step_progress`, `stream_token`, `stream_end` and `done`, and sends a `: keepalive` comment every 15 seconds.

- If the API rejects a run up front (a file the agent doesn't accept, no credits), `run` returns a real HTTP error with `{ error, status }`, not a stream.
- If the stream fails after it has started, it ends with an `error` event carrying `{ error }`.
- When the browser disconnects, the upstream connection closes. **The run itself keeps going on Seclai** and may keep using credits.

## Limits to know before deploying

- **The endpoints have no auth by default.** Anyone who can reach them can run your agent on your credits. Use the [access-control hooks](#access-control) to check the caller, and put rate limiting in front of a public deployment. `attachment-references` has no hook, so guard that route yourself if the agent's accepted files are sensitive.
- **The API key is account-wide.** `download` checks that ids are well formed, but the API only checks that a run belongs to the account, not to this agent. Without [`authorizeDownload`](#access-control), anyone holding a run's id and a file's id from the same account could fetch that file. Run ids are random UUIDs, so they can't be guessed, but only your app knows which runs a caller may read.
- **Uploads pass through your function**, so your platform's body limit applies, not the API's 200 MB: about 4.5 MB on Vercel and 6 MB on Netlify. The API has no CORS, so the browser can't upload to it directly.
- **Your platform's function duration limit** may end a long run before `runTimeoutMs` does.

## Runtimes

The handlers need only Web APIs and a global `fetch`, so they are designed for Vercel, Netlify, Cloudflare Workers, Node 18+, Deno and Bun.

On Cloudflare Workers, the `nodejs_compat` flag isn't needed. Create the handlers inside your `fetch` handler, since that's where `env` holds your API key.

## License

MIT

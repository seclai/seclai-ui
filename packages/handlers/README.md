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
| `onEvent` | None | `(event, ctx)`: called with each run event before it is relayed. See [Run callbacks](#run-callbacks) |
| `onRunEnd` | None | `(outcome, ctx)`: called once per run with how it ended. See [Run callbacks](#run-callbacks) |
| `keepReadingAfterDisconnect` | `false` | Keep reading a run after the browser leaves, so `onRunEnd` gets its real outcome. See [Saving replies after a disconnect](#saving-replies-after-a-disconnect) |
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

## Run callbacks

`onEvent` and `onRunEnd` let the server see each run, for example to store a chat's history without trusting the browser to report it. Both get a `ctx` of `{ body, request }`: the validated `run` request body and the `Request` itself. It is the same object for every call in a run.

```ts
const seclai = createSeclaiHandlers({
  apiKey: process.env.SECLAI_API_KEY!,
  agentId: process.env.SECLAI_AGENT_ID!,
  async onRunEnd(outcome, { body }) {
    if (!body.sessionId) return;
    await db.messages.insert({
      sessionId: body.sessionId,
      role: "assistant",
      runId: outcome.runId,
      status: outcome.status,
      content: outcome.output,
      attachments: outcome.attachments,
      error: outcome.error,
    });
  },
});
```

**`onEvent(event, ctx)`** gets each event as `{ event, data }`, with `data` parsed from JSON, in order. Each call is awaited before its event is relayed. It also sees the `error` event the handler sends when the upstream connection fails. The one event it can miss is a first event the browser never received because it disconnected straight away; that event still counts toward the outcome.

**`onRunEnd(outcome, ctx)`** is called exactly once for each run that started streaming. It is awaited before the final `done`, `error` or `timeout` event is relayed, so **whatever it stores is in place by the time the browser sees `done`**, and the browser can reload history right away. For `done`, `onEvent` runs first, then `onRunEnd`, then the event is relayed.

| `outcome` field | |
|---|---|
| `runId` | From `init` or `done`. `null` if the stream ended before either |
| `status` | `completed`, `failed` or `cancelled` |
| `output` | The run's output when it completed. Otherwise the text streamed in `stream_token` events so far |
| `attachments` | Files from `done`, as `{ id, name, mime }`. Fetch them with `download` |
| `error` | Why the run failed, or `null` |

| The run stream... | `status` | `error` |
|---|---|---|
| Sends `done` | `completed`, or `failed` if the run failed | The last attempt's error |
| Sends `error`, or the upstream connection fails | `failed` | The event's `error` |
| Sends `timeout`: the API stopped streaming before the run ended | `failed` | `Stopped waiting for the run. It may still finish on Seclai.` |
| Ends with none of these | `failed` | `The stream ended without a result.` |
| Is cancelled by the browser | `cancelled`, unless `keepReadingAfterDisconnect` is on | `null` |

`cancelled` means the browser left. The run itself keeps going on Seclai. If the upstream connection fails or ends after the browser has left, that is reported as `cancelled` too, but an `error` or `timeout` event from the API is still `failed`. If the browser leaves while a callback is handling `done`, `error` or `timeout`, that event's outcome is reported.

When `runTimeoutMs` runs out, the stream gets an `error` event, `Timed out waiting for the agent run to finish.`, not `timeout`. The time spent awaiting your callbacks counts against `runTimeoutMs`.

If `onEvent` or `onRunEnd` throws or rejects, the handler logs the error with `console.error`, closes the upstream, and ends the stream with `event: error` carrying `{ "error": "The server could not process the run." }`, in place of the event it was handling. If `onRunEnd` hadn't been called yet, it is called once with `status: "failed"`, unless the browser had already disconnected, in which case the outcome is `cancelled` (with `keepReadingAfterDisconnect` on, it is `failed` either way). A throw during a cancel is only logged. A callback that never settles holds up the stream, and a cancel waits for a callback still running, so put a timeout on slow writes.

### Saving replies after a disconnect

By default, when the browser leaves (it closes the tab, navigates to another chat, or aborts the request), the handler stops reading the run and `onRunEnd` reports `cancelled` with the text streamed so far. The run itself still finishes on Seclai and is billed, and a chat agent's memory keeps its reply, so an app that saves replies ends up with a turn the agent remembers but the app never showed.

Set `keepReadingAfterDisconnect: true` to keep reading the run in the background instead:

```ts
const seclai = createSeclaiHandlers({
  apiKey, agentId,
  keepReadingAfterDisconnect: true,
  onRunEnd: (outcome, { body }) => db.saveReply(body.sessionId, outcome),
});
```

- **Callbacks.** The browser stops getting events, but `onEvent` still gets each one, and `onRunEnd` gets the run's real outcome with its output and files.
- **Outcomes.** A lost connection or a quiet end is reported as `failed`, since the browser leaving no longer stops the upstream, and `cancelled` doesn't occur. A callback that throws during the background reading is `failed` too.
- **Unread responses.** The handler also watches the request's signal, so it reads on even when the framework drops the response unread after the browser aborts. React Router does this when the browser leaves before the response starts.
- **Limits.** Reading the upstream stops at `runTimeoutMs` at the latest, and stops at once if a callback throws. A callback that never settles isn't bounded by it, so put a timeout on slow writes.
- **Show the reply when the user comes back.** For example, reload the conversation when it ends with a message that has no reply yet.
- **Serverless platforms** may freeze or end the function when the response closes, which cuts the background reading short. Use it on long-running servers, or check your platform's background-work support, such as `waitUntil`.

The option only takes effect with `onEvent` or `onRunEnd` set.

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

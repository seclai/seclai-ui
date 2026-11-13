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
| `logger` | None | `{ debug, info, warn, error }`, such as `console`: gets a line for each step of a run, upload and download. See [Logging](#logging) |

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

If `onEvent` or `onRunEnd` throws or rejects, the handler logs the error, with `logger.error` if you set a [`logger`](#logging) and `console.error` otherwise, closes the upstream, and ends the stream with `event: error` carrying `{ "error": "The server could not process the run." }`, in place of the event it was handling. If `onRunEnd` hadn't been called yet, it is called once with `status: "failed"`, unless the browser had already disconnected, in which case the outcome is `cancelled` (with `keepReadingAfterDisconnect` on, it is `failed` either way). A throw during a cancel is only logged. A callback that never settles holds up the stream, and a cancel waits for a callback still running, so put a timeout on slow writes.

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

## Logging

Pass a `logger` to see what the handlers saw: when the stream opened, which steps ran, when the first token arrived and how the run ended. Each method is called as `(message, fields)`, with short, stable messages and the ids, timings and counts in `fields`, so `console` works, and so do winston and consola. Without a `logger`, the handlers log nothing.

pino takes its arguments the other way round, `(fields, message)`, and would drop the fields, so wrap it:

```ts
const log = pino();
const logger = {
  debug: (m, f) => log.debug(f, m),
  info: (m, f) => log.info(f, m),
  warn: (m, f) => log.warn(f, m),
  error: (m, f) => log.error(f, m),
};
```

```ts
import { consoleLogger, createSeclaiHandlers } from "@seclai/handlers";

const seclai = createSeclaiHandlers({
  apiKey: process.env.SECLAI_API_KEY!,
  agentId: process.env.SECLAI_AGENT_ID!,
  logger: console,
  // Or drop the debug lines, and prefix each message with `[seclai]`:
  // logger: consoleLogger("info"),
});
```

A run with `logger: console` logs lines like these (debug lines left out, run ids shortened):

```
run starting { session_id: 'chat-42', uploads: 1, input_chars: 38 }
stream open { session_id: 'chat-42', ms: 412 }
run started { run_id: '3f2b8c1e-7a4d-4e9b-9c11-0d5e6f7a8b9c', session_id: 'chat-42' }
step { run_id: '3f2b8c1e-…', session_id: 'chat-42', step: 'Describe photo', message: 'started' }
first token { run_id: '3f2b8c1e-…', session_id: 'chat-42', ms: 2310 }
streaming { run_id: '3f2b8c1e-…', session_id: 'chat-42', tokens: 214, chars: 905, ms: 7318 }
run done { run_id: '3f2b8c1e-…', session_id: 'chat-42', status: 'completed', attachments: 2, tokens: 388, output_chars: 1622, ms: 11904 }
```

| Level | Lines |
|---|---|
| `info` | `run starting`, `stream open` (`ms` to the first event), `run started` (the `run_id` from `init`), `step` for each `step_progress` (once while the same step and message repeat), `first token`, `streaming` (every 5 seconds while tokens arrive), `run done`, `browser disconnected; the run continues on Seclai` (or, with `keepReadingAfterDisconnect`, `browser left; reading the rest of the run in the background`, and the run's end when it comes), `upload received`, `uploaded`, `download served` |
| `warn` | `run failed` (a `done` with status `failed`), `stream ended without a result`, and a warning when a completed run streamed no tokens |
| `error` | `run rejected` (the API refused the run up front, with `status`, `upstream_status` and the API's `error`), `stream error` (with the real `cause` when the connection failed), `run timed out`, `run failed: a callback threw`, `upload failed`, `download failed`, and callback errors from `onEvent` and `onRunEnd` |
| `debug` | Every event, each token (its length, not its text) and each keepalive |

The line for how a run ended (`run done`, `run failed`, `stream error`, `run timed out`) is logged after `onEvent` and `onRunEnd` have handled it, so it matches the outcome they reported. If one of them throws while the browser is still connected, `run failed: a callback threw` is logged in its place. After a disconnect, the line reflects the outcome `onRunEnd` received (usually `browser disconnected`).

A completed run with no tokens usually means the agent's result step is `display_result` rather than `streaming_result`: the reply then arrives all at once in `done`, which looks like broken streaming.

`run rejected` and the other error lines carry the upstream status and message, which matters when the browser only sees a 502 (for a bad API key, say).

The lines never include the API key, the input text, or file contents. A logger that throws is ignored, so it can't break a run or an upload, and logging doesn't change what the browser receives.

`consoleLogger(level?, target?)` returns a logger that writes from `level` up (`debug`, `info`, `warn`, `error` or `silent`; default `info`) to `target` (default `console`), prefixing each message with `[seclai]`. Pass your own logger as `target` to add a level threshold to it.

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

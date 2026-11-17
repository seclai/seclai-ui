// Type-level tests: checked by `tsc` (the package typecheck includes test/), not run by vitest.
import { createSeclaiHandlers, deny } from "../src";

// No context: hooks get `undefined`, and the plain handlers keep `(req) => Response`.
const plain = createSeclaiHandlers({ apiKey: "k", agentId: "a", authorizeRun: (_req, body) => body });
const nextRoute: (req: Request) => Promise<Response> = plain.handle;

// Inferred from `context`.
const inferred = createSeclaiHandlers({
  apiKey: "k",
  agentId: "a",
  context: async (req) => ({ userId: req.headers.get("x-user") ?? "" }),
  authorizeRun: (_req, _body, ctx) => {
    const id: string = ctx.userId;
    if (!id) throw deny(401, "Sign in.");
  },
  authorizeDownload: (_req, { runId }, { userId }) => runId.length > 0 && userId.length > 0,
});
inferred.withContext({ userId: "u1" }).handle;
// @ts-expect-error withContext needs the context's type.
inferred.withContext({ nope: 1 });

// Explicit, for withContext-only apps.
const explicit = createSeclaiHandlers<{ orgId: number }>({
  apiKey: "k",
  agentId: "a",
  authorizeUpload: (_req, file, { orgId }) => file.size < 1000 && orgId > 0,
});
explicit.withContext({ orgId: 1 });
// @ts-expect-error A typed context without a `context` option is only reachable through withContext.
explicit.handle;

// Inferred from an annotated hook, with no `context` option: same rule.
const annotated = createSeclaiHandlers({
  apiKey: "k",
  agentId: "a",
  authorizeRun: (_req, _body, ctx: { userId: string }) => ctx.userId.length > 0,
});
annotated.withContext({ userId: "u1" }).handle;
// @ts-expect-error
annotated.run;

// A context that may be undefined keeps the plain handlers.
const optional = createSeclaiHandlers<{ userId: string } | undefined>({
  apiKey: "k",
  agentId: "a",
  authorizeRun: (_req, _body, ctx) => ctx?.userId !== "banned",
});
optional.handle;
optional.withContext(undefined).handle;
void nextRoute;

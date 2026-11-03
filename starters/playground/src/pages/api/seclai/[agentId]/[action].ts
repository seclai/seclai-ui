import { createSeclaiHandlers, type SeclaiHandlers } from "@seclai/handlers";
import type { APIRoute } from "astro";
import { apiKey, cases } from "../../../../lib/cases";

export const prerender = false;

const ACTIONS: Record<string, keyof SeclaiHandlers> = {
  "attachment-references": "attachmentReferences",
  upload: "upload",
  run: "run",
  download: "download",
};

const handlersByAgent = new Map<string, SeclaiHandlers>();

function notFound(message: string) {
  return Response.json({ error: message, status: 404 }, { status: 404 });
}

export const ALL: APIRoute = ({ params, request }) => {
  const { agentId, action } = params;

  const handlerName = action ? ACTIONS[action] : undefined;
  if (!handlerName) return notFound("Unknown action.");

  // Only agents named in .env. The key can reach every agent on the account, so
  // the browser doesn't get to choose freely.
  if (!agentId || !cases.some((c) => c.agentId === agentId)) {
    return notFound("That agent isn't configured for this playground.");
  }
  if (!apiKey) {
    return Response.json({ error: "Set SECLAI_API_KEY in .env.", status: 500 }, { status: 500 });
  }

  let handlers = handlersByAgent.get(agentId);
  if (!handlers) {
    handlers = createSeclaiHandlers({ apiKey, agentId });
    handlersByAgent.set(agentId, handlers);
  }
  return handlers[handlerName](request);
};

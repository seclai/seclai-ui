import { useEffect, useState } from "react";
import { fetchAttachmentReferences, type AgentEndpoints } from "./endpoints";
import type { AcceptedAttachmentSlot } from "./types";

export interface AcceptedAttachments {
  /** `null` while loading. */
  slots: AcceptedAttachmentSlot[] | null;
  error: string | null;
}

/** Load the file slots the agent's trigger accepts. */
export function useAcceptedAttachments(endpoints: AgentEndpoints): AcceptedAttachments {
  const [state, setState] = useState<AcceptedAttachments>({ slots: null, error: null });

  useEffect(() => {
    const controller = new AbortController();
    setState({ slots: null, error: null });
    fetchAttachmentReferences(endpoints, { signal: controller.signal })
      .then((refs) => setState({ slots: refs.accepted_attachments ?? [], error: null }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          slots: null,
          error: err instanceof Error ? err.message : "Could not load this agent.",
        });
      });
    return () => controller.abort();
  }, [endpoints]);

  return state;
}

/** The `accept` attribute for a list of content types, or none to accept anything. */
export function acceptAttribute(contentTypes: string[] | undefined): string | undefined {
  return contentTypes?.length ? contentTypes.join(",") : undefined;
}

/**
 * Whether a file's type matches a list of content types such as `image/*` or
 * `application/pdf`. An empty type (the browser couldn't tell, as with HEIC on
 * Windows or `.md` files) passes, and the server decides.
 */
export function acceptsType(contentTypes: string[] | undefined, type: string): boolean {
  if (!contentTypes?.length || !type) return true;
  const [major] = type.toLowerCase().split("/");
  return contentTypes.some((pattern) => {
    const p = pattern.trim().toLowerCase();
    if (p === "*/*" || p === "*") return true;
    if (p.endsWith("/*")) return major === p.slice(0, -2);
    return p === type.toLowerCase();
  });
}

/**
 * What a chat message can carry, from all the agent's slots together. A run takes
 * one flat list of upload ids, so the chat can't fill slots separately.
 */
export interface MessageFileLimits {
  /** Most files per message, or `null` for no limit. */
  max: number | null;
  /** Accepted content types; empty accepts anything. */
  contentTypes: string[];
}

export function messageFileLimits(slots: AcceptedAttachmentSlot[]): MessageFileLimits {
  let max: number | null = 0;
  let anyType = false;
  const types = new Set<string>();
  for (const slot of slots) {
    max = max == null || slot.max == null ? null : max + slot.max;
    if (slot.content_types?.length) slot.content_types.forEach((t) => types.add(t));
    else anyType = true;
  }
  return { max, contentTypes: anyType ? [] : [...types] };
}

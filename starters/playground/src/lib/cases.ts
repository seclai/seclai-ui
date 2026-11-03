import type { AgentUiMode } from "@seclai/react";

export interface PlaygroundCase {
  key: string;
  label: string;
  hint: string;
  mode: AgentUiMode;
  agentId: string | null;
}

function env(name: string): string | undefined {
  return import.meta.env[name] || process.env[name] || undefined;
}

export const apiKey = env("SECLAI_API_KEY");

export const cases: PlaygroundCase[] = [
  {
    key: "text",
    label: "Text in, text out",
    hint: "Send text and expect text back.",
    mode: "form",
    agentId: env("SECLAI_AGENT_ID_TEXT") ?? null,
  },
  {
    key: "file",
    label: "File in",
    hint: "Attach a file. The file inputs come from the agent's accepted attachments.",
    mode: "form",
    agentId: env("SECLAI_AGENT_ID_FILE") ?? null,
  },
  {
    key: "image",
    label: "Image out",
    hint: "The image should show below the output, loaded through the download proxy.",
    mode: "form",
    agentId: env("SECLAI_AGENT_ID_IMAGE") ?? null,
  },
  {
    key: "chat",
    label: "Multi-turn chat",
    hint: "Ask a follow-up that relies on an earlier message.",
    mode: "chat",
    agentId: env("SECLAI_AGENT_ID_CHAT") ?? null,
  },
];

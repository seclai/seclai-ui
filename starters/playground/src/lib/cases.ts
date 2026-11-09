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

/** With no API key, every case runs on the sample responses in `demo.ts`. */
export const demoMode = !apiKey;

function agentId(key: string): string | null {
  if (demoMode) return `demo-${key}`;
  return env(`SECLAI_AGENT_ID_${key.toUpperCase()}`) ?? null;
}

export const cases: PlaygroundCase[] = [
  {
    key: "text",
    label: "Text in, text out",
    hint: "Send text and expect text back.",
    mode: "form",
    agentId: agentId("text"),
  },
  {
    key: "file",
    label: "File in",
    hint: "Attach a file. The file inputs come from the agent's accepted attachments.",
    mode: "form",
    agentId: agentId("file"),
  },
  {
    key: "image",
    label: "Image out",
    hint: "The image should show below the output, loaded through the download proxy.",
    mode: "form",
    agentId: agentId("image"),
  },
  {
    key: "chat",
    label: "Multi-turn chat",
    hint: "Ask a follow-up that relies on an earlier message.",
    mode: "chat",
    agentId: agentId("chat"),
  },
];

import { AgentChat } from "./AgentChat";
import { AgentRunForm } from "./AgentRunForm";
import type { AgentEndpointOptions, AgentUiMode } from "./types";

export interface SeclaiAgentProps extends AgentEndpointOptions {
  /** `form` for a one-shot run, `chat` for a multi-turn conversation. */
  mode: AgentUiMode;
}

/** Boots the agent UI from its mode, and its agent id when the server hosts several. */
export function SeclaiAgent({ mode, basePath, agentId }: SeclaiAgentProps) {
  return mode === "chat" ? (
    <AgentChat basePath={basePath} agentId={agentId} />
  ) : (
    <AgentRunForm basePath={basePath} agentId={agentId} />
  );
}

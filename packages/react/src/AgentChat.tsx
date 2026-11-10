import { useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { MarkdownContent } from "./placeholders/MarkdownContent";
import { MediaPreview } from "./placeholders/MediaPreview";
import type { AgentAttachment, AgentEndpointOptions } from "./types";
import { useAgentRun } from "./useAgentRun";

export interface AgentChatProps extends AgentEndpointOptions {
  /** Placeholder for the message box. */
  placeholder?: string;
}

interface ChatTurn {
  id: number;
  role: "user" | "assistant";
  text: string;
  attachments?: AgentAttachment[];
  error?: string | null;
  cancelled?: boolean;
}

function createSessionId(): string {
  // randomUUID only exists in secure contexts, so plain-http hosts need the fallback.
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function Turn({ turn }: { turn: ChatTurn }) {
  return (
    <li className={`seclai-turn seclai-turn-${turn.role}`}>
      {turn.text && <MarkdownContent content={turn.text} />}
      {turn.attachments?.map((attachment) => (
        <MediaPreview key={attachment.id} attachment={attachment} />
      ))}
      {turn.error && (
        <p className="seclai-error" role="alert">
          {turn.error}
        </p>
      )}
      {turn.cancelled && <p className="seclai-notice">Stopped.</p>}
    </li>
  );
}

/**
 * A multi-turn chat. Each message is its own run, and the agent ties them into a
 * conversation through the session id in the run's metadata.
 */
export function AgentChat({ basePath, agentId, placeholder = "Send a message" }: AgentChatProps) {
  const run = useAgentRun({ basePath, agentId });
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [message, setMessage] = useState("");
  const sessionId = useRef<string | null>(null);
  const nextTurnId = useRef(0);

  const running = run.status === "running";

  async function send() {
    const text = message.trim();
    if (!text || running) return;

    // Created on first send, not during render, so server and client markup match.
    sessionId.current ??= createSessionId();
    setMessage("");
    setTurns((prev) => [...prev, { id: nextTurnId.current++, role: "user", text }]);

    const result = await run.start({ input: text, sessionId: sessionId.current });

    setTurns((prev) => [
      ...prev,
      {
        id: nextTurnId.current++,
        role: "assistant",
        text: result.text,
        attachments: result.attachments,
        error: result.error,
        cancelled: result.status === "cancelled",
      },
    ]);
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void send();
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  }

  return (
    <div className="seclai-agent seclai-chat">
      <ul className="seclai-turns" aria-live="polite" aria-busy={running}>
        {turns.map((turn) => (
          <Turn key={turn.id} turn={turn} />
        ))}
        {running && (
          <li className="seclai-turn seclai-turn-assistant">
            {run.text ? (
              <MarkdownContent content={run.text} />
            ) : (
              <p className="seclai-notice">Thinking…</p>
            )}
          </li>
        )}
      </ul>

      <form className="seclai-form" onSubmit={onSubmit}>
        <textarea
          rows={2}
          aria-label="Message"
          placeholder={placeholder}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="seclai-actions">
          <button
            type="submit"
            className="seclai-button seclai-button-primary"
            disabled={running || !message.trim()}
          >
            Send
          </button>
          {running && (
            <button type="button" className="seclai-button" onClick={run.cancel}>
              Stop
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

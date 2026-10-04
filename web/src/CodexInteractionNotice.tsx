import { useState, type ReactNode } from "react";

/** Keep unavailable structured prompts explicit; terminal control is opt-in. */
export function CodexInteractionNotice({ children, disconnected, enabled, message }: {
  children: ReactNode;
  disconnected: boolean;
  enabled: boolean;
  message?: string;
}) {
  const [terminalOpen, setTerminalOpen] = useState(false);
  if (!enabled) return <>{children}</>;
  return (
    <div className="interaction">
      <div className="interaction-head">
        <span className="interaction-label">waiting for you</span>
        <span className="interaction-title">Codex interaction</span>
      </div>
      <p role="status">
        {disconnected
          ? "Connection unavailable. Reconnect to receive the pending question."
          : message ?? "Codex is waiting, but a structured question is not available. You can open terminal controls to inspect and answer the prompt."}
      </p>
      <button type="button" className="interaction-submit" aria-expanded={terminalOpen}
        onClick={() => setTerminalOpen((open) => !open)}>
        {terminalOpen ? "Hide terminal controls" : "Open terminal controls"}
      </button>
      {terminalOpen ? children : null}
    </div>
  );
}

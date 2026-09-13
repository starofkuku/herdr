import { useEffect, useMemo, useState } from "react";
import type { Subscription } from "./gateway";
import type { AgentView } from "./api";

/**
 * Content panel for one agent: its recent output plus a composer.
 *
 * The transcript is plain text from `pane.read`, so it uses native scrolling,
 * selection, and copy on every platform instead of an embedded terminal.
 */
export function AgentDetail({
  agent,
  onBack,
  client,
  onChanged,
}: {
  agent: AgentView | null;
  onBack: () => void;
  client: {
    call: <T>(method: string, params?: Record<string, unknown>) => Promise<T>;
    subscribe: (kinds: string[], onEvent: (payload: unknown) => void) => Subscription;
  };
  onChanged: () => void;
}) {
  const [text, setText] = useState("");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const paneId = agent?.paneId ?? null;

  const load = useMemo(
    () => async () => {
      if (!paneId) return;
      try {
        const envelope = await client.call<Record<string, unknown>>("pane.read", {
          pane_id: paneId,
          // The API serializes this enum as snake_case.
          source: "recent_unwrapped",
          format: "text",
          strip_ansi: true,
        });
        // The API nests the payload as `result.read`.
        const read = envelope.read as { text?: string } | undefined;
        setText(read?.text ?? "");
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [client, paneId],
  );

  // Initial load, then refresh whenever the pane produces output.
  useEffect(() => {
    void load();
    if (!paneId) return;
    const subscription = client.subscribe(["pane.output_changed"], () => {
      void load();
    });
    return () => subscription.close();
  }, [client, paneId, load]);

  const send = async () => {
    const message = draft.trim();
    if (!paneId || !message || busy) return;
    setBusy(true);
    try {
      // `text` plus an Enter key submits the message to the agent.
      await client.call("pane.send_input", {
        pane_id: paneId,
        text: message,
        keys: ["Enter"],
      });
      setDraft("");
      setError(null);
      onChanged();
      // Give the agent a moment to echo before re-reading.
      window.setTimeout(() => void load(), 250);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="detail-screen">
      <header className="topbar">
        <button type="button" className="ghost" onClick={onBack} aria-label="Back">
          ‹
        </button>
        <div className="topbar-title">
          <span className="title">{agent?.label ?? "agent"}</span>
          <span className="subtitle">{agent?.project ?? ""}</span>
        </div>
        <span className={`dot ${agent?.status ?? "unknown"}`} aria-hidden="true" />
      </header>

      {error ? <p className="error banner">{error}</p> : null}

      <div className="transcript">
        <pre>{text || "waiting for output…"}</pre>
      </div>

      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Send a message…"
          rows={1}
          onKeyDown={(event) => {
            // Enter sends, Shift+Enter inserts a newline.
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <button type="submit" disabled={busy || !draft.trim()} aria-label="Send">
          ↑
        </button>
      </form>
    </div>
  );
}

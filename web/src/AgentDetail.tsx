import { useCallback, useEffect, useRef, useState } from "react";
import type { Subscription } from "./gateway";
import { HISTORY_PAGE_LINES, shortenPath, statusLabel, type AgentView } from "./api";

/** Reads a page of the transcript. */
async function readPage(
  client: DetailClient,
  paneId: string,
  offset: number,
): Promise<string> {
  const envelope = await client.call<Record<string, unknown>>("pane.read", {
    pane_id: paneId,
    source: "recent_unwrapped",
    // Paging replaces the previous single large request: each page is bounded,
    // and the newest page is refreshed when output arrives.
    lines: HISTORY_PAGE_LINES,
    offset,
    format: "text",
    strip_ansi: true,
  });
  const read = envelope.read as { text?: string } | undefined;
  return read?.text ?? "";
}

/**
 * Number of rows in a page.
 *
 * `pane.read` returns one line per row, so counting newlines gives the page
 * size the offset must advance by.
 */
function countRows(text: string): number {
  if (!text) return 0;
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  return lines.length;
}

export interface DetailClient {
  call: <T>(method: string, params?: Record<string, unknown>) => Promise<T>;
  subscribe: (kinds: string[], onEvent: (payload: unknown) => void) => Subscription;
}

/**
 * Content panel for one agent: its recent output, older pages on demand, and a
 * composer.
 *
 * Output is plain text from `pane.read`, so it uses native scrolling,
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
  client: DetailClient;
  onChanged: () => void;
}) {
  // Oldest page first, so prepending older pages does not disturb scroll.
  const [pages, setPages] = useState<string[]>([]);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const paneId = agent?.paneId ?? null;
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const nextOffset = useRef(0);
  const pinnedToBottom = useRef(true);

  // `pane.updated` is chatty and fires while the pane sits idle, so coalesce
  // refreshes instead of re-reading page 0 on every event.
  const refreshTimer = useRef<number | null>(null);
  const inFlight = useRef(false);

  /** Replaces the newest page with fresh output. */
  const refreshNewest = useCallback(async () => {
    if (!paneId || inFlight.current) return;
    inFlight.current = true;
    try {
      const text = await readPage(client, paneId, 0);
      setPages((current) => {
        if (current.length === 0) return [text];
        // Only the newest page is replaced; older pages stay untouched so
        // paging state and scroll position remain valid.
        if (current[current.length - 1] === text) return current;
        return [...current.slice(0, -1), text];
      });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      inFlight.current = false;
    }
  }, [client, paneId]);

  /** Schedules a coalesced newest-page refresh. */
  const scheduleRefreshNewest = useCallback(() => {
    if (refreshTimer.current !== null) return;
    refreshTimer.current = window.setTimeout(() => {
      refreshTimer.current = null;
      void refreshNewest();
    }, 400);
  }, [refreshNewest]);

  /** Loads the page before the oldest one currently shown. */
  const loadOlder = useCallback(async () => {
    if (!paneId || loadingOlder || exhausted) return;
    setLoadingOlder(true);
    const container = transcriptRef.current;
    const previousHeight = container?.scrollHeight ?? 0;
    try {
      const text = await readPage(client, paneId, nextOffset.current);
      if (!text.trim()) {
        setExhausted(true);
      } else {
        // Advance by the rows actually returned, not the requested page size.
        // The final page is usually short, and advancing by the request size
        // would re-read rows that were already shown.
        const returned = countRows(text);
        if (returned === 0 || returned < HISTORY_PAGE_LINES) {
          setExhausted(true);
        }
        nextOffset.current += Math.max(returned, 1);
        setPages((current) => [text, ...current]);
        // Keep the viewport anchored on the content the user was reading.
        requestAnimationFrame(() => {
          const el = transcriptRef.current;
          if (el) el.scrollTop += el.scrollHeight - previousHeight;
        });
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingOlder(false);
    }
  }, [client, paneId, loadingOlder, exhausted]);

  // Initial load and reset when switching agents.
  useEffect(() => {
    setPages([]);
    setExhausted(false);
    setError(null);
    nextOffset.current = HISTORY_PAGE_LINES;
    pinnedToBottom.current = true;
    inFlight.current = false;
    void refreshNewest();
  }, [paneId, refreshNewest]);

  // Live updates: `pane.output_changed` is not a subscribable kind, so watch
  // `pane.updated`, which the server emits as the pane's output advances.
  useEffect(() => {
    if (!paneId) return;
    const subscription = client.subscribe(["pane.updated"], () => {
      scheduleRefreshNewest();
    });
    return () => {
      subscription.close();
      if (refreshTimer.current !== null) {
        window.clearTimeout(refreshTimer.current);
        refreshTimer.current = null;
      }
    };
  }, [client, paneId, scheduleRefreshNewest]);

  // Follow new output only while the user is already at the bottom.
  useEffect(() => {
    if (!pinnedToBottom.current) return;
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [pages]);

  const onScroll = () => {
    const el = transcriptRef.current;
    if (!el) return;
    pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    // Reaching the top pulls in the previous page.
    if (el.scrollTop < 60) void loadOlder();
  };

  const send = async () => {
    const message = draft.trim();
    if (!paneId || !message || busy) return;
    setBusy(true);
    try {
      await client.call("pane.send_input", { pane_id: paneId, text: message, keys: ["Enter"] });
      setDraft("");
      setError(null);
      pinnedToBottom.current = true;
      onChanged();
      window.setTimeout(() => void refreshNewest(), 250);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  // A page does not always end with a newline, so join explicitly. Without a
  // separator the last line of one page runs into the first line of the next.
  const transcript = pages
    .map((page) => (page.endsWith("\n") ? page : `${page}\n`))
    .join("");

  return (
    <div className="detail-screen">
      <header className="topbar">
        <button type="button" className="ghost" onClick={onBack} aria-label="Back">
          ‹
        </button>
        <div className="topbar-title">
          <span className="title">{agent?.label ?? "agent"}</span>
          <span className="subtitle">
            {agent?.project ?? ""} {agent?.cwd ? `· ${shortenPath(agent.cwd)}` : ""}
          </span>
        </div>
        <span className={`dot ${agent?.status ?? "unknown"}`} aria-label={statusLabel(agent?.status ?? "unknown")} />
      </header>

      {error ? <p className="error banner">{error}</p> : null}

      <div className="transcript" ref={transcriptRef} onScroll={onScroll}>
        {loadingOlder ? <p className="pager">loading earlier output…</p> : null}
        {exhausted && pages.length > 1 ? <p className="pager">start of history</p> : null}
        <pre>{transcript || "waiting for output…"}</pre>
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

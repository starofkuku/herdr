import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { DetailClient } from "./AgentDetail";
import {
  loadConversation,
  ConversationError,
  PAGE_BYTES,
  type Conversation,
  type ConversationTurn,
} from "./conversation";

/** Shortens a path for display. */
function shorten(path: string): string {
  const home = path.match(/^\/(?:home|Users)\/[^/]+/);
  return home ? path.replace(home[0], "~") : path;
}

/** Formats a duration in ms as a compact label. */
function duration(ms: number | undefined): string | null {
  if (!ms || ms <= 0) return null;
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}

/** Token count shown under a turn's metadata line. */
function tokens(value: number | undefined): string | null {
  if (!value) return null;
  if (value < 1000) return `${value} tok`;
  return `${(value / 1000).toFixed(1)}k tok`;
}

/** Timestamp label from a unix-seconds value. */
function clockTime(seconds: number | undefined): string | null {
  if (!seconds) return null;
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** The first line of a tool call, used as a collapsed summary. */
function toolSummary(name: string | undefined, args: unknown): string {
  const label = name || "tool";
  if (args && typeof args === "object") {
    const record = args as Record<string, unknown>;
    const subject =
      record.command ?? record.path ?? record.file_path ?? record.pattern ?? record.query;
    if (typeof subject === "string") return `${label}(${subject.slice(0, 68)})`;
  }
  return label;
}

function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}

function ToolCall({
  name,
  args,
  output,
}: {
  name?: string;
  args?: unknown;
  output?: string;
}) {
  const [open, setOpen] = useState(false);
  const input = args && typeof args === "object" ? JSON.stringify(args, null, 2) : String(args ?? "");
  return (
    <div className="tool-call">
      <button type="button" className="tool-head" onClick={() => setOpen((value) => !value)}>
        <span className="tool-caret">{open ? "▾" : "▸"}</span>
        <code>{toolSummary(name, args)}</code>
      </button>
      {open ? (
        <>
          <pre className="tool-body">{input}</pre>
          {output ? <pre className="tool-body result">{output}</pre> : null}
        </>
      ) : null}
    </div>
  );
}

function Turn({ turn }: { turn: ConversationTurn }) {
  const [showActivity, setShowActivity] = useState(false);
  const tools = turn.tool_calls ?? [];
  const messages = (turn.agent_messages ?? []).filter((message) => (message.text ?? "").trim());
  const meta = [clockTime(turn.started_at), duration(turn.duration_ms), turn.model].filter(
    Boolean,
  );

  return (
    <div className="turn">
      {turn.user_message ? (
        <div className="bubble user">
          <Markdown text={turn.user_message} />
        </div>
      ) : null}

      <div className={`bubble agent ${turn.status ?? ""}`}>
        <div className="bubble-head">
          <span className="agent-name">agent</span>
          {meta.length ? <span className="agent-meta">{meta.join(" · ")}</span> : null}
          {turn.status && turn.status !== "complete" ? (
            <span className={`turn-status ${turn.status}`}>{turn.status}</span>
          ) : null}
        </div>

        {messages.map((message, index) => (
          <div key={index} className={`agent-message ${message.is_reasoning ? "reasoning" : ""}`}>
            <Markdown text={message.text ?? ""} />
          </div>
        ))}

        {/* Reasoning is often present without a separate answer; show it last. */}
        {!messages.length && turn.final_answer ? (
          <div className="agent-message">
            <Markdown text={turn.final_answer} />
          </div>
        ) : null}

        {turn.error ? <div className="turn-error">{turn.error}</div> : null}
        {turn.aborted_reason ? <div className="turn-error">aborted: {turn.aborted_reason}</div> : null}

        {tools.length ? (
          <div className="activity">
            <button
              type="button"
              className="activity-toggle"
              onClick={() => setShowActivity((value) => !value)}
            >
              {showActivity ? "▾" : "▸"} {tools.length} tool {tools.length === 1 ? "call" : "calls"}
            </button>
            {showActivity
              ? tools.map((call, index) => (
                  <ToolCall
                    key={call.call_id ?? index}
                    name={call.name}
                    args={call.arguments}
                    output={call.output}
                  />
                ))
              : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Read-only conversation view for one agent.
 *
 * The transcript is parsed by the codex-trace backend rather than scraped from
 * the pane, so turns, tool calls, and token usage render as data instead of
 * terminal decoration. Writing still goes through the terminal pane, which
 * keeps the terminal the only writer.
 */
export function ConversationView({
  client,
  paneId,
  label,
}: {
  client: DetailClient;
  paneId: string;
  label: string;
}) {
  const [conversation, setConversation] = useState<Conversation | null>(null);
  /**
   * The newest page, replaced on every refresh.
   *
   * Kept separate from `older` so a refresh never has to reconcile against
   * history the reader has already paged in.
   */
  const [newest, setNewest] = useState<ConversationTurn[]>([]);
  /** Newest-first accumulation of pages fetched above the newest page. */
  const [older, setOlder] = useState<ConversationTurn[][]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const cursor = useRef<number | undefined>(undefined);
  // Scroll events fire faster than React re-renders, so the in-flight guard must
  // be a ref. With state, several handlers read `false` before the first update
  // lands, and each repeat request re-reads the same cursor and duplicates turns.
  const loadingOlderRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  /** Reloads the newest page. Older pages loaded so far are left untouched. */
  const refreshNewest = useCallback(async () => {
    try {
      const data = await loadConversation(client, paneId, { maxBytes: PAGE_BYTES });
      setConversation(data);
      setNewest(data.turns ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof ConversationError ? err.message : String(err));
    }
  }, [client, paneId]);

  // Load the newest page and reset paging state when the pane changes.
  useEffect(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);
    setConversation(null);
    setNewest([]);
    setOlder([]);
    cursor.current = undefined;
    loadingOlderRef.current = false;

    loadConversation(client, paneId, { maxBytes: PAGE_BYTES })
      .then((data) => {
        if (controller.signal.aborted) return;
        setConversation(data);
        setNewest(data.turns ?? []);
        cursor.current = data.pagination?.next_cursor;
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof ConversationError ? err.message : String(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [client, paneId]);

  // Follow the agent while it works. `pane.updated` fires often, so coalesce
  // and ignore events that arrive while a previous read is still running.
  useEffect(() => {
    let timer: number | null = null;
    let inFlight = false;
    const subscription = client.subscribe(["pane.updated"], () => {
      if (timer !== null) return;
      timer = window.setTimeout(() => {
        timer = null;
        if (inFlight) return;
        inFlight = true;
        void refreshNewest().finally(() => {
          inFlight = false;
        });
      }, 500);
    });
    return () => {
      subscription.close();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [client, refreshNewest]);

  const hasMore = conversation?.pagination?.has_more ?? false;

  /** Loads the page before the oldest turn currently shown. */
  const loadOlder = useCallback(async () => {
    if (loadingOlderRef.current || !hasMore || cursor.current === undefined) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    const requestCursor = cursor.current;
    const container = scrollRef.current;
    const previousHeight = container?.scrollHeight ?? 0;
    try {
      const data = await loadConversation(client, paneId, {
        maxBytes: PAGE_BYTES,
        cursor: requestCursor,
      });
      const older_page = data.turns ?? [];
      cursor.current = data.pagination?.next_cursor;
      setConversation((current) => (current ? { ...current, pagination: data.pagination } : data));
      if (older_page.length) {
        setOlder((current) => [older_page, ...current]);
        // Older turns are prepended, so anchor the viewport on the content that
        // was already on screen.
        requestAnimationFrame(() => {
          const element = scrollRef.current;
          if (element) element.scrollTop += element.scrollHeight - previousHeight;
        });
      }
    } catch (err) {
      setError(err instanceof ConversationError ? err.message : String(err));
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  }, [client, paneId, hasMore]);

  const onScroll = () => {
    const element = scrollRef.current;
    if (element && element.scrollTop < 80) void loadOlder();
  };

  const totalTokens = conversation?.totalTokens;
  const turns: ConversationTurn[] = [...older.flat(), ...newest];

  return (
    <div className="conversation" ref={scrollRef} onScroll={onScroll}>
      <div className="conversation-bar">
        <span className="conversation-title">{label}</span>
        {conversation?.provider ? (
          <span className="conversation-provider">{conversation.provider}</span>
        ) : null}
        <span className="conversation-meta">
          {turns.length}
          {conversation?.pagination?.total_turns
            ? `/${conversation.pagination.total_turns}`
            : ""}{" "}
          turns
          {tokens(totalTokens) ? ` · ${tokens(totalTokens)}` : ""}
        </span>
      </div>

      {conversation?.cwd ? <p className="conversation-cwd">{shorten(conversation.cwd)}</p> : null}

      {loadingOlder ? <p className="pager">loading earlier turns…</p> : null}
      {!hasMore && turns.length > 1 && !loading ? (
        <p className="pager">start of conversation</p>
      ) : null}

      {loading ? <p className="pager">loading conversation…</p> : null}

      {error ? (
        <div className="conversation-error">
          <p className="error">{error}</p>
          <p className="hint">
            The transcript is read from the agent's own session log, so it is only available when the
            agent reports a path. Agents that report a session id instead have no transcript to
            show; use the terminal tab for those.
          </p>
        </div>
      ) : null}

      {!loading && !error && turns.length === 0 ? (
        <p className="pager">no turns recorded yet</p>
      ) : null}

      <div className="turns">
        {turns.map((turn, index) => (
          <Turn key={turn.turn_id ?? index} turn={turn} />
        ))}
      </div>
    </div>
  );
}

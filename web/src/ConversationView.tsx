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

/**
 * The "agent is responding" indicator.
 *
 * Three dots that pulse in sequence. Shown while a turn is still being written,
 * so a running agent is visibly alive rather than looking like a stalled reply.
 */
function Responding() {
  return (
    <div className="responding" role="status" aria-label="agent is responding">
      <span className="responding-dot" aria-hidden="true" />
      <span className="responding-dot" aria-hidden="true" />
      <span className="responding-dot" aria-hidden="true" />
    </div>
  );
}

/**
 * A message this client sent that the transcript has not recorded yet.
 *
 * Rendered in the same shape as a real turn so the layout does not shift when
 * the agent's own copy arrives and replaces it.
 */
function PendingTurn({ message }: { message: string }) {
  return (
    <div className="turn pending">
      <div className="bubble user">
        <Markdown text={message} />
      </div>
      <div className="bubble agent ongoing">
        <div className="bubble-head">
          <span className="agent-name">agent</span>
        </div>
        <Responding />
      </div>
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

        {/* The parser marks the in-progress turn `ongoing`, so this is real
            state off the transcript rather than a guess from the send. */}
        {turn.status === "ongoing" ? <Responding /> : null}

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
  sentMessage,
}: {
  client: DetailClient;
  paneId: string;
  label: string;
  /**
   * Message this client just sent, until the agent's own transcript records it.
   *
   * The transcript is written by the agent, so a freshly sent message is not in
   * it yet. Without this the composer looks like it dropped the text: nothing
   * appears until the agent starts writing the turn.
   */
  sentMessage?: string | null;
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
  /**
   * Whether the view should follow new turns.
   *
   * True while the reader is at the bottom, false once they scroll up to read
   * back. New output must not yank the viewport away from history they are
   * reading, so this is only recomputed from the user's own scrolling.
   */
  const pinnedToBottom = useRef(true);
  /**
   * Newest turn id at the moment a message was sent.
   *
   * The optimistic echo is dropped once the transcript moves past this point.
   * Matching the sent text alone is not enough: providers normalise the user
   * message (Codex wraps it with environment context), so the recorded text may
   * legitimately differ from what was typed.
   */
  const echoBaseline = useRef<string | null>(null);
  /**
   * Previous `sentMessage`, used to detect a new send during render.
   *
   * Captured here rather than in an effect: an effect runs after commit, by
   * which time the transcript may already have refreshed and the baseline would
   * point at the agent's own new turn, disabling the echo prematurely.
   */
  const sawSentMessage = useRef<string | null>(null);

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
    // A different pane is a different conversation, so following starts over
    // from the bottom. Carrying the previous pane's scroll-up state across
    // would leave the new conversation unfollowed until the reader scrolled.
    pinnedToBottom.current = true;

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
    if (!element) return;
    // Distance from the bottom, tolerant of sub-pixel rounding and of the
    // scrollbar itself so sitting at the end still counts as pinned.
    pinnedToBottom.current =
      element.scrollHeight - element.scrollTop - element.clientHeight < 40;
    // Reaching the top pulls in the previous page.
    if (element.scrollTop < 80) void loadOlder();
  };

  /**
   * Keeps the newest turn in view as content arrives.
   *
   * Depends on the turn arrays rather than their length: an agent streaming a
   * reply grows the last turn without adding one, and that should follow too.
   * Runs after layout so `scrollHeight` reflects what was just rendered.
   */
  useEffect(() => {
    if (!pinnedToBottom.current) return;
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, [newest, older, sentMessage]);

  const totalTokens = conversation?.totalTokens;
  const turns: ConversationTurn[] = [...older.flat(), ...newest];

  const newestTurn = newest[newest.length - 1];
  const newestTurnId = newestTurn?.turn_id ?? null;

  // Record the transcript position the send started from, during render, so it
  // reflects the state before this send's refresh can land.
  if (sentMessage == null) {
    echoBaseline.current = null;
  } else if (sawSentMessage.current !== sentMessage) {
    echoBaseline.current = newestTurnId ?? "";
  }
  sawSentMessage.current = sentMessage ?? null;

  // The transcript is the agent's own record, so it only contains the message
  // once the agent has written it. Show it optimistically in the meantime, and
  // drop it as soon as the real turn arrives so nothing is duplicated.
  const echoed =
    sentMessage != null &&
    sentMessage.length > 0 &&
    (newestTurn?.user_message === sentMessage ||
      (echoBaseline.current !== null &&
        newestTurnId !== null &&
        newestTurnId !== echoBaseline.current));
  const pending = sentMessage != null && sentMessage.length > 0 && !echoed;
  const shownTurns = turns.length + (pending ? 1 : 0);

  return (
    <div className="conversation" ref={scrollRef} onScroll={onScroll}>
      <div className="conversation-bar">
        <span className="conversation-title">{label}</span>
        {conversation?.provider ? (
          <span className="conversation-provider">{conversation.provider}</span>
        ) : null}
        <span className="conversation-meta">
          {shownTurns}
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
            agent reports a path. Agents that report a session id instead have none to show.
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
        {pending ? <PendingTurn message={sentMessage ?? ""} /> : null}
      </div>
    </div>
  );
}

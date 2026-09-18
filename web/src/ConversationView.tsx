import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { DetailClient } from "./AgentDetail";
import { LIVE_POLL_MS, paneIdOfEvent } from "./api";
import {
  POINTER_PITCH,
  TOUCH_PITCH,
  navigatorLayout,
  tickPositionAt,
} from "./navigator";
import { useActiveTurn } from "./useActiveTurn";
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

/**
 * True when the primary input cannot hover.
 *
 * Drives both the rail's tick size and whether a tick reveals its label on
 * hover: a touch device has no hover state, so a hover-only label is
 * unreachable there and the tick must be big enough to tap instead.
 */
function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(
    () => window.matchMedia?.("(hover: none), (pointer: coarse)").matches ?? false,
  );
  useEffect(() => {
    const query = window.matchMedia?.("(hover: none), (pointer: coarse)");
    if (!query) return;
    const update = () => setCoarse(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return coarse;
}

/**
 * The quick-jump rail beside the transcript.
 *
 * One tick per user message, in order. Hovering (or focusing) a tick shows what
 * was asked; clicking scrolls that turn to the top of the transcript. The tick
 * for the turn the reader is currently at is highlighted, so the rail doubles as
 * a position indicator.
 *
 * On a coarse pointer the labels are dropped rather than made hover-only — there
 * is no hover to reveal them — and the ticks grow to a tappable size.
 *
 * A finger also gets a scrub gesture: pressing and sliding along the rail
 * previews the messages it passes and jumps on release. A single tick is a small
 * target on a phone, and once a long session is sampled one tick stands for
 * several messages, so tapping precisely is not realistic. Sliding makes the
 * whole rail one control.
 */
function TurnNavigator({
  turns,
  activeTurn,
  onJump,
}: {
  turns: ConversationTurn[];
  activeTurn: number | null;
  onJump: (index: number) => void;
}) {
  const railRef = useRef<HTMLElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [railHeight, setRailHeight] = useState(0);
  const coarse = useCoarsePointer();
  /** The tick the finger is over while scrubbing, if any. */
  const [scrubPosition, setScrubPosition] = useState<number | null>(null);
  /**
   * Removes the in-flight scrub listeners.
   *
   * They live on the window so a slide that leaves the narrow rail keeps
   * tracking. That also means they outlive the element, so they are torn down on
   * unmount as well as on release: leaving the view with a finger down would
   * otherwise leave a listener attached to the window for the rest of the
   * session.
   */
  const scrubCleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => scrubCleanup.current?.(), []);
  /**
   * Whether there is anything to navigate.
   *
   * The rail renders nothing without anchors, so the measuring effect below has
   * to depend on this: on the first pass (turns not loaded yet) there is no
   * element to measure, and with an empty dependency list the observer would
   * never attach once the rail did appear. The rail would then keep the fallback
   * height, which decides a different tick count and silently samples turns
   * away.
   */
  const hasAnchors = turns.some((turn) => (turn.user_message ?? "").trim().length > 0);

  // The rail's own height sets how many ticks fit, so it is measured rather than
  // assumed: the same component sits in a short phone viewport and a tall desktop
  // panel.
  useEffect(() => {
    if (!hasAnchors) return;
    const element = railRef.current;
    if (!element) return;
    const measure = () => setRailHeight(element.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasAnchors]);

  // Only turns with a user message are worth navigating to; an agent-only turn
  // (a continuation) has nothing to identify it by.
  const anchors = turns
    .map((turn, index) => ({ turn, index }))
    .filter(({ turn }) => (turn.user_message ?? "").trim().length > 0);

  // The reader is inside the answer to some question, so the tick to mark is the
  // last question at or before the active turn. Declared before the early return
  // below so the hook set stays unconditional.
  const anchorIndex = (() => {
    if (anchors.length === 0) return 0;
    if (activeTurn === null) return anchors[0].index;
    let found = anchors[0].index;
    for (const { index } of anchors) {
      if (index <= activeTurn) found = index;
      else break;
    }
    return found;
  })();

  const position = anchors.findIndex(({ index }) => index === anchorIndex);
  const layout = navigatorLayout(
    anchors.length,
    railHeight || undefined,
    position >= 0 ? position : undefined,
    coarse ? TOUCH_PITCH : POINTER_PITCH,
  );

  /**
   * Maps a client Y coordinate to a rendered tick position.
   *
   * Measured against the tick block rather than the rail, because the block is
   * centred and the rail carries padding on both sides.
   */
  const positionAtClientY = (clientY: number): number | undefined => {
    const block = listRef.current;
    if (!block) return undefined;
    return tickPositionAt(clientY - block.getBoundingClientRect().top, layout.pitch, layout.indices.length);
  };

  /**
   * Starts a scrub and keeps it running until the finger lifts.
   *
   * The move and end listeners are on the window rather than the rail so sliding
   * past the edge — which is easy to do on a narrow phone rail — keeps tracking
   * instead of stranding the gesture.
   */
  const onPointerDown = (event: React.PointerEvent) => {
    if (event.pointerType === "mouse") return;
    const position = positionAtClientY(event.clientY);
    if (position === undefined) return;
    // Keeps the browser from also panning the transcript under the finger, which
    // would otherwise scroll while the reader is choosing a destination.
    event.preventDefault();
    setScrubPosition(position);

    // A previous gesture that never saw its release must not stack listeners.
    scrubCleanup.current?.();

    const move = (moveEvent: PointerEvent) => {
      const next = positionAtClientY(moveEvent.clientY);
      if (next !== undefined) setScrubPosition(next);
    };
    const finish = (upEvent: PointerEvent) => {
      scrubCleanup.current?.();
      const target = positionAtClientY(upEvent.clientY);
      setScrubPosition(null);
      if (target !== undefined) {
        const anchor = anchors[layout.indices[target]];
        if (anchor) onJump(anchor.index);
      }
    };
    scrubCleanup.current = () => {
      scrubCleanup.current = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  };

  if (anchors.length === 0) return null;

  // The scrub preview follows the finger, so its offset is the centre of the tick
  // being passed rather than the pointer's own position.
  const scrubAnchor = scrubPosition === null ? undefined : anchors[layout.indices[scrubPosition]];
  const scrubOffsetY =
    scrubPosition === null
      ? 0
      : railHeight / 2 -
        (layout.indices.length * layout.pitch) / 2 +
        scrubPosition * layout.pitch +
        layout.pitch / 2;

  return (
    <nav
      ref={railRef}
      className={`turn-nav${coarse ? " turn-nav--coarse" : ""}${
        scrubPosition !== null ? " turn-nav--scrubbing" : ""
      }`}
      aria-label="Jump to a message"
      style={{ "--tick-pitch": `${layout.pitch}px` } as React.CSSProperties}
    >
      {scrubAnchor ? (
        <ScrubLabel
          text={(scrubAnchor.turn.user_message ?? "").trim()}
          offsetY={scrubOffsetY}
        />
      ) : null}
      <div className="turn-nav__list" ref={listRef} onPointerDown={onPointerDown}>
        {layout.indices.map((position) => {
          const { turn, index } = anchors[position];
          const label = (turn.user_message ?? "").trim();
          const selected = scrubPosition === null ? index === anchorIndex : position === scrubPosition;
          return (
            <button
              key={turn.turn_id ?? index}
              type="button"
              className={`turn-nav__tick${selected ? " turn-nav__tick--active" : ""}`}
              aria-label={`Jump to: ${label.slice(0, 80)}`}
              aria-current={index === anchorIndex ? "true" : undefined}
              onClick={() => onJump(index)}
            >
              <span className="turn-nav__bar" />
              {/* Not rendered on touch: a hover-only label can never appear
                  there, and showing it persistently would cover the text. */}
              {coarse ? null : <span className="turn-nav__label">{label}</span>}
            </button>
          );
        })}
      </div>
    </nav>
  );
}

/**
 * The message the finger is currently over while scrubbing.
 *
 * A touch scrub has no hover, so without this the reader would slide blind and
 * only see where they landed. It floats beside the rail and follows the tick
 * under the finger.
 */
function ScrubLabel({ text, offsetY }: { text: string; offsetY: number }) {
  return (
    <div className="turn-nav__scrub-label" style={{ top: `${offsetY}px` }} role="status">
      {text}
    </div>
  );
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

function Turn({ turn, index }: { turn: ConversationTurn; index?: number }) {
  const [showActivity, setShowActivity] = useState(false);
  // Reasoning is thinking out loud, not the answer. It is the bulk of a turn's
  // text for an agent that explains itself, so it starts collapsed; the answer
  // and any errors stay visible.
  const [showReasoning, setShowReasoning] = useState(false);
  const tools = turn.tool_calls ?? [];
  const allMessages = (turn.agent_messages ?? []).filter((message) => (message.text ?? "").trim());
  const messages = allMessages.filter((message) => !message.is_reasoning);
  const reasoning = allMessages.filter((message) => message.is_reasoning);
  // A turn can be reasoning only; if so there is nothing else to show and
  // collapsing it would hide the whole turn.
  const hasAnswer = messages.length > 0 || (turn.final_answer ?? "").trim().length > 0;
  const meta = [clockTime(turn.started_at), duration(turn.duration_ms), turn.model].filter(
    Boolean,
  );

  return (
    <div className="turn" data-turn-index={index}>
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

        {reasoning.length && hasAnswer ? (
          <div className="activity reasoning-group">
            <button
              type="button"
              className="activity-toggle"
              aria-expanded={showReasoning}
              onClick={() => setShowReasoning((value) => !value)}
            >
              {showReasoning ? "▾" : "▸"} thinking
            </button>
            {showReasoning
              ? reasoning.map((message, index) => (
                  <div key={index} className="agent-message reasoning">
                    <Markdown text={message.text ?? ""} />
                  </div>
                ))
              : null}
          </div>
        ) : null}

        {(!hasAnswer ? allMessages : messages).map((message, index) => (
          <div key={index} className={`agent-message ${message.is_reasoning ? "reasoning" : ""}`}>
            <Markdown text={message.text ?? ""} />
          </div>
        ))}

        {/* A turn can carry only reasoning; then the answer preview is all there
            is to show and it must not be hidden behind the reasoning toggle. */}
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
  working = false,
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
  /** Whether the agent is reported working, which turns on live polling. */
  working?: boolean;
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
  /** Guards `refreshNewest` against overlapping reads. */
  const refreshInFlight = useRef(false);
  /** Set when a refresh is requested while one is already running. */
  const refreshAgain = useRef(false);
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

  /**
   * Reloads the newest page. Older pages loaded so far are left untouched.
   *
   * Polling and the event path can both request a refresh, and a read can be in
   * flight when the next request arrives. Rather than run them concurrently, a
   * request that arrives mid-read is remembered and re-run once, so an update is
   * never dropped and no two reads race to set the newest page.
   */
  const refreshNewest = useCallback(async (): Promise<void> => {
    if (refreshInFlight.current) {
      refreshAgain.current = true;
      return;
    }
    refreshInFlight.current = true;
    try {
      const data = await loadConversation(client, paneId, { maxBytes: PAGE_BYTES });
      setConversation(data);
      setNewest(data.turns ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof ConversationError ? err.message : String(err));
    } finally {
      refreshInFlight.current = false;
      if (refreshAgain.current) {
        refreshAgain.current = false;
        void refreshNewest();
      }
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
    refreshInFlight.current = false;
    refreshAgain.current = false;
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

  // Keep the transcript current while the agent works.
  //
  // `pane.updated` is not an output signal: the server emits it for terminal
  // title, metadata, and diagnostic changes, and not when a pane's scrollback
  // grows. A TUI agent writing its answer emits nothing at all, so an
  // event-only view freezes mid-turn. A poll runs while the pane is reported
  // working, which is exactly when the transcript changes without events.
  //
  // The event path is still useful: it refreshes promptly on the state and
  // title changes that do emit, and it is filtered to this pane because the
  // subscription delivers every pane's updates.
  useEffect(() => {
    let timer: number | null = null;
    const refresh = () => {
      if (timer !== null) return;
      timer = window.setTimeout(() => {
        timer = null;
        void refreshNewest();
      }, 500);
    };
    const subscription = client.subscribe(["pane.updated"], (payload) => {
      const eventPane = paneIdOfEvent(payload);
      if (eventPane !== undefined && eventPane !== paneId) return;
      refresh();
    });
    return () => {
      subscription.close();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [client, paneId, refreshNewest]);

  // Poll while the agent is reported working. The status comes from the pane,
  // so it covers a turn this client did not start.
  useEffect(() => {
    if (!working) return;
    const id = window.setInterval(() => void refreshNewest(), LIVE_POLL_MS);
    return () => window.clearInterval(id);
  }, [working, refreshNewest]);

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

  const activeTurn = useActiveTurn(scrollRef, turns.length);

  /**
   * Brings a turn to the top of the transcript.
   *
   * The rail is only useful if the reader can land on the turn they picked, so
   * this scrolls the container directly rather than using `scrollIntoView`: that
   * would scroll the whole page on a small screen, moving the header and
   * composer out of the way. The turn's offset is measured against the container
   * so it parks just below the top edge, respecting `scroll-margin-top`.
   */
  const jumpToTurn = useCallback((index: number) => {
    const container = scrollRef.current;
    const element = container?.querySelector<HTMLElement>(`[data-turn-index="${index}"]`);
    if (!container || !element) return;
    const margin = Number.parseFloat(getComputedStyle(element).scrollMarginTop) || 0;
    const top =
      element.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
    container.scrollTo({ top: Math.max(0, top - margin), behavior: "smooth" });
  }, []);

  return (
    <div className="conversation-wrap">
      {/* The rail is a sibling of the scroll container rather than a child, so it
          stays put while the transcript moves under it. */}
      <TurnNavigator turns={turns} activeTurn={activeTurn} onJump={jumpToTurn} />
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
            <Turn key={turn.turn_id ?? index} turn={turn} index={index} />
          ))}
          {pending ? <PendingTurn message={sentMessage ?? ""} /> : null}
        </div>
      </div>
    </div>
  );
}

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowDown, ChevronRight } from "lucide-react";
import type { DetailClient } from "./AgentDetail";
import { useConversationRefresh } from "./useConversationRefresh";
import { createConversationReader } from "./conversationReader";
import { CopyButton, Markdown } from "./Markdown";
import {
  editDiffLines,
  isEditVisual,
  isReadVisual,
  isTerminalVisual,
  ReasoningVisual,
  toolChangeStats,
  toolOperationLabel,
  toolVisual,
} from "./toolView";
import { fileIconDataUri, looksLikeFilePath, splitFilePath } from "./fileIcons";
import {
  NAVIGATOR_DIM_DELAY_MS,
  POINTER_PITCH,
  TOUCH_PITCH,
  navigatorLayout,
  tickPositionAt,
} from "./navigator";
import { splitMessage } from "./attachments";
import { activity, runsByTurn, type SubagentRun } from "./subagents";
import { useActiveTurn } from "./useActiveTurn";
import {
  interleaveTurn,
  lastReasoningLine,
  loadConversation,
  reasoningDurationSeconds,
  ConversationError,
  PAGE_BYTES,
  type Conversation,
  type ConversationMessage,
  type ConversationToolCall,
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

/** A duration in the words the work rows use: 35 秒, 1 分 35 秒. */
function chineseDuration(ms: number | undefined): string | null {
  if (!ms || ms <= 0) return null;
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest > 0 ? `${minutes} 分 ${rest} 秒` : `${minutes} 分`;
}

/**
 * The assistant's side of an exchange, for the navigator's hover card.
 *
 * The final answer when the transcript recorded one, else the last thing the
 * agent said outside its thinking, else a status word — ZCode shows the same
 * pair of previews (question over answer) on its own rail.
 */
function assistantPreviewOf(turn: ConversationTurn): string {
  const answer = (turn.final_answer ?? "").trim();
  if (answer) return answer;
  const messages = turn.agent_messages ?? [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.is_reasoning) continue;
    const text = (message.text ?? "").trim();
    if (text) return text;
  }
  return turn.status === "ongoing" ? "正在回复…" : "暂无回复内容";
}

/**
 * The command, path, or query a tool call acted on.
 *
 * ZCode shows this text on its own — the tool name is the row's label, not a
 * wrapper around the subject — so a shell call reads as its command rather than
 * as `exec_command(...)`. A shell array (`["bash", "-lc", "…"]`) is unwrapped to
 * the command it carries.
 */
function toolSubject(name: string | undefined, args: unknown): string {
  if (args && typeof args === "object") {
    const record = args as Record<string, unknown>;
    const raw =
      record.command ?? record.cmd ?? record.path ?? record.file_path ?? record.pattern ?? record.query;
    if (typeof raw === "string" && raw.trim()) return raw.trim();
    if (Array.isArray(raw)) {
      const parts = raw.filter((part): part is string => typeof part === "string");
      const shellIndex = parts.findIndex((part) => part === "-lc");
      const command = shellIndex >= 0 ? parts[shellIndex + 1] : parts.join(" ");
      if (command) return command;
    }
  }
  return name ?? "tool";
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
  dimmed,
  onWake,
}: {
  turns: ConversationTurn[];
  activeTurn: number | null;
  onJump: (index: number) => void;
  /**
   * Faded to a hint while the reader is not using it.
   *
   * The rail floats over the transcript, so at full strength it would cover the
   * start of every line. Dimmed it stays visible as a position hint while the
   * text underneath stays readable; touching it or scrolling restores it.
   */
  dimmed: boolean;
  /** Called when the reader interacts, so the rail can be restored. */
  onWake: () => void;
  /**
   * The session's live state, floating over the conversation's top right.
   * Rendered by the screen because the data is polled there.
   */
  status?: ReactNode;
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
    onWake();
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
      }${dimmed ? " turn-nav--dimmed" : ""}`}
      aria-label="Jump to a message"
      style={{ "--tick-pitch": `${layout.pitch}px` } as React.CSSProperties}
      onMouseEnter={onWake}
      onFocus={onWake}
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
              onClick={() => {
                onWake();
                onJump(index);
              }}
            >
              <span className="turn-nav__bar" />
              {/* Not rendered on touch: a hover-only label can never appear
                  there, and showing it persistently would cover the text. */}
              {coarse ? null : (
                <span className="turn-nav__label" role="tooltip">
                  <span className="turn-nav__card-user">{label}</span>
                  <span className="turn-nav__card-agent">{assistantPreviewOf(turn)}</span>
                </span>
              )}
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

/**
 * A message's text, with any uploaded images shown as previews.
 *
 * The reference the server writes into the message (`@<path>`) is addressed at
 * an agent reading the file, so on its own it renders as a raw path. A preview
 * is what makes the message readable, and tapping one opens the same lightbox
 * the composer's own attachments use. A message without a previewable upload
 * takes the plain markdown path untouched, so nothing else changes.
 */
function MessageBody({
  text,
  onPreviewImage,
}: {
  text: string;
  onPreviewImage?: (url: string) => void;
}) {
  const parts = splitMessage(text);
  // Nothing to preview: render the original so ordinary messages are byte for
  // byte what they were before.
  if (parts.every((part) => part.kind === "text")) {
    return <Markdown text={text} />;
  }

  return (
    <>
      {parts.map((part, index) =>
        part.kind === "image" ? (
          <button
            key={index}
            type="button"
            className="message-image"
            aria-label={`Preview ${part.attachment.name}`}
            title="Tap to enlarge"
            onClick={() => onPreviewImage?.(part.attachment.url)}
          >
            <img src={part.attachment.url} alt="" loading="lazy" />
          </button>
        ) : part.text.trim() ? (
          // The prose that surrounded the reference. Whitespace-only runs are
          // dropped rather than rendered as an empty block, which would leave a
          // gap where the path used to be.
          <Markdown key={index} text={part.text} />
        ) : null,
      )}
    </>
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
function PendingTurn({
  message,
  onPreviewImage,
}: {
  message: string;
  onPreviewImage?: (url: string) => void;
}) {
  return (
    <div className="turn pending">
      <div className="bubble user">
        <MessageBody text={message} onPreviewImage={onPreviewImage} />
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

/**
 * The expanded payload of a tool call.
 *
 * Each tool's payload renders in the shape the tool produced, the way ZCode
 * renders its own: an edit reads as a diff (tinted rows, one per changed
 * line), a command or a read reads as its output, and only calls with no
 * better shape fall back to the raw JSON the transcript recorded.
 */
function ToolDetail({ call }: { call: ConversationToolCall }) {
  const visual = toolVisual(call.kind, call.name);
  if (isEditVisual(visual)) {
    const diff = editDiffLines(call);
    if (diff) {
      return (
        <div className="diff">
          {diff.lines.map((line, index) => (
            <div key={index} className={`diff-line ${line.kind}`}>
              <span className="diff-sign" aria-hidden="true">
                {line.kind === "add" ? "+" : line.kind === "remove" ? "-" : line.kind === "meta" ? "" : " "}
              </span>
              <span className="diff-text">{line.text}</span>
            </div>
          ))}
          {diff.omitted > 0 ? (
            <div className="diff-line meta">
              <span className="diff-sign" aria-hidden="true" />
              <span className="diff-text">……（还有 {diff.omitted} 行未显示）</span>
            </div>
          ) : null}
        </div>
      );
    }
  }
  const output = (call.output ?? "").replace(/\s+$/u, "");
  if ((isTerminalVisual(visual) || isReadVisual(visual)) && output) {
    // The command or the query is already the row's summary; the detail is
    // what came back from it.
    return <pre className="tool-body result">{output}</pre>;
  }
  const args = call.arguments;
  const raw =
    call.input ??
    (args && typeof args === "object" ? JSON.stringify(args, null, 2) : String(args ?? ""));
  return (
    <>
      {raw ? <pre className="tool-body">{raw}</pre> : null}
      {output ? <pre className="tool-body result">{output}</pre> : null}
    </>
  );
}

function ToolCall({ call, onReveal }: { call: ConversationToolCall; onReveal?: () => void }) {
  const [open, setOpen] = useState(false);
  const { kind, name, arguments: args, output } = call;
  const visual = toolVisual(kind, name);
  const Icon = visual.icon;
  /*
   * A call that names a file gets the file treatment: type icon, leaf name,
   * directory — and, for an edit, the change counts. Codex patches carry no
   * arguments (the patch is its own field server-side), so the server's `path`
   * is what makes their rows readable at all.
   */
  const subject = toolSubject(name, args);
  const filePath = call.path ?? (looksLikeFilePath(subject) ? subject : null);
  const parts = filePath ? splitFilePath(filePath) : null;
  const icon = filePath ? fileIconDataUri(filePath) : null;
  const stats = isEditVisual(visual) ? toolChangeStats(call) : null;
  // A whole-file write is its own verb; an edit stays 编辑.
  const label = (isEditVisual(visual) ? toolOperationLabel(call) : null) ?? visual.label;
  // What a copy of the detail copies: the call's own input text when the
  // transcript kept one (a patch), otherwise the raw arguments, plus output.
  const rawInput =
    call.input ??
    (args && typeof args === "object" ? JSON.stringify(args, null, 2) : String(args ?? ""));
  const copyPayload = [rawInput, output]
    .filter((part): part is string => !!part && part.length > 0)
    .join("\n\n");
  useExpandReveal(open, onReveal);
  return (
    <div className="tool-call">
      {/*
        ZCode's tool summary anatomy: an inline row of glyph, category label,
        and the command or file the call acted on — no card chrome, so a run of
        tool calls reads as a log of actions inside the reply rather than a
        stack of boxes. The chevron appears on hover and rotates once the detail
        is open.
      */}
      <button
        type="button"
        className="tool-summary"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon size={14} className="tool-icon" aria-hidden="true" />
        <span className="tool-kind">{label}</span>
        <span className="tool-subject">
          {parts ? (
            <>
              {icon ? <img className="file-icon" src={icon} alt="" aria-hidden="true" /> : null}
              <span className="file-name">{parts.name}</span>
              {parts.dir ? <span className="file-dir">{parts.dir}</span> : null}
            </>
          ) : (
            <span className="tool-text">{subject}</span>
          )}
        </span>
        {stats ? (
          <span className="diff-stats">
            <span className="diff-add">+{stats.added}</span>
            <span className="diff-del">-{stats.removed}</span>
          </span>
        ) : null}
        {call.failed ? <span className="tool-failed">执行失败</span> : null}
        <ChevronRight size={14} className={`tool-chevron${open ? " open" : ""}`} aria-hidden="true" />
      </button>
      {open ? (
        <div className="tool-detail">
          <div className="tool-detail-actions">
            <CopyButton text={copyPayload} title="Copy tool call" />
          </div>
          <ToolDetail call={call} />
        </div>
      ) : null}
    </div>
  );
}

/** One stretch of the interleaved reply: thinking, an answer block, or a tool. */
type TurnGroup =
  | { kind: "reasoning"; messages: ConversationMessage[] }
  | { kind: "answer"; message: ConversationMessage }
  | { kind: "tool"; call: ConversationToolCall };

/**
 * The rule for what happens to the scroll when a row is expanded, taken from
 * ZCode's timeline (`timelineScrollAnchor.ts`): a reader who is at the bottom
 * is carried along — the new height makes the view stick to the bottom, which
 * reveals the detail from below and pushes the row that was clicked upward; a
 * reader who has scrolled up keeps their place, and nothing moves under them.
 */
function useExpandReveal(open: boolean, onReveal: (() => void) | undefined) {
  useEffect(() => {
    if (open) onReveal?.();
  }, [open, onReveal]);
}

/**
 * One collapsible stretch of thinking, set wherever it happened in the reply.
 *
 * Consecutive reasoning coalesces into one segment so a run of thinking
 * paragraphs gets one toggle rather than one per block. It starts collapsed:
 * thinking is the longest part of a turn and the answer is what the reader came
 * for, so the reasoning stays one tap away instead of pushing the reply down.
 *
 * The collapsed row still reports, ZCode-style: a live segment shows a shimmering
 * "thinking" and the newest line of the reasoning as a ticker, while a finished
 * one shows how long it took. Expanding always wins — it is the reader asking
 * for the text.
 */
function ReasoningSegment({
  messages,
  streaming,
  onReveal,
}: {
  messages: ConversationMessage[];
  /** True for the segment the agent is still writing reasoning into. */
  streaming: boolean;
  onReveal?: () => void;
}) {
  const [open, setOpen] = useState(false);
  // The ticker only exists while collapsed: expanded, the newest line is on
  // screen already.
  const summary = streaming && !open ? lastReasoningLine(messages) : "";
  const duration = streaming ? null : reasoningDurationSeconds(messages);
  // The newest line of a ticker is its right edge, so the viewport is parked
  // there whenever the text grows.
  const tickerRef = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    const element = tickerRef.current;
    if (element) element.scrollLeft = element.scrollWidth;
  }, [summary]);
  useExpandReveal(open, onReveal);
  return (
    <div className="activity reasoning-group">
      {/*
        Thinking gets the same row anatomy as a tool call — ZCode shows it as a
        brain glyph and a label, not as italic prose, so it reads as another
        collapsible step in the reply. The labels are ZCode's own: 正在思考
        while it streams behind a shimmer, then 思考 · 持续了 N 秒.
      */}
      <button
        type="button"
        className="tool-summary"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <ReasoningVisual.icon size={14} className="tool-icon" aria-hidden="true" />
        <span className={`tool-kind${streaming ? " thinking-live" : ""}`}>
          {streaming ? "正在思考" : "思考"}
        </span>
        {!streaming ? (
          <span className="thinking-duration">
            · {duration !== null ? `持续了 ${duration} 秒` : "持续了几秒"}
          </span>
        ) : null}
        {summary ? (
          <span className="thinking-summary" ref={tickerRef}>
            {summary}
          </span>
        ) : null}
        <ChevronRight
          size={14}
          className={`tool-chevron${open ? " open" : ""}`}
          aria-hidden="true"
        />
      </button>
      {open
        ? messages.map((message, index) => (
            <div key={index} className="agent-message reasoning">
              <Markdown text={message.text ?? ""} />
            </div>
          ))
        : null}
    </div>
  );
}

function Turn({
  turn,
  index,
  onPreviewImage,
  subagents,
  onOpenSubagents,
  onReveal,
}: {
  turn: ConversationTurn;
  index?: number;
  onPreviewImage?: (url: string) => void;
  /** Finished runs that started during this turn, shown as their own record. */
  subagents?: SubagentRun[];
  onOpenSubagents?: () => void;
  /** What happens to the scroll when a row here is expanded. */
  onReveal?: () => void;
}) {
  const allMessages = (turn.agent_messages ?? []).filter((message) => (message.text ?? "").trim());
  const messages = allMessages.filter((message) => !message.is_reasoning);
  const meta = [clockTime(turn.started_at), duration(turn.duration_ms), turn.model].filter(
    Boolean,
  );
  // What a copy of this turn copies: everything the agent said, answer first,
  // so pasting it elsewhere reads as the reply rather than as the scratchpad.
  const copyText =
    [turn.final_answer, ...messages.map((message) => message.text)]
      .filter((part): part is string => !!part && part.trim().length > 0)
      .join("\n\n") || allMessages.map((message) => message.text ?? "").join("\n\n");

  /*
   * The reply renders as one timeline: each message and each tool call in the
   * order they actually happened, so a command shows between the paragraphs it
   * belongs to instead of the whole batch being parked at the end. The order
   * comes from the shared entry-stream index; without it (an older server) the
   * stable sort keeps messages ahead of tools, which is the old layout.
   */
  const groups: TurnGroup[] = [];
  for (const item of interleaveTurn({ ...turn, agent_messages: allMessages })) {
    if (item.kind === "tool") {
      groups.push({ kind: "tool", call: item.call });
      continue;
    }
    const message = item.message;
    if (message.is_reasoning) {
      const previous = groups[groups.length - 1];
      if (previous && previous.kind === "reasoning") previous.messages.push(message);
      else groups.push({ kind: "reasoning", messages: [message] });
    } else {
      groups.push({ kind: "answer", message });
    }
  }
  /*
   * While the turn is still running, the last segment is the one being written.
   * It is live only when it is reasoning: a tool call after the thinking means
   * the agent has moved on to doing something with it.
   */
  const lastGroup = groups[groups.length - 1];
  const liveReasoning = turn.status === "ongoing" && lastGroup?.kind === "reasoning";

  /*
   * A turn separates into the reply and the work behind it, the way ZCode folds
   * a turn: the text the reader came for stays visible, while thinking and tool
   * calls fold under one "worked for…" row. A running turn keeps its work open
   * — watching it is the point of a live turn — and finishing folds it away,
   * unless the reader has opened it themselves, which always outlasts the
   * automatic fold.
   */
  const running = turn.status === "ongoing";
  const processGroups = groups
    .map((group, position) => ({ group, position }))
    .filter(({ group }) => group.kind !== "answer");
  const answerGroups = groups
    .map((group, position) => ({ group, position }))
    .filter(({ group }) => group.kind === "answer");
  const hasAnswerText = messages.length > 0 || (turn.final_answer ?? "").trim().length > 0;
  // A work-only turn opens its work: folding it would leave nothing on screen.
  const [historyOpen, setHistoryOpen] = useState(() => running || !hasAnswerText);
  const historyTouched = useRef(false);
  const previousStatus = useRef(turn.status);
  useEffect(() => {
    const previous = previousStatus.current;
    previousStatus.current = turn.status;
    if (previous === "ongoing" && turn.status !== "ongoing" && !historyTouched.current) {
      setHistoryOpen(false);
    }
  }, [turn.status]);
  // The worked-for label counts up while the turn runs.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  const workedMs = running
    ? turn.started_at
      ? now - turn.started_at * 1000
      : undefined
    : turn.duration_ms;
  // ZCode's wording for the fold: 工作中 while it runs, 已工作 once it is done.
  const workedFor = chineseDuration(workedMs);
  const workedLabel = workedFor
    ? `${running ? "工作中" : "已工作"} ${workedFor}`
    : running
      ? "工作中"
      : "已工作";

  const renderGroup = (group: TurnGroup, position: number) => {
    if (group.kind === "tool") {
      return (
        <ToolCall key={group.call.call_id ?? position} call={group.call} onReveal={onReveal} />
      );
    }
    if (group.kind === "reasoning") {
      return (
        <ReasoningSegment
          key={position}
          messages={group.messages}
          streaming={liveReasoning && position === groups.length - 1}
        />
      );
    }
    return (
      <div key={position} className="agent-message">
        <Markdown text={group.message.text ?? ""} />
      </div>
    );
  };

  return (
    <div className="turn" data-turn-index={index}>
      {turn.user_message ? (
        <div className="bubble user">
          <MessageBody text={turn.user_message} onPreviewImage={onPreviewImage} />
        </div>
      ) : null}

      <div className={`bubble agent ${turn.status ?? ""}`}>
        <div className="bubble-head">
          <span className="agent-name">agent</span>
          {meta.length ? <span className="agent-meta">{meta.join(" · ")}</span> : null}
          {turn.status && turn.status !== "complete" ? (
            <span className={`turn-status ${turn.status}`}>{turn.status}</span>
          ) : null}
          {/* Copy reads the turn without quoting it on a phone, where press-
              and-hold selects the whole conversation instead. */}
          {copyText ? <CopyButton text={copyText} title="Copy message" /> : null}
        </div>

        {/*
          The work row: how long the turn has been running, and the fold that
          holds everything the agent did to get to the reply. The expanded rows
          sit in `.work-body`, which spaces them the way ZCode's history does —
          its rows are separated (gap-4), not stacked.
        */}
        {processGroups.length > 0 ? (
          <div className="work-history">
            <button
              type="button"
              className="tool-summary work-summary"
              aria-expanded={historyOpen}
              onClick={() => {
                historyTouched.current = true;
                setHistoryOpen((value) => !value);
              }}
            >
              <span className="tool-kind">{workedLabel}</span>
              <ChevronRight
                size={14}
                className={`tool-chevron${historyOpen ? " open" : ""}`}
                aria-hidden="true"
              />
            </button>
          </div>
        ) : null}

        {historyOpen ? (
          <div className="work-body">
            {processGroups.map(({ group, position }) => renderGroup(group, position))}
          </div>
        ) : null}

        {answerGroups.map(({ group, position }) => renderGroup(group, position))}

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

        {/*
          Subagents this turn spawned, recorded under the turn that asked for
          them.

          They used to live only in the bar above the composer, which meant a
          finished run kept announcing itself at the bottom of the pane long
          after the work was over, with nothing tying it to the request. Here the
          record sits next to the turn that caused it and goes away with the rest
          of the history when the reader scrolls on.
        */}
        {subagents?.length ? (
          <div className="turn-subagents">
            {subagents.map((run) => (
              <button
                key={run.run_id}
                type="button"
                className={`turn-subagent ${run.state}`}
                onClick={onOpenSubagents}
                title={run.task ?? run.agent}
              >
                <span className={`run-dot ${run.state}`} aria-hidden="true" />
                <span className="turn-subagent__agent">{run.agent}</span>
                <span className="turn-subagent__activity">{activity(run)}</span>
                {run.tool_count !== undefined ? (
                  <span className="run-metric">{run.tool_count} 次工具</span>
                ) : null}
              </button>
            ))}
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
  subagents = [],
  onOpenSubagents,
  paneId,
  label,
  sentMessage,
  working = false,
  onPreviewImage,
  status,
}: {
  client: DetailClient;
  /** The session's live state, floating over the conversation's top right. */
  status?: ReactNode;
  /** Every run recorded for this pane, running or finished. */
  subagents?: SubagentRun[];
  /** Opens the subagent drawer, which holds each run's full detail. */
  onOpenSubagents?: () => void;
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
  /** Opens an uploaded image referenced in a message, full size. */
  onPreviewImage?: (url: string) => void;
  /**
   * The session's live state — the todo list and running subagents — which
   * floats over the conversation's top right (ZCode's status panel). Rendered
   * by the detail view because the data is polled there.
   */
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
  const historyLoaded = useRef(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const readerRef = useRef<ReturnType<typeof createConversationReader> | null>(null);
  /**
   * Whether the view should follow new turns.
   *
   * True while the reader is at the bottom, false once they scroll up to read
   * back. New output must not yank the viewport away from history they are
   * reading, so this is only recomputed from the user's own scrolling.
   */
  const pinnedToBottom = useRef(true);
  /**
   * Whether the newest output is far enough off screen to offer a jump to it.
   *
   * State rather than a ref because it decides whether a control is drawn. The
   * threshold is wider than the follow one: following resumes almost immediately,
   * but a control that appears on a few pixels of scroll would flicker.
   */
  const [awayFromBottom, setAwayFromBottom] = useState(false);
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

  const refreshNewest = useCallback(() => {
    readerRef.current?.refresh();
  }, []);

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
    setLoadingOlder(false);
    // A different pane is a different conversation, so following starts over
    // from the bottom. Carrying the previous pane's scroll-up state across
    // would leave the new conversation unfollowed until the reader scrolled.
    pinnedToBottom.current = true;

    historyLoaded.current = false;
    const reader = createConversationReader(
      () => loadConversation(client, paneId, { maxBytes: PAGE_BYTES }),
      (data) => {
        setConversation((current) => historyLoaded.current && current
          ? { ...data, pagination: current.pagination } : data);
        setNewest(data.turns ?? []);
        setError(null);
        if (!historyLoaded.current) cursor.current = data.pagination?.next_cursor;
        setLoading(false);
      },
      (err) => {
        setError(err instanceof ConversationError ? err.message : String(err));
        setLoading(false);
      },
    );
    readerRef.current = reader;
    reader.refresh();
    return () => {
      controller.abort();
      reader.dispose();
      if (readerRef.current === reader) readerRef.current = null;
    };
  }, [client, paneId]);

  useConversationRefresh(
    client,
    paneId,
    working,
    newest[newest.length - 1]?.status === "ongoing",
    refreshNewest,
  );

  const hasMore = conversation?.pagination?.has_more ?? false;

  /** Loads the page before the oldest turn currently shown. */
  const loadOlder = useCallback(async () => {
    if (loadingOlderRef.current || !hasMore || cursor.current === undefined) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    const controller = abortRef.current;
    const requestCursor = cursor.current;
    const container = scrollRef.current;
    const previousHeight = container?.scrollHeight ?? 0;
    try {
      const data = await loadConversation(client, paneId, {
        maxBytes: PAGE_BYTES,
        cursor: requestCursor,
      });
      if (controller?.signal.aborted) return;
      historyLoaded.current = true;
      const older_page = data.turns ?? [];
      cursor.current = data.pagination?.next_cursor;
      setConversation((current) => (current ? { ...current, pagination: data.pagination } : data));
      if (older_page.length) {
        setOlder((current) => [older_page, ...current]);
        // Older turns are prepended, so anchor the viewport on the content that
        // was already on screen.
        requestAnimationFrame(() => {
          if (controller?.signal.aborted) return;
          const element = scrollRef.current;
          if (element) element.scrollTop += element.scrollHeight - previousHeight;
        });
      }
    } catch (err) {
      if (controller?.signal.aborted) return;
      setError(err instanceof ConversationError ? err.message : String(err));
    } finally {
      if (controller?.signal.aborted) return;
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  }, [client, paneId, hasMore]);

  /**
   * Whether the rail has faded back to a hint.
   *
   * It floats over the transcript, so it is dimmed unless the reader is doing
   * something that suggests they want it: scrolling, or touching the rail
   * itself. `useActiveTurn` updates on every frame of a scroll, so the timer is
   * restarted rather than merely set, which keeps it up until the scrolling
   * stops.
   */
  const [navigatorDimmed, setNavigatorDimmed] = useState(true);
  const dimTimer = useRef<number | null>(null);
  const wakeNavigator = useCallback(() => {
    setNavigatorDimmed(false);
    if (dimTimer.current !== null) window.clearTimeout(dimTimer.current);
    dimTimer.current = window.setTimeout(() => {
      dimTimer.current = null;
      setNavigatorDimmed(true);
    }, NAVIGATOR_DIM_DELAY_MS);
  }, []);
  useEffect(
    () => () => {
      if (dimTimer.current !== null) window.clearTimeout(dimTimer.current);
    },
    [],
  );

  const onScroll = () => {
    const element = scrollRef.current;
    if (!element) return;
    // Distance from the bottom, tolerant of sub-pixel rounding and of the
    // scrollbar itself so sitting at the end still counts as pinned.
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    pinnedToBottom.current = distance < 40;
    setAwayFromBottom(distance > 120);
    // Reaching the top pulls in the previous page.
    if (element.scrollTop < 80) void loadOlder();
    // Scrolling means the reader is looking for a position, so the rail is worth
    // showing at full strength while it lasts.
    wakeNavigator();
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

  /*
   * Finished runs are filed under the turn that was running when they started, so
   * each one is recorded where it was asked for instead of only in the bar above
   * the composer. Runs the grouping cannot place — started before the oldest
   * loaded turn, or with no timestamp — are left out of the transcript rather
   * than dropped: the bar still accounts for them.
   */
  const { byTurn: subagentsByTurn } = runsByTurn(subagents, turns);

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
   * What an expansion does to the scroll, ZCode's rule: a reader at the bottom
   * is carried along (the view keeps sticking to the bottom, so the new detail
   * is revealed and the row that was clicked rises); a reader who has scrolled
   * up keeps their place and nothing moves under them.
   */
  const revealExpanded = useCallback(() => {
    const element = scrollRef.current;
    if (element && pinnedToBottom.current) element.scrollTop = element.scrollHeight;
  }, []);

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

  /*
   * Ctrl/Cmd+ArrowUp and Ctrl/Cmd+ArrowDown walk the rail's anchors: up to the
   * previous question, down to the next. The position it starts from is the one
   * the rail highlights — the last question at or before the active turn.
   *
   * A focused field keeps the chord: Cmd+Up is beginning-of-document in a text
   * field, and the composer is exactly where that is wanted.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      if (!event.ctrlKey && !event.metaKey) return;
      const focused = document.activeElement;
      if (
        focused instanceof HTMLElement &&
        (focused.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/u.test(focused.tagName))
      ) {
        return;
      }
      const anchors = turns
        .map((turn, index) => ({ index, question: (turn.user_message ?? "").trim() }))
        .filter((anchor) => anchor.question.length > 0);
      if (anchors.length === 0) return;
      event.preventDefault();
      let position = 0;
      for (const [order, anchor] of anchors.entries()) {
        if (activeTurn === null || anchor.index <= activeTurn) position = order;
        else break;
      }
      const next =
        event.key === "ArrowUp"
          ? Math.max(0, position - 1)
          : Math.min(anchors.length - 1, position + 1);
      jumpToTurn(anchors[next].index);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [turns, activeTurn, jumpToTurn]);

  // Any touch brings the rail back to full strength, so a reader who wants to
  // jump can touch the screen and then grab the rail instead of having to scroll
  // first. While dimmed the rail ignores pointer events, so without this there
  // would be no way to reach it other than by scrolling.
  return (
    <div className="conversation-wrap" onTouchStart={wakeNavigator}>
      {status}
      {/*
        Everything but the file tree lives here. A wrapper is needed rather than
        placing the rail and the jump control directly in `.conversation-wrap`:
        those two position themselves against the reading column's centre, and
        with the tree docked the wrap is wider than the conversation — the rail
        would land under the tree instead of beside the text.
      */}
      <div className="conversation-area">
        {/* The rail is a sibling of the scroll container rather than a child, so
            it stays put while the transcript moves under it. */}
        <TurnNavigator
        turns={turns}
        activeTurn={activeTurn}
        onJump={jumpToTurn}
        dimmed={navigatorDimmed}
        onWake={wakeNavigator}
      />
      {/*
        Jump to the newest turn.

        A sibling of the scroll container, like the rail, so it stays put while
        the transcript moves under it. Only drawn once the newest output is off
        screen, so it never covers text that is already in view.
      */}
      {awayFromBottom ? (
        <button
          type="button"
          className="jump-to-latest"
          aria-label="Jump to the newest output"
          title="Jump to the newest output"
          onClick={() => {
            const element = scrollRef.current;
            if (!element) return;
            element.scrollTop = element.scrollHeight;
            pinnedToBottom.current = true;
            setAwayFromBottom(false);
          }}
        >
          <ArrowDown size={18} aria-hidden="true" />
        </button>
      ) : null}
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

        {hasMore && !loading ? (
          <div className="pager">
            <button type="button" disabled={loadingOlder} onClick={() => void loadOlder()}>
              {loadingOlder ? "loading earlier turns…" : "Load earlier messages"}
            </button>
          </div>
        ) : null}
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
            <Turn
              key={turn.turn_id ?? index}
              turn={turn}
              index={index}
              onPreviewImage={onPreviewImage}
              subagents={subagentsByTurn.get(turn.turn_id)}
              onOpenSubagents={onOpenSubagents}
              onReveal={revealExpanded}
            />
          ))}
          {pending ? (
            <PendingTurn message={sentMessage ?? ""} onPreviewImage={onPreviewImage} />
          ) : null}
        </div>

      </div>
      </div>
    </div>
  );
}

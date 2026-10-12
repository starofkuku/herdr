import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { Subscription, ConnectionState } from "./gateway";
import { ConnectionBadge } from "./ConnectionBadge";
import { HISTORY_PAGE_LINES, directoryName, statusLabel, paneIdOfEvent, type AgentView } from "./api";
import { ConversationView } from "./ConversationView";
import { InteractionPanel } from "./InteractionPanel";
import { CodexInteractionNotice } from "./CodexInteractionNotice";
import type { InteractionAnswer } from "./interaction";
import { AlarmClock, ArrowUp, Download, Maximize2, Minimize2, Plus, Settings, Square, SquareTerminal, Terminal } from "lucide-react";
import { AgentIcon } from "./AgentIcon";
import { CopyButton } from "./Markdown";
import { AgentCycleOverlay } from "./AgentCycleOverlay";
import { AgentSwitcher } from "./AgentSwitcher";
import { useAgentCycle } from "./useAgentCycle";
import { PendingUploads } from "./PendingUploads";
import { ComposerInput } from "./ComposerInput";
import { TerminalView } from "./TerminalView";
import { SchedulePanel } from "./SchedulePanel";
import { createShellPane } from "./terminal";
import { SelectionQuoteMenu } from "./SelectionQuoteMenu";
import { QuoteChips } from "./QuoteChips";
import {
  addQuote,
  newQuote,
  NO_QUOTES,
  quotedPromptBlocks,
  removeQuote,
  type QuoteSource,
  type QuoteState,
} from "./quotes";
import { useInputHistory } from "./useInputHistory";
import { BackendBadge } from "./BackendBadge";
import { FilePreview } from "./FilePreview";
import { ImageViewer } from "./ImageViewer";
import { SettingsPanel } from "./SettingsPanel";
import { commandsForAgent } from "./agentCommands";
import { customCommandSummary, loadCustomCommands, type CustomCommand } from "./customCommands";
import {
  buildSlashMenu,
  expandSlashMessage,
  loadSkills,
  slashQuery,
  slashSettled,
  type SkillEntry,
  type SlashMenuItem,
} from "./skills";
import { FileSearchPalette } from "./FileSearchPalette";
import { FileTreePanel } from "./FileTreePanel";
import { SubagentDrawer } from "./SubagentBar";
import { StatusPanel } from "./StatusPanel";
import { ServerLoadBar } from "./ServerLoadBar";
import { AgentModelPicker } from "./AgentModelPicker";
import { SUBAGENT_POLL_MS, isRunning, loadSubagents, type SubagentRun } from "./subagents";
import { TODO_POLL_MS, loadTodos, type TodoItem } from "./todos";
import { ThemeToggle } from "./ThemeToggle";
import {
  fileToBase64,
  formatBytes,
  releaseUpload,
  stageUpload,
  uploadError,
  type StagedUpload,
} from "./upload";

/**
 * Backstop for the optimistic echo.
 *
 * The echo normally disappears as soon as the agent's transcript catches up. If
 * the agent never records the message, this keeps a phantom turn from sitting in
 * the conversation indefinitely.
 */
const SENT_ECHO_TIMEOUT_MS = 30_000;

/**
 * How long a fresh send is trusted to still be running.
 *
 * Detection lags the send, so a non-working status seen immediately after
 * sending is not evidence that the turn ended. Measured from the send, not from
 * each status change, so a turn that ended while the page was backgrounded is
 * already past the grace period when the page returns.
 */
const GRACE_MS = 1500;

/**
 * What the server returns for one staged file.
 *
 * Only the fields the UI reads are declared. `paste_text` is already shaped for
 * the agent by the server, which keeps the per-agent rules (an `@` prefix for
 * some, a bare path for others) in one place instead of duplicating them here.
 */
interface StagedUploadResult {
  paste_text: string;
}

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

/**
 * Reads the live bottom of the pane.
 *
 * This is what the detector looks at, so it is the closest thing to "what the
 * agent is asking right now". It is shown as-is: the UI does not try to parse
 * options out of it.
 */
async function readBlockerText(client: DetailClient, paneId: string): Promise<string> {
  const envelope = await client.call<Record<string, unknown>>("pane.read", {
    pane_id: paneId,
    source: "detection",
    lines: BLOCKER_LINES,
    format: "text",
    strip_ansi: true,
  });
  const read = envelope.read as { text?: string } | undefined;
  // Trim trailing blank rows so a short prompt does not reserve empty space.
  return (read?.text ?? "").replace(/\s+$/, "");
}

/**
 * How many rows of the bottom of the pane to show while blocked.
 *
 * Enough to cover a prompt box plus a couple of lines of context above it.
 */
const BLOCKER_LINES = 24;

/**
 * Keys offered while the agent is blocked.
 *
 * These are raw terminal keys, not choices. The user reads the pane text above
 * and presses what the agent is asking for, exactly as they would in the
 * terminal. Nothing here tries to interpret the prompt, so a wrong guess about
 * an agent's wording can never cause the wrong option to be selected.
 */
const BLOCKER_KEY_GROUPS: { keys: string[]; label: string; title: string; variant?: string }[][] = [
  [
    { keys: ["up"], label: "↑", title: "Move selection up" },
    { keys: ["down"], label: "↓", title: "Move selection down" },
  ],
  [
    { keys: ["enter"], label: "Enter", title: "Confirm the selected option", variant: "primary" },
    // Esc often aborts the turn rather than answering the prompt, so it is
    // styled apart from the keys that resolve the prompt.
    { keys: ["esc"], label: "Esc", title: "Dismiss or interrupt", variant: "danger" },
  ],
  "123456789".split("").map((key) => ({ keys: [key], label: key, title: `Press ${key}` })),
  [
    { keys: ["y"], label: "y", title: "Press y" },
    { keys: ["n"], label: "n", title: "Press n" },
  ],
];

export interface DetailClient {
  call: <T>(method: string, params?: Record<string, unknown>) => Promise<T>;
  // A kind is a bare name, or a full subscription object for kinds that need
  // extra parameters such as a `pane_id`.
  subscribe: (
    kinds: (string | Record<string, unknown>)[],
    onEvent: (payload: unknown) => void,
  ) => Subscription;
}

/**
 * Which agent this is, and which checkout it is in — and, on click, the two long
 * values the header has no room for.
 *
 * The name is the working directory's own name rather than the agent's or the
 * workspace's: six panes of one CLI all read "pi", and a workspace with no label
 * is called "workspace 3", so the directory is the only one of the three that
 * actually tells the reader which pane they are looking at. The mark says which
 * agent it is, since that needs no words.
 *
 * The full path and the agent's session id are long, are read far less often
 * than they are copied, and pushed the name off the end of the header when they
 * sat beside it. They are therefore behind a click, each with its own copy
 * control. The session id identifies the agent's own session rather than the
 * pane: a pane is replaced when a session is resumed elsewhere, and this is the
 * value that follows the conversation across them.
 *
 * Click rather than hover to open it: this is the only way to reach these two
 * values, and a touch screen has no hover to give.
 */
function AgentIdentity({ agent }: { agent: AgentView | null }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  // Clicking away or pressing Escape closes it, as with every other overlay here.
  // The copy controls live inside, so a click on one of those is not a click away.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const details: { label: string; value: string }[] = [];
  if (agent?.cwd) details.push({ label: "工作目录", value: agent.cwd });
  if (agent?.sessionId) details.push({ label: "会话 ID", value: agent.sessionId });

  const name = agent?.cwd
    ? directoryName(agent.cwd)
    : agent?.project || agent?.label || "agent";

  return (
    <div className="topbar-identity" ref={root}>
      <button
        type="button"
        className="topbar-identity__face"
        aria-expanded={open}
        aria-haspopup="true"
        title={name}
        onClick={() => setOpen((value) => !value)}
      >
        <AgentIcon agent={agent?.agent} size={17} />
        <span className="topbar-identity__name">{name}</span>
      </button>
      {details.length > 0 ? (
        <div className={`topbar-identity__panel${open ? " open" : ""}`}>
          {details.map((row) => (
            <IdentityRow key={row.label} label={row.label} value={row.value} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** One of the header's hidden facts, with its own copy control. */
function IdentityRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="identity-row">
      <span className="identity-row__label">{label}</span>
      <code className="identity-row__value" title={value}>
        {value}
      </code>
      <CopyButton text={value} title={`复制${label}`} />
    </div>
  );
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
  agents,
  allAgents,
  backend,
  connection,
  onRetry,
  onSelectAgent,
  onOpenPane,
  routePaneId,
}: {
  agent: AgentView | null;
  agents: AgentView[];
  /**
   * Every agent on every backend, for the switcher.
   *
   * Separate from `agents`, which is this session's list: the switcher is a way
   * to leave for anywhere the reader has open, and that includes other
   * gateways.
   */
  allAgents?: AgentView[];
  /** The gateway this conversation is on, shown so the reader knows which. */
  backend: { id: string; name: string; url: string };
  onBack: () => void;
  client: DetailClient;
  onChanged: () => void;
  connection: ConnectionState;
  onRetry: () => void;
  onSelectAgent: (paneId: string, backendId?: string) => void;
  /** Leaves for another pane in this session, which is how a new shell is shown. */
  onOpenPane: (paneId: string) => void;
  /**
   * The pane the route named.
   *
   * Needed on its own because a pane is not necessarily an agent: a shell has no
   * agent to be listed as, and it still has a screen to read and a stream to follow.
   */
  routePaneId: string;
}) {
  // Oldest page first, so prepending older pages does not disturb scroll.
  const [pages, setPages] = useState<string[]>([]);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const [draft, setDraft] = useState("");
  /** Whether the reader asked for a taller field; the text grows it either way. */
  const [tall, setTall] = useState(false);
  /**
   * The floor a drag left on the field, in pixels, or null for the default.
   *
   * A floor rather than a height: the field still grows with what is typed, so
   * dragging raises how small it may get without capping what it may hold.
   */
  const [fieldFloor, setFieldFloor] = useState<number | null>(null);
  /** The file shown in the preview column, if any. */
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  /** The pane's installed skills, fetched once a slash is first typed. */
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  /** The reader's own slash commands, kept in this browser. */
  const [customCommands, setCustomCommands] = useState<CustomCommand[]>(() =>
    loadCustomCommands(),
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** The highlighted row of the slash menu. */
  const [slashIndex, setSlashIndex] = useState(0);  /**
   * Whether there is room for the side panes.
   *
   * The tree and the preview are hidden by CSS on a phone, but their state has
   * to follow: a preview that is "open" while invisible would hold the column's
   * width and come back at a stale file when the window widens again.
   */
  const [wideLayout, setWideLayout] = useState(
    () => typeof window === "undefined" || window.matchMedia("(min-width: 60.001rem)").matches,
  );
  /** Whether the jump-to-file palette is up. */
  const [searchOpen, setSearchOpen] = useState(false);
  /**
   * Whether the status panel is open.
   *
   * Lives here rather than in the panel because an open panel takes width from
   * the conversation: the screen has to reserve that width, and it is also what
   * watches for a file being open.
   */
  const [statusOpen, setStatusOpen] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(min-width: 80rem)").matches,
  );
  /** What the panel was set to before a file opened, so closing restores it. */
  const statusBeforePreview = useRef(statusOpen);
  /** A toggle made while a file was open outranks the restore. */
  const statusToggledDuringPreview = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blockerText, setBlockerText] = useState("");
  // The stop affordance is tied to a turn this client started, not to the pane
  // merely being busy: opening someone else's running agent should not put a
  // destructive button in front of the user.
  const [pendingTurn, setPendingTurn] = useState(false);
  /**
   * Message this client just sent, until the agent's own transcript records it.
   *
   * Passed to the conversation view so the sent text appears immediately
   * instead of only after the agent writes the turn.
   */
  const [sentMessage, setSentMessage] = useState<string | null>(null);
  /**
   * Drops the optimistic echo if the agent never records the message.
   *
   * The echo normally disappears as soon as the transcript catches up. This is
   * only the backstop for the case where it never does, so a phantom turn
   * cannot sit in the conversation forever.
   */
  const sentExpiry = useRef<number | null>(null);
  /**
   * Files chosen and not yet sent, in the order they were added.
   *
   * Held here rather than uploaded on selection: a file may be removed before
   * sending, and the message that accompanies it is still being typed.
   */
  const [uploads, setUploads] = useState<StagedUpload[]>([]);
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [subagents, setSubagents] = useState<{ active: number; runs: SubagentRun[] }>({
    active: 0,
    runs: [],
  });
  const [drawerOpen, setDrawerOpen] = useState(false);
  /** True while files are being decoded, so the composer cannot send mid-add. */
  const [preparing, setPreparing] = useState(false);
  /** Highlights the pane while a drag is over it. */
  const [dragging, setDragging] = useState(false);
  /** The image shown enlarged, if any. */
  const [lightbox, setLightbox] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // `dragleave` fires when the pointer crosses between child elements, so a
  // plain boolean flickers. Counting enter/leave pairs keeps the highlight
  // steady until the drag actually leaves the pane.
  const dragDepth = useRef(0);

  /*
   * The pane this screen is about: the agent's own id when the pane runs an agent,
   * and the route's otherwise. A shell is a pane too, and the terminal view is the
   * only thing that makes it useful — but it needs the pane's name to address it.
   */
  const paneId = agent?.paneId ?? routePaneId;
  const skillNames = useMemo(
    () => new Set(skills.map((skill) => skill.name)),
    [skills],
  );
  const agentCommands = useMemo(
    () => commandsForAgent(agent?.agent),
    [agent?.agent],
  );
  const customSlashItems = useMemo(
    () =>
      customCommands.map((command) => ({
        name: command.name,
        description: customCommandSummary(command.content),
      })),
    [customCommands],
  );
  const customCommandNames = useMemo(
    () => new Set(customCommands.map((command) => command.name)),
    [customCommands],
  );
  const slashTrigger = slashQuery(draft);
  /*
   * Settled means the word names a known command exactly, so the picker has
   * nothing left to offer: choosing one leaves "/name " in the draft, which is
   * settled, and the menu must close behind it rather than linger over the
   * composer with an empty list.
   */
  const slashOffering =
    slashTrigger !== null &&
    !slashSettled(draft, skillNames) &&
    !slashSettled(draft, customCommandNames);
  const slashMenu = slashOffering
    ? buildSlashMenu(skills, agentCommands, customSlashItems, slashTrigger)
    : { custom: [], skills: [], commands: [] as SlashMenuItem[], flat: [] as SlashMenuItem[] };
  // The keyboard walks one flat list across both groups, so the highlighted
  // row keeps its place as the groups grow and shrink.
  const slashMatches = slashMenu.flat;
  /** Esc closes the menu without losing the draft; typing reopens it. */
  const [slashDismissed, setSlashDismissed] = useState(false);
  useEffect(() => {
    setSlashDismissed(false);
    setSlashIndex(0);
  }, [slashTrigger]);
  const slashMenuOpen = slashOffering && !slashDismissed;
  const highlightedSlash = Math.min(slashIndex, slashMatches.length - 1);
  // The list is only worth fetching once a slash is typed, and only once:
  // reloading the page is the way to see newly installed skills.
  const [skillsFetched, setSkillsFetched] = useState(false);
  useEffect(() => {
    if (skillsFetched || slashTrigger === null || !paneId) return;
    setSkillsFetched(true);
    void loadSkills(client, paneId).then((state) => {
      if (state) setSkills(state.skills);
    });
  }, [client, paneId, slashTrigger, skillsFetched]);
  /** Replaces the draft's trailing slash word with the chosen skill and its trailing space. */
  const chooseSlashSkill = useCallback((name: string) => {
    /*
     * Only the word is replaced, not the whole draft: the trigger can sit under
     * text the reader has already typed, and that text is theirs, not part of the
     * command.
     */
    setDraft((current) => `${current.replace(/\/[^\s/]*$/u, "")}/${name} `);
    requestAnimationFrame(() => {
      const field = composerRef.current;
      if (!field) return;
      field.focus();
      const end = field.value.length;
      field.selectionStart = end;
      field.selectionEnd = end;
    });
  }, []);
  /**
   * A custom command drops its whole text into the composer rather than its
   * name: the point of the command is the text, and the reader may want to add
   * to it before sending.
   */
  const chooseCustomCommand = useCallback((content: string) => {
    /*
     * The command's text replaces only the trailing slash word, for the same
     * reason as the skill above: what the reader typed around it is theirs.
     */
    setDraft((current) => current.replace(/\/[^\s/]*$/u, content));
    requestAnimationFrame(() => {
      const field = composerRef.current;
      if (!field) return;
      field.focus();
      const end = field.value.length;
      field.selectionStart = end;
      field.selectionEnd = end;
    });
  }, []);
  /** One selection path for the keyboard and the mouse: custom commands expand. */
  const chooseSlashItem = useCallback(
    (item: SlashMenuItem) => {
      const custom = customCommands.find((command) => command.name === item.name);
      if (custom) chooseCustomCommand(custom.content);
      else chooseSlashSkill(item.name);
    },
    [chooseCustomCommand, chooseSlashSkill, customCommands],
  );

  /**
   * The agents the switcher and the cycle walk.
   *
   * `allAgents` when the screen has it and it is not empty, because both are
   * ways of leaving for anywhere the reader has open, across gateways. A single
   * backend's screen falls back to its own list, which is all it knows about.
   */
  const switchableAgents = allAgents && allAgents.length > 0 ? allAgents : agents;
  const cycle = useAgentCycle({ agents: switchableAgents, onCommit: onSelectAgent });
  const blocked = agent?.status === "blocked";
  /**
   * The agent's structured question, when it publishes one.
   *
   * Preferred over the terminal panel: the options come from the agent's own
   * protocol, so answering cannot pick a different option than the one shown.
   */
  const interaction = agent?.interaction ?? null;
  /**
   * Whether the structured conversation view has anything to render.
   *
   * True for a transcript file and for a session an agent keeps in its own
   * store; the two are different on the wire but identical to this screen, which
   * only has to choose between a parsed conversation and the pane's own text.
   */
  const hasConversation = agent?.hasConversation ?? false;
  const awaitingConversation = !hasConversation && !!agent?.sessionId
    && (agent.agent === "claude" || agent.agent === "codex");
  // Read inside the subscription callback, which is created once per pane and
  // would otherwise capture a stale `blocked` value.
  const blockedRef = useRef(false);
  blockedRef.current = blocked;
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const inputHistory = useInputHistory({ client, paneId, sessionId: agent?.sessionId,
    readable: hasConversation, onChange: setDraft });
  const nextOffset = useRef(0);
  const pinnedToBottom = useRef(true);

  // `pane.updated` is chatty and fires while the pane sits idle, so coalesce
  // refreshes instead of re-reading page 0 on every event.
  const refreshTimer = useRef<number | null>(null);
  const inFlight = useRef(false);
  const stopTimer = useRef<number | null>(null);
  /**
   * When the current sent turn began, for the grace period below.
   *
   * A turn is only over once the agent stops reporting `working`, but detection
   * lags the send, so the first non-working status right after sending is not
   * trusted. Measuring from the send rather than waiting a fixed period each time
   * the status changes means the grace has already elapsed by the time the page
   * comes back from being backgrounded — where the turn ended long ago and there
   * is nothing left to wait for.
   */
  const pendingSince = useRef(0);

  /**
   * Replaces the newest page with fresh output.
   *
   * Only the fallback view reads the rendered pane. When the agent publishes a
   * transcript the conversation view owns the content, and reading the screen
   * would be both wasted work and a failure on a pane with no live runtime.
   * The check lives here so no caller has to remember it.
   */
  const refreshNewest = useCallback(async () => {
    if (!paneId || inFlight.current || hasConversation) return;
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
  }, [client, paneId, hasConversation]);

  /** Refreshes the bottom-of-pane text shown while blocked. */
  const refreshBlocker = useCallback(async () => {
    if (!paneId) return;
    try {
      setBlockerText(await readBlockerText(client, paneId));
    } catch {
      // The transcript already surfaces read failures; a stale blocker text is
      // better than replacing a working key bar with an error.
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
      // Only an empty page means the history ends. The API returns "up to N"
      // rows and the newest page is one row shorter than a paged read, so a
      // page shorter than the request is not an end-of-history signal.
      if (!text.trim()) {
        setExhausted(true);
      } else {
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
    setBlockerText("");
    nextOffset.current = 0;
    pinnedToBottom.current = true;
    inFlight.current = false;
    void refreshNewest();
  }, [paneId, refreshNewest]);

  // The next older page starts where the loaded rows end. Deriving this from
  // the pages themselves keeps the offset correct whether the newest page was
  // reset or replaced: the API returns "up to N" rows, so page sizes differ.
  useEffect(() => {
    nextOffset.current = pages.reduce((sum, page) => sum + countRows(page), 0);
  }, [pages]);

  // Keep the blocker text current whenever the agent is blocked, including the
  // first time the state is observed (the pane itself is not re-read by the
  // transcript refresh, which only covers scrollback).
  useEffect(() => {
    if (!blocked) {
      setBlockerText("");
      return;
    }
    void refreshBlocker();
  }, [blocked, refreshBlocker]);

  // Live updates: `pane.output_changed` is not a subscribable kind, so watch
  // `pane.updated`. That event covers title, metadata, and diagnostic changes
  // as well as status, so it is filtered to this pane; without the filter a
  // busy session would refresh this view for every unrelated pane.
  useEffect(() => {
    if (!paneId) return;
    const subscription = client.subscribe(["pane.updated"], (payload) => {
      const eventPane = paneIdOfEvent(payload);
      if (eventPane !== undefined && eventPane !== paneId) return;
      scheduleRefreshNewest();
      // While blocked the pane text is the prompt, so keep it in step with the
      // transcript refresh rather than waiting for a separate event.
      if (blockedRef.current) void refreshBlocker();
    });
    return () => {
      subscription.close();
      if (refreshTimer.current !== null) {
        window.clearTimeout(refreshTimer.current);
        refreshTimer.current = null;
      }
    };
  }, [client, paneId, scheduleRefreshNewest, refreshBlocker]);

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

  /**
   * Sends raw terminal keys, the same bytes the terminal would send.
   *
   * No key is derived from the prompt text, so this cannot select an option the
   * user did not intend.
   */
  const sendKeys = async (keys: string[]) => {
    if (!paneId || busy || connection !== "ready") return;
    setBusy(true);
    try {
      await client.call("pane.send_input", { pane_id: paneId, text: "", keys });
      setError(null);
      onChanged();
      // The pane answers immediately after a key, so read it back rather than
      // leaving stale prompt text on screen.
      window.setTimeout(() => {
        void refreshNewest();
        void refreshBlocker();
      }, 250);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Adds files to the pending list, refusing the ones that cannot be sent.
   *
   * Every reason is collected into one message so a multi-file drop reports all
   * of its problems at once instead of only the first.
   */
  const addFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    const accepted: File[] = [];
    const refused: string[] = [];
    for (const file of files) {
      const reason = uploadError(file);
      if (reason) refused.push(reason);
      else accepted.push(file);
    }
    if (refused.length > 0) {
      setError(refused.join("; "));
    }
    if (accepted.length === 0) return;

    setPreparing(true);
    try {
      // Staged one at a time: a thumbnail that fails to decode must not take
      // the rest of the batch down with it.
      const staged: StagedUpload[] = [];
      for (const file of accepted) {
        staged.push(await stageUpload(file));
      }
      setUploads((current) => [...current, ...staged]);
    } finally {
      setPreparing(false);
    }
  }, []);

  /** Removes a file from the pending list and releases its preview. */
  const removeUpload = useCallback((id: string) => {
    setUploads((current) => {
      const entry = current.find((upload) => upload.id === id);
      if (entry) releaseUpload(entry);
      return current.filter((upload) => upload.id !== id);
    });
  }, []);

  /**
   * Uploads every pending file and returns the paste tokens.
   *
   * Does not clear the pending list: the tokens are only worth having if the
   * message that carries them is actually delivered, so the caller clears once
   * the send has succeeded. Clearing here would lose the user's files whenever
   * the send failed after a successful upload.
   */
  const uploadFiles = useCallback(async (): Promise<string[]> => {
    if (!paneId || uploads.length === 0) return [];
    const results: string[] = [];
    for (const upload of uploads) {
      const data = await fileToBase64(upload.file);
      const response = await client.call<Record<string, unknown>>("pane.stage_upload", {
        pane_id: paneId,
        name: upload.file.name,
        mime: upload.file.type,
        data_base64: data,
        // Absent rather than empty when there is no thumbnail, so the server
        // does not have to tell "no thumbnail" from "empty thumbnail".
        ...(upload.thumbnail ? { thumbnail_base64: upload.thumbnail } : {}),
      });
      const staged = response.upload as StagedUploadResult | undefined;
      if (!staged?.paste_text) {
        throw new Error(`upload of ${upload.file.name} returned no path`);
      }
      results.push(staged.paste_text);
    }
    return results;
  }, [client, paneId, uploads]);

  /** Drops every pending file, releasing the object URLs each one holds. */
  const clearUploads = useCallback(() => {
    setUploads((current) => {
      for (const upload of current) releaseUpload(upload);
      return [];
    });
  }, []);

  const send = async () => {
    // A leading slash that names an installed skill becomes the invocation
    // prompt; an agent-native command passes through as typed.
    const message = expandSlashMessage(draft.trim(), skillNames, customCommands);
    // A file with no message is a normal thing to send, so the composer is not
    // required to contain text when something is attached — and a quoted passage
    // is something to send on its own.
    if (
      !paneId ||
      (!message && uploads.length === 0 && quotes.quotes.length === 0) ||
      busy ||
      preparing
    ) {
      return;
    }
    setBusy(true);
    try {
      const pasted = await uploadFiles();
      const base = [message, ...pasted].filter((part) => part.length > 0).join("\n");
      /*
       * The quotes go after the message and its files, set off by a blank line:
       * the agent reads the whole thing as one prompt, and a quotation that is not
       * run together with the sentence above it stays legible for the reader who
       * scrolls back to find out what they asked.
       */
      const quoting = quotedPromptBlocks(quotes.quotes);
      const text = quoting ? (base ? `${base}\n\n${quoting}` : quoting) : base;
      // The files are only dropped once the message is away: an upload that
      // succeeded must not leave a copy behind, and a send that failed must not
      // take the user's files with it.
      await client.call("pane.send_input", { pane_id: paneId, text, keys: ["Enter"] });
      inputHistory.record(draft);
      clearUploads();
      setDraft("");
      // The passage was sent with the message, so keeping it attached would send
      // it again with the next one.
      setQuotes(NO_QUOTES);
      setError(null);
      // The box was sized for the message that just went. The next one starts
      // from the default again, so a long draft cannot leave a tall empty card
      // taking room from the conversation.
      setFieldFloor(null);
      setTall(false);
      setPendingTurn(true);
      pendingSince.current = Date.now();
      setSentMessage(text);
      if (sentExpiry.current !== null) window.clearTimeout(sentExpiry.current);
      sentExpiry.current = window.setTimeout(() => {
        sentExpiry.current = null;
        setSentMessage(null);
      }, SENT_ECHO_TIMEOUT_MS);
      pinnedToBottom.current = true;
      onChanged();
      window.setTimeout(() => void refreshNewest(), 250);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Interrupts the turn the agent is running.
   *
   * Agents advertise the key themselves (`esc to interrupt` in their footer),
   * and Esc is what every agent in the detection manifests accepts. The key is
   * forwarded verbatim; nothing is parsed off the screen.
   */
  const interrupt = async () => {
    if (!paneId || busy) return;
    setBusy(true);
    try {
      await client.call("pane.send_input", { pane_id: paneId, text: "", keys: ["esc"] });
      setError(null);
      setPendingTurn(false);
      setSentMessage(null);
      onChanged();
      window.setTimeout(() => {
        void refreshNewest();
        void refreshBlocker();
      }, 250);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  // The stop affordance follows the agent's reported state, so it has to hear
  // that the state changed even against a server that does not fold status into
  // `pane.updated`. This subscription is pane-scoped because the event requires
  // a pane_id, unlike `pane.updated` which is session-wide.
  useEffect(() => {
    if (!paneId) return;
    const subscription = client.subscribe(
      [{ type: "pane.agent_status_changed", pane_id: paneId }],
      () => onChanged(),
    );
    return () => subscription.close();
  }, [client, paneId, onChanged]);

  // A page does not always end with a newline, so join explicitly. Without a
  // separator the last line of one page runs into the first line of the next.
  // A sent turn ends once the agent leaves the working state. Detection lags a
  // little behind the send, so a non-working status is only trusted after a
  // short grace period; otherwise the button would vanish the instant it appears.
  useEffect(() => {
    if (!pendingTurn) return;
    if (agent?.status === "working" || agent?.status === "blocked") {
      if (stopTimer.current !== null) {
        window.clearTimeout(stopTimer.current);
        stopTimer.current = null;
      }
      return;
    }
    if (stopTimer.current !== null) return;
    // Only the part of the grace period that has not already passed, so a turn
    // that ended while the page was hidden does not replay the wait.
    const remaining = Math.max(0, GRACE_MS - (Date.now() - pendingSince.current));
    stopTimer.current = window.setTimeout(() => {
      stopTimer.current = null;
      setPendingTurn(false);
    }, remaining);
  }, [pendingTurn, agent?.status]);

  // Switching panes must not carry the affordance across.
  useEffect(() => {
    setPendingTurn(false);
    setSentMessage(null);
    if (sentExpiry.current !== null) {
      window.clearTimeout(sentExpiry.current);
      sentExpiry.current = null;
    }
  }, [paneId]);

  /*
   * Ctrl/Cmd+E opens the file palette from anywhere on this screen.
   *
   * Bound on the document rather than on a control because the point is to
   * reach a file without first finding the sidebar: the chord works while the
   * reader is in the conversation, in the tree, or in a preview. The browser's
   * own use of the chord is a keyword search, which is what this replaces, so
   * the default is prevented.
   */
  useEffect(() => {
    if (!paneId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.key !== "e" && event.key !== "E") || (!event.ctrlKey && !event.metaKey)) {
        return;
      }
      event.preventDefault();
      setSearchOpen(true);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [paneId]);

  // Track the phone breakpoint, and drop the preview when it is crossed.
  useEffect(() => {
    const query = window.matchMedia("(min-width: 60.001rem)");
    const update = () => {
      setWideLayout(query.matches);
      if (!query.matches) setPreviewPath(null);
    };
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  /*
   * A file being open narrows the conversation,  /*
   * A file being open narrows the conversation, so the panel folds to its
   * capsule for as long as the file is there — an open panel beside an open
   * file leaves neither enough room. Closing the file puts the panel back the
   * way the reader had it, unless they changed it themselves in between, in
   * which case that choice stands.
   */
  useEffect(() => {
    if (previewPath) {
      setStatusOpen((current) => {
        statusBeforePreview.current = current;
        return false;
      });
      statusToggledDuringPreview.current = false;
      return;
    }
    if (!statusToggledDuringPreview.current) {
      setStatusOpen(statusBeforePreview.current);
    }
  }, [previewPath]);

  /** The reader's own toggle, which outranks the automatic fold. */
  const toggleStatus = useCallback(
    (next: boolean) => {
      if (previewPath) statusToggledDuringPreview.current = true;
      setStatusOpen(next);
    },
    [previewPath],
  );

  /**
   * Put the caret in the composer when a conversation is opened.  /**
   * Put the caret in the composer when a conversation is opened.
   *
   * Opening an agent is almost always followed by typing at it, and having to
   * aim at the field first is a step that earns nothing. This runs on the pane
   * rather than on mount so that arriving at a different agent also lands in its
   * field.
   *
   * Two things are deliberately not focused into:
   *
   * - A field the reader has already put the caret in: taking focus away from what
   *   someone is doing is worse than the convenience.
   * - A touch device, where focusing raises the on-screen keyboard and covers the
   *   conversation the reader just opened to read.
   */
  useEffect(() => {
    if (!paneId) return;
    const field = composerRef.current;
    if (!field) return;
    if (field === document.activeElement) return;

    const activeNow = document.activeElement;
    if (
      activeNow instanceof HTMLElement &&
      (activeNow.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(activeNow.tagName))
    ) {
      return;
    }
    if (window.matchMedia("(hover: none)").matches) return;

    field.focus();
  }, [paneId]);

  // Files chosen for one agent must not be sent to another, and their object
  // URLs would otherwise leak.
  useEffect(() => {
    clearUploads();
    setLightbox(null);
    dragDepth.current = 0;
    setDragging(false);
  }, [paneId, clearUploads]);

  // Releasing on unmount needs the entries themselves, not just the setter, so
  // the latest list is read through a ref. Without this the previews of files
  // still attached when the view closes stay alive for the life of the document.
  const uploadsRef = useRef<StagedUpload[]>([]);
  uploadsRef.current = uploads;
  useEffect(
    () => () => {
      if (sentExpiry.current !== null) window.clearTimeout(sentExpiry.current);
      for (const upload of uploadsRef.current) releaseUpload(upload);
    },
    [],
  );

  /**
   * Sends the user's choices back to the agent.
   *
   * The server rejects an answer for a request that was superseded or expired,
   * so a stale panel cannot answer a question the user never saw. The error is
   * surfaced rather than swallowed.
   */
  const answerInteraction = useCallback(
    async (answers: InteractionAnswer[]) => {
      // A second submit before the first settles would name a request the server
      // already withdrew, so an answer is refused while one is in flight. The
      // panel's buttons read the same flag, but a click landing between the call
      // and the re-render would otherwise get through.
      if (!paneId || !interaction || busy || connection !== "ready") {
        throw new Error("The interaction is unavailable or the connection is not ready.");
      }
      setBusy(true);
      try {
        await client.call("pane.answer_interaction", {
          pane_id: paneId,
          request_id: interaction.requestId,
          answers,
        });
        // The request is withdrawn once answered, so drop the panel rather than
        // leaving a question the user already dealt with on screen. The server
        // also emits `pane.updated`, but refreshing here means the panel closes
        // even if that event is missed.
        setError(null);
        onChanged();
      } catch (err) {
        // Surfaced through `setError` so the panel shows it and the reader can try
        // again; the panel also renders what `onAnswer` rejects with, so both paths
        // report the same failure.
        setError(err instanceof Error ? err.message : String(err));
        throw err;
      } finally {
        // Cleared on failure too, so the reader can retry.
        setBusy(false);
      }
    },
    [client, paneId, interaction, onChanged, busy, connection],
  );

  const transcript = pages
    .map((page) => (page.endsWith("\n") ? page : `${page}\n`))
    .join("");

  /**
   * Whether a drag carries files, as opposed to text or a selection.
   *
   * Dragging a selection or a link also fires `dragover`; claiming those would
   * make the whole pane a drop target for content it cannot accept.
   */
  const dragHasFiles = (event: DragEvent) =>
    Array.from(event.dataTransfer.types).includes("Files");

  const onDragEnter = (event: DragEvent) => {
    if (!dragHasFiles(event)) return;
    // Without this the browser opens the dropped file and leaves the page.
    event.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  };

  const onDragOver = (event: DragEvent) => {
    if (!dragHasFiles(event)) return;
    event.preventDefault();
    // The default is "no drop", which also suppresses the drop event.
    event.dataTransfer.dropEffect = "copy";
  };

  const onDragLeave = (event: DragEvent) => {
    if (!dragHasFiles(event)) return;
    event.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  };

  const onDrop = (event: DragEvent) => {
    if (!dragHasFiles(event)) return;
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    void addFiles(Array.from(event.dataTransfer.files));
  };

  /**
   * Grows the composer to fit what has been typed.
   *
   * A fixed-height field shows two lines on a phone and hides the rest, which is
   * awkward for anything longer than a sentence. The height is reset before
   * measuring, because `scrollHeight` only shrinks once the element has been
   * allowed to; without the reset, deleting text would leave the box tall.
   * `max-height` in CSS caps it, after which the field scrolls.
   *
   * The floor is a dependency because a drag changes it: the measurement below is
   * taken while the floor is holding the field open, so without a re-run the
   * height some previous floor produced would outlive it and dragging the field
   * back down would appear to do nothing.
   */
  useEffect(() => {
    const field = composerRef.current;
    if (!field) return;
    field.style.height = "auto";
    // `scrollHeight` covers the content box plus padding but never the border,
    // and the field is `border-box`. Leaving the border out of the sum makes
    // the computed height two pixels short, which is enough to pin a scrollbar
    // to the field even when it holds a single line — and the scrollbar keeps
    // `scrollHeight` where it was, so the field never recovers on its own.
    const border = field.offsetHeight - field.clientHeight;
    field.style.height = `${field.scrollHeight + border}px`;
  }, [draft, fieldFloor]);

  /**
   * The smallest the field is ever drawn: the CSS floor for a single line.
   *
   * The ceiling is read from the element's own `max-height` instead, so the
   * upper bound keeps one source of truth. Both matter because a floor above
   * the ceiling would win — CSS resolves that conflict in the floor's favour —
   * and the field would then grow without ever reaching its scroll ceiling.
   */
  const COMPOSER_FLOOR_PX = 40;

  /**
   * Resizes the field by dragging the card's top edge.
   *
   * The pointer is captured for the whole gesture: without it, a drag that left
   * the strip would begin selecting the text underneath and the field would stop
   * following the hand mid-resize.
   */
  const startComposerResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const field = composerRef.current;
    if (!field) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    // Capture keeps the gesture when the pointer leaves the strip. It can fail —
    // a pointer already gone, or an event no browser is tracking — and that is
    // not worth abandoning the resize over: without capture the drag still works
    // while the pointer stays on the strip.
    try {
      handle.setPointerCapture(pointerId);
    } catch {
      // The gesture continues uncaptured.
    }
    const startY = event.clientY;
    const startHeight = field.offsetHeight;
    const ceiling = Number.parseFloat(window.getComputedStyle(field).maxHeight);
    const ceilingPx = Number.isFinite(ceiling) ? ceiling : 160;

    const onMove = (move: PointerEvent) => {
      // The handle rides the top edge, so moving up is taller: the distance
      // travelled is subtracted from the height the gesture began at.
      const next = startHeight - (move.clientY - startY);
      setFieldFloor(Math.min(ceilingPx, Math.max(COMPOSER_FLOOR_PX, next)));
    };
    const onEnd = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onEnd);
      handle.removeEventListener("pointercancel", onEnd);
      if (handle.hasPointerCapture(pointerId)) {
        try {
          handle.releasePointerCapture(pointerId);
        } catch {
          // Nothing left to release.
        }
      }
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onEnd);
    handle.addEventListener("pointercancel", onEnd);
  };

  /** The passages quoted out of the conversation, to be sent with the prompt. */
  const [quotes, setQuotes] = useState<QuoteState>(NO_QUOTES);

  /**
   * The file the agent records this conversation in, as the conversation view sees
   * it while reading. Absent until a session is read, and never reported for a
   * session an agent keeps in a store, which has no file of its own.
   */
  const [sessionFile, setSessionFile] = useState<{ path: string; sizeBytes?: number } | null>(null);
  /** Set while the server is being asked for a download link. */
  const [downloading, setDownloading] = useState(false);
  /**
   * Whether this pane is drawn as a terminal rather than as its conversation.
   *
   * `null` means the reader has not said, and the pane decides: a pane with no
   * agent is a shell, and the only thing worth showing for a shell is the terminal
   * itself. The toggle exists because the raw screen is sometimes what you want
   * from an agent pane too.
   */
  const [terminalOpen, setTerminalOpen] = useState<boolean | null>(null);
  /** Set while a shell is being created, so one tap cannot ask for two. */
  const [shellBusy, setShellBusy] = useState(false);
  /** Whether the scheduled-prompt panel is open. */
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const showTerminal = terminalOpen ?? agent === null;

  /*
   * Stable, and that is load-bearing: the conversation view reports through the
   * reader's effect, which reloads the conversation whenever it re-runs. The
   * equality check keeps a refresh with an unchanged size from re-rendering at all.
   */
  const onSessionInfo = useCallback((info: { path: string; sizeBytes?: number }) => {
    setSessionFile((current) =>
      current && current.path === info.path && current.sizeBytes === info.sizeBytes ? current : info,
    );
  }, []);

  /**
   * Saves a copy of the session file the agent is keeping.
   *
   * The link, not the bytes: a session is routinely tens of megabytes, and the
   * gateway serves the file from disk, so nothing that size passes through the
   * socket or ends up as a string here. The server publishes it under a name that
   * cannot be guessed, because a download cannot carry the gateway's key.
   */
  /**
   * Opens a shell and goes to it.
   *
   * The shell is a real pane in a real workspace, started by the server, so it can
   * be typed into from here and also left alone in the TUI. It goes to its own
   * workspace rather than beside this conversation, because a pane's size is shared
   * by every viewer of it, and the browser has no business resizing a pane the
   * terminal is also laying out.
   */
  const openShell = async () => {
    if (shellBusy) return;
    setShellBusy(true);
    try {
      const pane = await createShellPane(client, agent?.cwd ?? null);
      if (!pane) {
        setError("新建 Shell 失败：后端没有返回 pane。");
        return;
      }
      setTerminalOpen(true);
      // Another pane is another screen, so this one is left rather than repainted:
      // the route is what decides which pane is showing.
      onOpenPane(pane);
    } finally {
      setShellBusy(false);
    }
  };

  const downloadSession = async () => {
    if (!paneId || downloading) return;
    setDownloading(true);
    try {
      const envelope = await client.call<{ download?: { url: string; name: string } }>(
        "pane.session_download",
        { pane_id: paneId },
      );
      const link = envelope.download;
      if (!link) throw new Error("the server returned no download link");
      const anchor = document.createElement("a");
      anchor.href = link.url;
      // The served name is random; this is the name the file has on disk.
      anchor.download = link.name;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDownloading(false);
    }
  };

  /**
   * Attaches a passage the reader quoted to the prompt.
   *
   * To the chip above the field rather than into the field itself: the passage is
   * context the reader referred to, not text they meant to write, and a quote
   * inside the draft would have to be deleted by hand and could be edited into
   * something else on the way. The field still takes focus afterwards, because
   * asking the question about the passage is the next thing they do.
   */
  const takeQuote = useCallback((text: string, source: QuoteSource) => {
    setQuotes((current) => addQuote(current, newQuote(text, source)));
    window.requestAnimationFrame(() => composerRef.current?.focus());
  }, []);

  // The list belongs to the agent and is read back from its transcript, so it
  // is refreshed on a slow timer while the agent runs and left alone once it
  // settles. An agent that keeps no list simply returns nothing to show.
  useEffect(() => {
    if (!paneId) return;
    let cancelled = false;
    const tick = () => {
      void loadTodos(client, paneId).then((next) => {
        if (!cancelled) setTodos(next);
      });
    };
    tick();
    const timer = agent?.status === "working" ? setInterval(tick, TODO_POLL_MS) : undefined;
    return () => {
      cancelled = true;
      if (timer !== undefined) clearInterval(timer);
    };
  }, [client, paneId, agent?.status]);

  // Subagent runs come from the extension's own state, which it prunes once a
  // run settles, so this refreshes on the same slow timer and simply finds
  // nothing when the runs are gone.
  useEffect(() => {
    if (!paneId) return;
    let cancelled = false;
    const tick = () => {
      void loadSubagents(client, paneId).then((next) => {
        if (!cancelled) setSubagents(next);
      });
    };
    tick();
    const timer = agent?.status === "working" ? setInterval(tick, SUBAGENT_POLL_MS) : undefined;
    return () => {
      cancelled = true;
      if (timer !== undefined) clearInterval(timer);
    };
  }, [client, paneId, agent?.status]);

  // A running agent can always be interrupted, whether or not this page started
  // the turn. The state comes from detection rather than from the send, so
  // opening an agent someone else started still offers the stop control. A
  // pending turn is included because detection lags a moment behind a send.
  const canStop = agent?.status === "working" || pendingTurn;

  return (
    <div
      className={`detail-screen${dragging ? " dragging" : ""}`}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {/*
        The project's files are the screen's left column, beside the header and
        the composer rather than inside the conversation: the sidebar owns the
        full height of the window, which is what makes it a sidebar.
      */}
      <FileTreePanel
        client={client}
        paneId={paneId ?? ""}
        cwd={agent?.cwd ?? ""}
        onOpenFile={setPreviewPath}
      />
      {settingsOpen ? (
        <SettingsPanel
          onClose={() => setSettingsOpen(false)}
          onCommandsSaved={() => setCustomCommands(loadCustomCommands())}
          skills={wideLayout && paneId ? { client, paneId } : undefined}
        />
      ) : null}
      <div className="detail-main">
      <header className="topbar">
        <button type="button" className="ghost" onClick={onBack} aria-label="Back">
          ‹
        </button>
        <BackendBadge name={backend.name} url={backend.url} />
        {/*
          The conversation's identity, over the two facts it no longer spells
          out. See `AgentIdentity` for why the name and the panel are shaped the
          way they are.
        */}
        <AgentIdentity agent={agent} />
        <AgentSwitcher
          agents={switchableAgents}
          current={agent?.paneId ?? null}
          currentBackendId={backend.id}
          onSelect={onSelectAgent}
        />
        {sessionFile?.sizeBytes !== undefined ? (
          /*
           * The session's own file: how large the record has grown, and a way to
           * take a copy of it. It sits with the controls that are about the
           * session rather than in the conversation's header, which is about the
           * turns.
           */
          <div className="session-file">
            <span className="session-file__size" title={sessionFile.path}>
              {formatBytes(sessionFile.sizeBytes)}
            </span>
            <button
              type="button"
              className="ghost session-file__download"
              disabled={downloading}
              onClick={() => void downloadSession()}
              aria-label="下载当前会话"
              title="下载当前会话（原始会话文件）"
            >
              <Download size={15} aria-hidden="true" />
            </button>
          </div>
        ) : null}
        {/*
          The pane as a terminal, and a way to open another. Both are about the pane
          rather than the conversation, so they sit with the session's own controls
          instead of in the conversation's header.
        */}
        {/*
          Timed prompts: made here because the pane is what they talk to, and
          listed here because a task nobody is watching is the point of one.
        */}
        <button
          type="button"
          className="ghost"
          onClick={() => setScheduleOpen(true)}
          aria-label="定时任务"
          title="定时任务（到点给这个 agent 发提示词）"
        >
          <AlarmClock size={15} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={`ghost terminal-toggle${showTerminal ? " terminal-toggle--on" : ""}`}
          onClick={() => setTerminalOpen(!showTerminal)}
          aria-pressed={showTerminal}
          aria-label="终端"
          title={showTerminal ? "隐藏终端" : "以终端方式查看并操作此 pane"}
        >
          <Terminal size={15} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="ghost"
          onClick={() => void openShell()}
          disabled={shellBusy}
          aria-label="新建 Shell"
          title="新建 Shell（在 shell 工作区）"
        >
          <SquareTerminal size={15} aria-hidden="true" />
        </button>
        <ThemeToggle />
        <button
          type="button"
          className="ghost settings-toggle"
          onClick={() => setSettingsOpen(true)}
          aria-label="Open settings"
          title="设置"
        >
          <Settings size={15} aria-hidden="true" />
        </button>
        <ConnectionBadge state={connection} onRetry={onRetry} />
        <span className={`dot ${agent?.status ?? "unknown"}`} aria-label={statusLabel(agent?.status ?? "unknown")} />
      </header>

      {error ? <p className="error banner">{error}</p> : null}

      {/*
        Structured requests take priority. Codex terminal controls require an
        explicit action when a structured question is unavailable; other agents
        keep their existing terminal controls.
      */}
      {interaction && interaction.kind !== "notice" ? (
        <InteractionPanel key={`${paneId}:${interaction.source}:${interaction.requestId}`}
          request={interaction} busy={busy} disconnected={connection !== "ready"}
          onAnswer={answerInteraction} />
      ) : blocked || interaction?.kind === "notice" ? (
        <CodexInteractionNotice key={`${paneId}:${agent?.agent}`}
          message={interaction?.kind === "notice" ? interaction.summary : undefined}
          enabled={agent?.agent === "codex" || interaction?.kind === "notice"} disconnected={connection !== "ready"}>
          <div className="blocker">
            <div className="blocker-head">
              <span className="blocker-label">waiting for you</span>
              <span className="blocker-hint">press what the agent is asking for</span>
            </div>
            {blockerText ? <pre className="blocker-text">{blockerText}</pre> : null}
            <div className="blocker-keys">
              {BLOCKER_KEY_GROUPS.map((group, index) => (
                <div className="blocker-key-group" key={index}>
                  {group.map((key) => (
                    <button
                      type="button"
                      key={key.label}
                      className={`key ${key.variant ?? ""}`}
                      title={key.title}
                      disabled={busy || connection !== "ready"}
                      onClick={() => void sendKeys(key.keys)}
                    >
                      {key.label}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </CodexInteractionNotice>
      ) : null}

      {/*
        The agent's own account of the conversation is the primary view — a
        transcript file, or a store it keeps its sessions in. The rendered pane is
        only a fallback: it is what the agent is painting on screen, which for a
        TUI agent is chrome and redraws rather than the conversation. An agent
        with neither still shows something rather than an empty panel.
      */}
      {showTerminal ? (
        /*
         * A terminal, not a picture of one: the same bytes the process wrote are
         * drawn here by a terminal emulator, and what is typed goes back as bytes.
         */
        /*
         * After the pane is gone the route names a pane that no longer exists, so
         * closing also leaves the screen for the session's list.
         */
        <TerminalView client={client} paneId={paneId ?? ""} onClose={onBack} />
      ) : hasConversation ? (
        <ConversationView
          client={client}
          paneId={paneId ?? ""}
          label={agent?.label ?? "agent"}
          sentMessage={sentMessage}
          working={agent?.status === "working"}
          onPreviewImage={setLightbox}
          onQuote={takeQuote}
          onSessionInfo={onSessionInfo}
          status={
            <StatusPanel
              todos={todos}
              runs={subagents.runs.filter(isRunning)}
              open={statusOpen}
              onToggle={toggleStatus}
              onOpenSubagents={() => setDrawerOpen(true)}
            />
          }
          load={<ServerLoadBar client={client} />}
          subagents={subagents.runs}
          onOpenSubagents={() => setDrawerOpen(true)}
        />
      ) : awaitingConversation ? (
        <div className="conversation-wrap" role="status">
          <div className="conversation">
            <p className="pager">会话已识别，正在等待可读取的会话记录。</p>
            <p className="pager">新会话尚无记录时，可以先发送消息；记录就绪后会自动显示在这里。</p>
          </div>
        </div>
      ) : (
        <div className="transcript" ref={transcriptRef} onScroll={onScroll}>
          {loadingOlder ? <p className="pager">loading earlier output…</p> : null}
          {exhausted && pages.length > 1 ? <p className="pager">start of history</p> : null}
          <pre>{transcript || "waiting for output…"}</pre>
          {/*
            A pane shown as terminal text quotes the same way: the reader is
            looking at output either way, and the menu anchors to what is on screen
            rather than to a turn, which this fallback view does not have.
          */}
          <SelectionQuoteMenu root={transcriptRef} onQuote={takeQuote} />
        </div>
      )}

      <form
        className={`composer${tall ? " composer--tall" : ""}`}
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        {/*
          Pending files sit above the field, inside the composer, so they move
          with it rather than scrolling away with the conversation.
        */}
        <PendingUploads
          uploads={uploads}
          busy={busy || preparing}
          onRemove={removeUpload}
          onPreview={setLightbox}
        />
        <QuoteChips
          state={quotes}
          onRemove={(id) => setQuotes((current) => removeQuote(current, id))}
          onRemoveAll={() => setQuotes(NO_QUOTES)}
        />
        <div className="composer-row">
          {tall ? (
            /*
             * The drag strip, riding the card's top border. Offered only while
             * the field is expanded: a one-line card has nothing worth resizing,
             * and an invisible target over its border would swallow presses
             * meant for whatever sits above it.
             */
            <div
              className="composer-row__resize"
              role="separator"
              aria-orientation="horizontal"
              aria-label="拖动调整输入框高度"
              title="拖动调整输入框高度"
              onPointerDown={startComposerResize}
            />
          ) : null}
          {/*
            The card is a column: the field on top, then a fixed row of controls
            — attach at its start, send at its end, ZCode's own arrangement. The
            buttons keep one place instead of riding up with a growing field.
          */}
          <div className="composer-field">
            <ComposerInput
              client={client}
              paneId={paneId ?? ""}
              draft={draft}
              onChange={setDraft}
              fieldRef={composerRef}
              minHeight={fieldFloor ?? undefined}
              onHistoryKey={inputHistory.onKeyDown}
              historyError={inputHistory.error}
              slash={{
                open: slashMenuOpen,
                menu: slashMenu,
                highlighted: highlightedSlash,
                onIndexChange: setSlashIndex,
                onChooseItem: chooseSlashItem,
                onChooseSkill: chooseSlashSkill,
                onDismiss: () => setSlashDismissed(true),
              }}
              onFiles={(files) => { void addFiles(files); }}
              onSend={() => { void send(); }}
            />
            {/*
              Hidden rather than styled away: the visible control below is the
              affordance, and a second one would do the same thing twice.
            */}
            <input
              ref={fileInputRef}
              className="attach-input"
              type="file"
              multiple
              onChange={(event) => {
                const files = Array.from(event.target.files ?? []);
                // Cleared so choosing the same file twice still fires a change.
                event.target.value = "";
                void addFiles(files);
              }}
            />
          </div>
          <div className="composer-actions">
            <button
              type="button"
              className="attach"
              disabled={busy || preparing}
              aria-label="Attach files"
              title="Attach files"
              onClick={() => fileInputRef.current?.click()}
            >
              <Plus size={18} aria-hidden="true" />
            </button>
            {/*
              The reader decides how much room the field starts with: one line
              by default, three when there is a longer message to lay out. The
              text grows the field either way; this only moves the floor.
            */}
            <div className="composer-actions__end">
              <AgentModelPicker
                client={client}
                paneId={paneId ?? ""}
                agent={agent?.agent}
                hasConversation={agent?.hasConversation ?? false}
                onSwitched={onChanged}
              />
              <button
                type="button"
                className="expand"
                aria-label={tall ? "缩小输入框" : "放大输入框"}
                title={tall ? "缩小输入框" : "放大输入框"}
                onClick={() => setTall((value) => !value)}
              >
                {tall ? (
                  <Minimize2 size={16} aria-hidden="true" />
                ) : (
                  <Maximize2 size={16} aria-hidden="true" />
                )}
              </button>
              {canStop ? (
                <button
                  type="button"
                  className="stop"
                  disabled={busy}
                  aria-label="Stop the agent"
                  title="Stop the agent (sends Esc)"
                  onClick={() => void interrupt()}
                >
                  <Square size={16} strokeWidth={2.5} fill="currentColor" aria-hidden="true" />
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={
                    busy || preparing || (!draft.trim() && uploads.length === 0 && !quotes.quotes.length)
                  }
                  aria-label="Send"
                >
                  <ArrowUp size={16} strokeWidth={1.5} aria-hidden="true" />
                </button>
              )}
            </div>
          </div>
        </div>
      </form>
      </div>

      {/*
        The file being previewed, as the screen's last column: the conversation
        keeps half the width and the file takes the other half, the split ZCode
        uses for a side-by-side editor.
      */}
      {previewPath && paneId && wideLayout ? (
        <FilePreview
          client={client}
          paneId={paneId}
          path={previewPath}
          onClose={() => setPreviewPath(null)}
        />
      ) : null}

      {searchOpen && paneId ? (
        <FileSearchPalette
          client={client}
          paneId={paneId}
          onOpen={setPreviewPath}
          onClose={() => setSearchOpen(false)}
        />
      ) : null}

      {/*
        The enlarged view. Rendered as an overlay rather than a new tab so the
        conversation stays where it was, and dismissed by a tap anywhere.
      */}
      {lightbox ? (
        <ImageViewer url={lightbox} alt="" onClose={() => setLightbox(null)} />
      ) : null}

      {drawerOpen && subagents.runs.length > 0 ? (
        <SubagentDrawer runs={subagents.runs} onClose={() => setDrawerOpen(false)} />
      ) : null}

      {/*
        Last in the document so it needs no stacking contest: the cycle covers
        the whole page, including the file tree and any drawer already open.
      */}
      {scheduleOpen ? (
        <SchedulePanel
          client={client}
          agents={agents}
          currentPaneId={paneId}
          onClose={() => setScheduleOpen(false)}
        />
      ) : null}

      {cycle ? (
        <AgentCycleOverlay
          cycle={cycle}
          currentPaneId={paneId}
          currentBackendId={backend.id}
        />
      ) : null}
    </div>
  );
}

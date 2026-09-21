import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import type { Subscription, ConnectionState } from "./gateway";
import { ConnectionBadge } from "./ConnectionBadge";
import { HISTORY_PAGE_LINES, shortenPath, statusLabel, paneIdOfEvent, type AgentView } from "./api";
import { ConversationView } from "./ConversationView";
import { InteractionPanel } from "./InteractionPanel";
import type { InteractionAnswer } from "./interaction";
import { Plus, Square } from "lucide-react";
import { AgentIcon } from "./AgentIcon";
import { AgentSwitcher } from "./AgentSwitcher";
import { PendingUploads } from "./PendingUploads";
import { TodoPanel } from "./TodoPanel";
import { SubagentBar, SubagentDrawer } from "./SubagentBar";
import { SUBAGENT_POLL_MS, loadSubagents, type SubagentRun } from "./subagents";
import { TODO_POLL_MS, loadTodos, type TodoItem } from "./todos";
import { ThemeToggle } from "./ThemeToggle";
import {
  fileToBase64,
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
  connection,
  onRetry,
  onSelectAgent,
}: {
  agent: AgentView | null;
  agents: AgentView[];
  onBack: () => void;
  client: DetailClient;
  onChanged: () => void;
  connection: ConnectionState;
  onRetry: () => void;
  onSelectAgent: (paneId: string) => void;
}) {
  // Oldest page first, so prepending older pages does not disturb scroll.
  const [pages, setPages] = useState<string[]>([]);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const [draft, setDraft] = useState("");
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

  const paneId = agent?.paneId ?? null;
  const blocked = agent?.status === "blocked";
  /**
   * The agent's structured question, when it publishes one.
   *
   * Preferred over the terminal panel: the options come from the agent's own
   * protocol, so answering cannot pick a different option than the one shown.
   */
  const interaction = agent?.interaction ?? null;
  const transcriptPath = agent?.transcriptPath ?? null;
  // Read inside the subscription callback, which is created once per pane and
  // would otherwise capture a stale `blocked` value.
  const blockedRef = useRef(false);
  blockedRef.current = blocked;
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const nextOffset = useRef(0);
  const pinnedToBottom = useRef(true);

  // `pane.updated` is chatty and fires while the pane sits idle, so coalesce
  // refreshes instead of re-reading page 0 on every event.
  const refreshTimer = useRef<number | null>(null);
  const inFlight = useRef(false);
  const stopTimer = useRef<number | null>(null);

  /**
   * Replaces the newest page with fresh output.
   *
   * Only the fallback view reads the rendered pane. When the agent publishes a
   * transcript the conversation view owns the content, and reading the screen
   * would be both wasted work and a failure on a pane with no live runtime.
   * The check lives here so no caller has to remember it.
   */
  const refreshNewest = useCallback(async () => {
    if (!paneId || inFlight.current || agent?.transcriptPath) return;
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
  }, [client, paneId, agent?.transcriptPath]);

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
    if (!paneId || busy) return;
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
    const message = draft.trim();
    // A file with no message is a normal thing to send, so the composer is not
    // required to contain text when something is attached.
    if (!paneId || (!message && uploads.length === 0) || busy || preparing) return;
    setBusy(true);
    try {
      const pasted = await uploadFiles();
      const text = [message, ...pasted].filter((part) => part.length > 0).join("\n");
      // The files are only dropped once the message is away: an upload that
      // succeeded must not leave a copy behind, and a send that failed must not
      // take the user's files with it.
      await client.call("pane.send_input", { pane_id: paneId, text, keys: ["Enter"] });
      clearUploads();
      setDraft("");
      setError(null);
      setPendingTurn(true);
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
    stopTimer.current = window.setTimeout(() => {
      stopTimer.current = null;
      setPendingTurn(false);
    }, 1500);
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
      if (!paneId || !interaction) return;
      await client.call("pane.answer_interaction", {
        pane_id: paneId,
        request_id: interaction.requestId,
        answers,
      });
      // The request is withdrawn once answered, so drop the panel rather than
      // leaving a question the user already dealt with on screen. The server
      // also emits `pane.updated`, but refreshing here means the panel closes
      // even if that event is missed.
      onChanged();
    },
    [client, paneId, interaction, onChanged],
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
  }, [draft]);

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
      <header className="topbar">
        <button type="button" className="ghost" onClick={onBack} aria-label="Back">
          ‹
        </button>
        <div className="topbar-title">
          <span className="title">{agent?.label ?? "agent"}</span>
          <span className="subtitle">
            {agent?.project ?? ""} {agent?.cwd ? `· ${shortenPath(agent.cwd)}` : ""}
          </span>
          {/*
            The session id identifies the agent's own session rather than the
            pane: a pane is replaced when a session is resumed elsewhere, and
            this is the value that follows the conversation across them.
          */}
          {agent?.sessionId ? (
            <span className="session-id" title="Agent session id">
              {agent.sessionId}
            </span>
          ) : null}
        </div>
        {/*
          The agent behind this pane, next to the controls that act on it. An
          agent with no mark renders nothing and the cluster closes up.
        */}
        <AgentIcon agent={agent?.agent} size={18} />
        <AgentSwitcher
          agents={agents}
          current={agent?.paneId ?? null}
          onSelect={onSelectAgent}
        />
        <ThemeToggle />
        <ConnectionBadge state={connection} onRetry={onRetry} />
        <span className={`dot ${agent?.status ?? "unknown"}`} aria-label={statusLabel(agent?.status ?? "unknown")} />
      </header>

      {error ? <p className="error banner">{error}</p> : null}

      {/*
        Two ways to answer, in order of how much the agent told us.

        An agent that publishes a structured request gets the options it
        actually offered, so answering is one tap. An agent that only reports
        state falls back to the pane text and a raw key bar: the reader still
        reads the prompt themselves, but nothing is guessed on their behalf.
      */}
      {interaction ? (
        <InteractionPanel request={interaction} busy={busy} onAnswer={answerInteraction} />
      ) : blocked ? (
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
                    disabled={busy}
                    onClick={() => void sendKeys(key.keys)}
                  >
                    {key.label}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {/*
        The agent's own transcript is the primary view. The rendered pane is
        only a fallback: it is what the agent is painting on screen, which for a
        TUI agent is chrome and redraws rather than the conversation. Agents that
        publish a transcript path get the structured view; the rest still show
        something rather than an empty panel.
      */}
      {transcriptPath ? (
        <ConversationView
          client={client}
          paneId={paneId ?? ""}
          label={agent?.label ?? "agent"}
          sentMessage={sentMessage}
          working={agent?.status === "working"}
          onPreviewImage={setLightbox}
        />
      ) : (
        <div className="transcript" ref={transcriptRef} onScroll={onScroll}>
          {loadingOlder ? <p className="pager">loading earlier output…</p> : null}
          {exhausted && pages.length > 1 ? <p className="pager">start of history</p> : null}
          <pre>{transcript || "waiting for output…"}</pre>
        </div>
      )}

      {/*
        The todo list sits directly above the composer, the same place the CLI
        puts it, so it stays visible while reading without displacing the input.
      */}
      <TodoPanel todos={todos} />
      <SubagentBar
        active={subagents.active}
        runs={subagents.runs}
        onOpen={() => setDrawerOpen(true)}
      />

      <form
        className="composer"
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
        <div className="composer-row">
          {/*
            The field and the attach button share one box so the button can float
            on the field's own corner: attaching belongs to the message being
            written, and the row's own end is the send action.
          */}
          <div className="composer-field">
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Send a message…"
              rows={1}
              ref={composerRef}
              onPaste={(event) => {
                const files = Array.from(event.clipboardData?.files ?? []);
                if (files.length === 0) return;
                // Only intercepted when the clipboard actually holds files, so
                // pasting text keeps its default behaviour. The clipboard is read
                // from the event rather than `navigator.clipboard`, which needs a
                // secure context this UI does not have on a LAN address.
                event.preventDefault();
                void addFiles(files);
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();

                // Ctrl/Cmd+Enter breaks the line, so a message can be laid out
                // before it is sent. The browser has no default newline for that
                // combination, so the break is inserted here: `setRangeText`
                // leaves the caret after it and fires the input event React
                // reads, which keeps the field controlled.
                if (event.ctrlKey || event.metaKey) {
                  const field = event.currentTarget;
                  field.setRangeText(
                    "\n",
                    field.selectionStart,
                    field.selectionEnd,
                    "end",
                  );
                  return;
                }

                void send();
              }}
            />
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
              Hidden rather than styled away: a visible control would be a second
              way to do the same thing, and the button above is the affordance.
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
          {canStop ? (
            <button
              type="button"
              className="stop"
              disabled={busy}
              aria-label="Stop the agent"
              title="Stop the agent (sends Esc)"
              onClick={() => void interrupt()}
            >
              <Square size={16} strokeWidth={0} fill="currentColor" aria-hidden="true" />
            </button>
          ) : (
            <button
              type="submit"
              disabled={busy || preparing || (!draft.trim() && uploads.length === 0)}
              aria-label="Send"
            >
              ↑
            </button>
          )}
        </div>
      </form>

      {/*
        The enlarged view. Rendered as an overlay rather than a new tab so the
        conversation stays where it was, and dismissed by a tap anywhere.
      */}
      {lightbox ? (
        <div
          className="lightbox"
          role="dialog"
          aria-label="Image preview"
          onClick={() => setLightbox(null)}
        >
          <img src={lightbox} alt="" />
        </div>
      ) : null}

      {drawerOpen && subagents.runs.length > 0 ? (
        <SubagentDrawer runs={subagents.runs} onClose={() => setDrawerOpen(false)} />
      ) : null}
    </div>
  );
}

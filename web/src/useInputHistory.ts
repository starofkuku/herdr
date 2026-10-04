import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { loadConversation } from "./conversation";
import type { MentionClient } from "./fileMentions";

interface Options {
  client: MentionClient;
  paneId: string | null;
  sessionId?: string;
  readable: boolean;
  onChange: (text: string) => void;
}

/** Newest first; only adjacent duplicates represent the same history step. */
function appendMessages(history: string[], messages: string[]) {
  for (const text of messages) {
    if (text.trim() && history[history.length - 1] !== text) history.push(text);
  }
}

interface HistoryState {
  messages: string[];
  recent: string[];
  cursor: number | undefined;
  loaded: boolean;
  more: boolean;
  busy: boolean;
  index: number;
  draft: string;
  shown: string;
  revision: number;
}
interface Navigation {
  state: HistoryState;
  options: Options;
  isActive: () => boolean;
  setError: (error: string | null) => void;
}

async function loadPage(context: Navigation) {
  const { state, options: { paneId, readable, client }, isActive } = context;
  if (!paneId || !readable || !state.more) return;
  const revision = state.revision;
  const page = await loadConversation(client, paneId, { cursor: state.cursor });
  if (!isActive() || revision !== state.revision) return;
  const messages = [...page.turns].reverse().map((turn) => turn.user_message ?? "");
  if (!state.loaded) {
    // A successful send may not have reached the transcript on the first read.
    const overlap = state.recent.indexOf(messages.find((text) => text.trim()) ?? "");
    state.messages = overlap >= 0 ? state.recent.slice(0, overlap) : [...state.recent];
  }
  appendMessages(state.messages, messages);
  state.loaded = true;
  const next = page.pagination?.next_cursor;
  state.more = !!page.pagination?.has_more && next !== undefined && next !== state.cursor;
  state.cursor = next;
}

async function navigate(context: Navigation, direction: number, field: HTMLTextAreaElement) {
  const { state, options: { readable, onChange }, isActive, setError } = context;
  if (state.busy) return;
  if (state.index >= 0 && field.value !== state.shown) state.index = -1;
  if (state.index < 0) {
    if (direction < 0) return;
    state.draft = field.value;
    if (readable) { state.loaded = false; state.more = true; state.cursor = undefined; }
  }
  const before = field.value;
  const revision = state.revision;
  const target = state.index + direction;
  state.busy = true;
  setError(null);
  try {
    if (!state.loaded && readable) await loadPage(context);
    while (isActive() && revision === state.revision
      && target >= state.messages.length && state.more && readable) await loadPage(context);
    if (!isActive() || revision !== state.revision || field.value !== before
      || document.activeElement !== field || field.selectionStart !== 0 || field.selectionEnd !== 0) return;
    if (target >= state.messages.length) return;
    state.index = target;
    state.shown = target < 0 ? state.draft : state.messages[target];
    onChange(state.shown);
    requestAnimationFrame(() => {
      if (isActive() && field.value === state.shown) field.setSelectionRange(0, 0);
    });
  } catch (err) {
    if (isActive()) setError(`读取输入历史失败：${err instanceof Error ? err.message : String(err)}`);
  } finally {
    state.busy = false;
  }
}

export function useInputHistory(options: Options) {
  const { client, paneId, sessionId } = options;
  const [error, setError] = useState<string | null>(null);
  const state = useMemo(() => ({
    messages: [] as string[], recent: [] as string[], cursor: undefined as number | undefined,
    loaded: false, more: true, busy: false, index: -1, draft: "", shown: "", revision: 0,
  }), [client, paneId, sessionId]);
  const active = useRef(state);
  active.current = state;
  useEffect(() => setError(null), [state]);

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing || event.keyCode === 229 || event.altKey || event.ctrlKey
      || event.metaKey || event.shiftKey || !["ArrowUp", "ArrowDown"].includes(event.key)) return false;
    const field = event.currentTarget;
    if (field.selectionStart !== 0 || field.selectionEnd !== 0) return false;
    if (event.key === "ArrowDown" && state.index < 0) return false;
    event.preventDefault();
    void navigate({ state, options, isActive: () => active.current === state, setError }, event.key === "ArrowUp" ? 1 : -1, field);
    return true;
  }

  function record(text: string) {
    if (!text.trim()) return;
    state.revision += 1;
    if (state.recent[0] !== text) state.recent.unshift(text);
    state.messages = [...state.recent];
    state.loaded = false;
    state.more = true;
    state.cursor = undefined;
    state.index = -1;
    setError(null);
  }

  return { onKeyDown, record, error };
}

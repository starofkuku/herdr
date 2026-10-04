import { useEffect, useId, useState, type KeyboardEvent, type RefObject } from "react";
import { fileMentionAt, insertFileMention, type MentionClient } from "./fileMentions";
import type { FileEntry } from "./files";
import { useFileMentionSearch } from "./useFileMentionSearch";

interface MentionOptions {
  client: MentionClient;
  paneId: string;
  draft: string;
  onChange: (text: string) => void;
  fieldRef: RefObject<HTMLTextAreaElement>;
}

function useMentionTrigger(draft: string, paneId: string) {
  const [focused, setFocused] = useState(false);
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const [dismissed, setDismissed] = useState<string | null>(null);
  const mention = focused ? fileMentionAt(draft, selection.start, selection.end) : null;
  const key = mention ? `${paneId}:${mention.start}:${mention.query}` : null;
  const open = !!paneId && key !== null && key !== dismissed;
  const syncSelection = (field: HTMLTextAreaElement) => {
    setSelection({ start: field.selectionStart, end: field.selectionEnd });
  };
  useEffect(() => { if (key === null) setDismissed(null); }, [key]);
  const moveCaret = (caret: number) => setSelection({ start: caret, end: caret });
  return { mention, open, syncSelection, moveCaret, setFocused, dismiss: () => setDismissed(key) };
}

function handleMentionKey(
  event: KeyboardEvent<HTMLTextAreaElement>, matches: FileEntry[], selected: number,
  setSelected: (update: (index: number) => number) => void,
  choose: (entry: FileEntry) => void, dismiss: () => void,
) {
  if (event.nativeEvent.isComposing || event.keyCode === 229) return true;
  if (event.key === "Escape") {
    event.preventDefault(); event.stopPropagation(); dismiss(); return true;
  }
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    if (matches.length) setSelected((index) =>
      (index + (event.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length);
    return true;
  }
  if (event.key === "Enter" || event.key === "Tab") {
    // An unfinished reference must not accidentally submit while loading or empty.
    event.preventDefault();
    const entry = matches[selected];
    if (entry) choose(entry);
    return true;
  }
  return false;
}

export function useFileMentions({ client, paneId, draft, onChange, fieldRef }: MentionOptions) {
  const trigger = useMentionTrigger(draft, paneId);
  const query = trigger.mention?.query ?? "";
  const search = useFileMentionSearch(client, paneId, query, trigger.open);
  const [index, setIndex] = useState(0);
  const listId = useId();
  useEffect(() => { setIndex(0); }, [query, paneId, trigger.open]);
  const selected = Math.max(0, Math.min(index, search.matches.length - 1));
  const choose = (entry: FileEntry) => {
    if (!trigger.mention) return;
    const next = insertFileMention(draft, trigger.mention, entry);
    trigger.dismiss();
    trigger.moveCaret(next.caret);
    onChange(next.text);
    requestAnimationFrame(() => {
      const field = fieldRef.current;
      if (!field) return;
      field.focus();
      field.setSelectionRange(next.caret, next.caret);
      trigger.syncSelection(field);
    });
  };
  return {
    ...trigger, ...search, listId, selected, setSelected: setIndex, choose,
    onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => trigger.open
      && handleMentionKey(event, search.matches, selected, setIndex, choose, trigger.dismiss),
  };
}

export type FileMentionController = ReturnType<typeof useFileMentions>;

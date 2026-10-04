import type { KeyboardEvent, RefObject } from "react";
import { FileMentionMenu } from "./FileMentionMenu";
import type { MentionClient } from "./fileMentions";
import { handleSlashKey, SlashMenu, type SlashMenuState } from "./SlashMenu";
import { useFileMentions } from "./useFileMentions";

interface ComposerInputProps {
  client: MentionClient;
  paneId: string;
  draft: string;
  onChange: (text: string) => void;
  fieldRef: RefObject<HTMLTextAreaElement>;
  slash: SlashMenuState;
  onFiles: (files: File[]) => void;
  onSend: () => void;
  onHistoryKey: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  historyError: string | null;
}

function handleComposerEnter(event: KeyboardEvent<HTMLTextAreaElement>, props: ComposerInputProps) {
  if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
  event.preventDefault();
  if (event.ctrlKey || event.metaKey || event.shiftKey) {
    const field = event.currentTarget;
    const start = field.selectionStart;
    props.onChange(`${props.draft.slice(0, start)}\n${props.draft.slice(field.selectionEnd)}`);
    requestAnimationFrame(() => field.setSelectionRange(start + 1, start + 1));
    return;
  }
  props.onSend();
}

export function ComposerInput(props: ComposerInputProps) {
  const mention = useFileMentions(props);
  return <>
    {mention.open ? <FileMentionMenu menu={mention} />
      : props.slash.open ? <SlashMenu state={props.slash} /> : null}
    <textarea
      value={props.draft} rows={1} ref={props.fieldRef}
      placeholder="Send a message… / 命令，@ 文件或目录"
      aria-label="消息输入框"
      aria-autocomplete="list"
      aria-controls={mention.open ? mention.listId : undefined}
      aria-activedescendant={mention.open && mention.matches.length
        ? `${mention.listId}-${mention.selected}` : undefined}
      onChange={(event) => {
        mention.syncSelection(event.currentTarget);
        props.onChange(event.currentTarget.value);
      }}
      onSelect={(event) => mention.syncSelection(event.currentTarget)}
      onFocus={(event) => { mention.syncSelection(event.currentTarget); mention.setFocused(true); }}
      onBlur={() => mention.setFocused(false)}
      onPaste={(event) => {
        const files = Array.from(event.clipboardData?.files ?? []);
        if (files.length === 0) return;
        event.preventDefault();
        props.onFiles(files);
      }}
      onKeyDown={(event) => {
        if (mention.open) {
          if (mention.onKeyDown(event)) return;
        } else if (handleSlashKey(event, props.slash)) return;
        if (!mention.open && !props.slash.open && props.onHistoryKey(event)) return;
        handleComposerEnter(event, props);
      }}
    />
    {props.historyError ? <p role="status" className="error">{props.historyError}</p> : null}
  </>;
}

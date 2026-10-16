import { useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { FileMentionMenu } from "./FileMentionMenu";
import type { MentionClient } from "./fileMentions";
import { handleSlashKey, SlashMenu, type SlashMenuState } from "./SlashMenu";
import { useFileMentions } from "./useFileMentions";
import { quotePlaceholder, splitQuotePlaceholders } from "./quotes";

/**
 * A hidden ruler, and what it has measured.
 *
 * A badge is drawn where the placeholder's own characters are, so it has to
 * cover exactly their advance width: the caret belongs to the field and moves
 * through the raw text, so a badge of any other width would leave the caret
 * sitting inside it (or short of it) at the token's end, and the reader could
 * not place the caret past the badge at all. Measured with the field's own font
 * and remembered, because the answer only changes with the font.
 */
let ruler: HTMLSpanElement | null = null;
const widths = new Map<string, number>();

function measureTokenWidth(field: HTMLTextAreaElement | null, token: string): number | undefined {
  if (!field) return undefined;
  const style = window.getComputedStyle(field);
  const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  const key = `${font}|${token}`;
  const known = widths.get(key);
  if (known !== undefined) return known;
  if (!ruler) {
    ruler = document.createElement("span");
    ruler.setAttribute("aria-hidden", "true");
    ruler.style.cssText =
      "position:absolute;visibility:hidden;white-space:pre;pointer-events:none;top:-9999px;left:-9999px;";
    document.body.appendChild(ruler);
  }
  ruler.style.font = font;
  ruler.textContent = token;
  const width = ruler.getBoundingClientRect().width;
  ruler.textContent = "";
  widths.set(key, width);
  return width;
}

interface ComposerInputProps {
  client: MentionClient;
  paneId: string;
  draft: string;
  onChange: (text: string) => void;
  fieldRef: RefObject<HTMLTextAreaElement>;
  /**
   * The floor a resize left on the field, in pixels.
   *
   * Optional because the field has a CSS floor of its own; this only ever raises
   * it, so the field keeps growing with what is typed.
   */
  minHeight?: number;
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
  const backdropRef = useRef<HTMLDivElement | null>(null);
  /*
   * A textarea cannot paint part of its own text, so the badges live in a
   * read-only layer behind a transparent-text field (Slack's arrangement),
   * aligned by matching metrics. IME composition draws its preview in the
   * field's own colour, so while it runs the field shows plain text and the
   * badge layer steps aside — otherwise the passage being typed in Chinese
   * would be invisible.
   */
  const [composing, setComposing] = useState(false);
  const segments = splitQuotePlaceholders(props.draft);
  return <>
    {mention.open ? <FileMentionMenu menu={mention} />
      : props.slash.open ? <SlashMenu state={props.slash} /> : null}
    <div
      ref={backdropRef}
      aria-hidden="true"
      className={
        composing
          ? "composer-field__backdrop composer-field__backdrop--aside"
          : "composer-field__backdrop"
      }
    >
      {segments.map((segment, index) =>
        "seq" in segment ? (
          <mark
            className="composer-quote-token"
            key={index}
            /* Exactly the width of the characters it stands in for. */
            style={{ width: measureTokenWidth(props.fieldRef.current, quotePlaceholder(segment.seq)) }}
          >
            引用{segment.seq}
          </mark>
        ) : (
          segment.text
        ),
      )}
    </div>
    <textarea
      className={composing ? undefined : "composer-field__ghost"}
      value={props.draft} rows={1} ref={props.fieldRef}
      onCompositionStart={() => setComposing(true)}
      onCompositionEnd={() => setComposing(false)}
      onScroll={(event) => {
        if (backdropRef.current) {
          backdropRef.current.scrollTop = event.currentTarget.scrollTop;
        }
      }}
      style={props.minHeight === undefined ? undefined : { minHeight: props.minHeight }}
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

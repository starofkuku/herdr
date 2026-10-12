/*
 * Quoting a passage out of the conversation and into the prompt.
 *
 * The gesture is the browser's own — select text, then ask for it to be carried
 * into the composer — so nothing here intercepts the selection; it only watches
 * it. The menu is offered on release rather than while the text is being dragged:
 * a control that appears under the pointer mid-drag moves the target the reader
 * is still aiming at, and the drag has not ended.
 *
 * ZCode's equivalent is `MarkdownSelectionTooltip` in its own repository, and the
 * shape here is deliberately the same: a small floating bar over the passage, a
 * ceiling on what one quote may carry, and a refusal rather than a silent
 * truncation when the passage is longer than that.
 */

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Quote as QuoteIcon } from "lucide-react";
import { QUOTE_MAX_CHARS, type QuoteSource } from "./quotes";

/**
 * Elements that are chrome rather than reading matter.
 *
 * A selection that starts or ends inside one of these is a press on a control
 * that happened to drag, not a passage the reader means to quote. The composer is
 * in the list because text there is already being edited — quoting it into itself
 * is never what was meant.
 */
const EXCLUDED_SELECTOR = [
  "button",
  "input",
  "textarea",
  "select",
  "[role='button']",
  "[role='dialog']",
  ".selection-quote-menu",
  // The rail is a map of the conversation, not the conversation: its labels are
  // truncated copies of text that can be quoted properly a few pixels away.
  ".turn-nav",
].join(",");

interface QuoteTarget {
  text: string;
  source: QuoteSource;
  /** The selection's rectangle in viewport coordinates, for placing the menu. */
  top: number;
  bottom: number;
  centre: number;
}

/** The element a selection endpoint sits in, for the guards and the label. */
function elementOf(node: Node): Element | null {
  return node instanceof Element ? node : node.parentElement;
}

/** Which part of the conversation a passage came from. */
function sourceOf(node: Node): QuoteSource {
  const element = elementOf(node);
  // Checked outermost-last: reasoning renders inside the agent's own body.
  if (element?.closest(".bubble.user")) return "user";
  if (element?.closest(".agent-message.reasoning")) return "reasoning";
  if (element?.closest(".agent-message")) return "agent";
  if (element?.closest(".transcript")) return "terminal";
  if (element?.closest(".work-body, .tool-call, .tool-result, .tool-diff")) return "tool";
  return "unknown";
}

/**
 * The passage the reader has selected, if it is one this menu should offer.
 *
 * Both endpoints have to be inside the same root: a selection that begins in the
 * conversation and ends in the sidebar is not a quotation of either.
 */
function readQuoteTarget(root: HTMLElement | null): QuoteTarget | null {
  if (!root) return null;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null;

  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  if (elementOf(range.startContainer)?.closest(EXCLUDED_SELECTOR)) return null;
  if (elementOf(range.endContainer)?.closest(EXCLUDED_SELECTOR)) return null;

  const text = selection.toString().replace(/\s+$/u, "");
  if (!text.trim()) return null;

  const rect = range.getBoundingClientRect();
  if (!rect.width && !rect.height) return null;

  return {
    text,
    source: sourceOf(range.startContainer),
    top: rect.top,
    bottom: rect.bottom,
    centre: rect.left + rect.width / 2,
  };
}

/**
 * The floating quote control.
 *
 * `onQuote` has to be stable — it is an event-listener dependency, and a new
 * identity on every render would tear the listeners down and put them back while
 * the reader is mid-selection.
 */
export function SelectionQuoteMenu({
  root,
  onQuote,
}: {
  /** The element whose text may be quoted. */
  root: RefObject<HTMLElement | null>;
  onQuote: (text: string, source: QuoteSource) => void;
}) {
  const [target, setTarget] = useState<QuoteTarget | null>(null);
  /** Where the menu landed, once its own size is known. */
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const show = () => setTarget(readQuoteTarget(root.current));
    const hide = () => setTarget(null);

    /*
     * A release ends a drag or a tap, which is the moment the reader means. `up`
     * rather than `selectionchange` alone: the latter fires throughout a drag, and
     * a menu that follows the pointer while the reader is still choosing cannot be
     * clicked without first losing the selection it offers.
     */
    const onRelease = () => window.requestAnimationFrame(show);
    /*
     * Anything after that invalidates the rectangle the menu was placed against,
     * so it goes rather than drifting away from its passage: a collapse, a scroll
     * (captured, because the conversation scrolls rather than the window), a
     * resize, Escape.
     */
    const onSelectionChange = () => {
      if (!readQuoteTarget(root.current)) hide();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") hide();
    };

    document.addEventListener("pointerup", onRelease);
    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      document.removeEventListener("pointerup", onRelease);
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, [root]);

  /*
   * Placed after it is rendered, because the placement needs its width. Above the
   * passage when there is room for it there, below when there is not, and inside
   * the viewport either way: the reader has just pointed at the text under it.
   */
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu || !target) {
      setAt(null);
      return;
    }
    const size = menu.getBoundingClientRect();
    const margin = 12;
    const above = target.top - size.height - 8;
    const top = above >= margin ? above : target.bottom + 8;
    setAt({
      top: Math.max(margin, Math.min(window.innerHeight - size.height - margin, top)),
      left: Math.max(
        margin,
        Math.min(window.innerWidth - size.width - margin, target.centre - size.width / 2),
      ),
    });
  }, [target]);

  if (!target) return null;

  const tooLong = target.text.length > QUOTE_MAX_CHARS;
  const onTake = () => {
    // The quote was taken, so the highlight has done its job and would only
    // compete with the composer for the reader's attention.
    window.getSelection()?.removeAllRanges();
    setTarget(null);
    onQuote(target.text, target.source);
  };

  return (
    <div
      ref={menuRef}
      className="selection-quote-menu"
      role="toolbar"
      aria-label="引用选中的文字"
      style={{
        top: `${at?.top ?? 0}px`,
        left: `${at?.left ?? 0}px`,
        visibility: at ? "visible" : "hidden",
      }}
      /*
       * Both, and with `preventDefault`: pressing a control normally collapses the
       * selection first, which would take the passage away from under the press —
       * and in Safari the `pointerdown` alone is not enough to stop that.
       */
      onPointerDown={(event) => event.preventDefault()}
      onMouseDown={(event) => event.preventDefault()}
    >
      {tooLong ? (
        <p className="selection-quote-menu__note">
          选段 {target.text.length.toLocaleString()} 字符，超过 {QUOTE_MAX_CHARS.toLocaleString()}{" "}
          上限，无法引用
        </p>
      ) : (
        <button type="button" className="selection-quote-menu__action" onClick={onTake}>
          <QuoteIcon size={13} aria-hidden="true" />
          引用到输入框
        </button>
      )}
    </div>
  );
}

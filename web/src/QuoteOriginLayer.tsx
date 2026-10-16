/*
 * The quoted passages, marked where they came from.
 *
 * One layer, mounted inside a scroll container: rectangles over each passage
 * and a numbered chip at its top right, matching the composer's badges. The
 * work lives in quoteHighlights.ts; this is only the mounting — the layer rides
 * the container's content, and a MutationObserver re-measures it whenever the
 * React-rendered text under it changes.
 */

import { useEffect, useRef, type RefObject } from "react";
import { drawQuoteMarks, measureQuoteMarks, QUOTE_SKIP_SELECTOR } from "./quoteHighlights";
import type { Quote } from "./quotes";

export function QuoteOriginLayer({
  scrollRef,
  quotes,
}: {
  /** The scrolling element whose content is the reading matter. */
  scrollRef: RefObject<HTMLElement | null>;
  /** The passages to mark, in the order they were taken. */
  quotes: readonly Quote[];
}) {
  const layerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const root = scrollRef.current;
    const layer = layerRef.current;
    if (!root || !layer) return;
    let painting = false;
    let timer: number | null = null;
    const paint = () => {
      if (painting) return;
      painting = true;
      try {
        const marks = quotes.length ? measureQuoteMarks(root, QUOTE_SKIP_SELECTOR, quotes) : [];
        drawQuoteMarks(layer, root, marks);
      } finally {
        painting = false;
      }
    };
    paint();
    const schedule = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(paint, 250);
    };
    /* The reading matter re-renders under React — streaming text, pages loaded,
     * turns remounted — and each time, the marks are measured again. This
     * observer's own work (the layer's children) is ignored, so it repaints
     * only when something else changed. */
    const observer = new MutationObserver((mutations) => {
      if (mutations.every((mutation) => mutation.target === layer || layer.contains(mutation.target))) return;
      schedule();
    });
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    window.addEventListener("resize", schedule);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      if (timer !== null) window.clearTimeout(timer);
      layer.replaceChildren();
    };
  }, [quotes, scrollRef]);

  return <div className="quote-origin-layer" ref={layerRef} aria-hidden="true" />;
}

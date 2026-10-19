/*
 * The passages quoted into the draft, marked where they came from.
 *
 * The transcript is React's: painting markers into its text would fight every
 * re-render. So the marks live in a layer of their own — rectangles measured
 * from the matched range, drawn over the passage in content coordinates — and
 * when the transcript re-renders, a MutationObserver measures and draws them
 * again. Nothing of React's is touched, and nothing here can break a selection,
 * because the layer never takes a pointer event.
 */

import type { Quote } from "./quotes";

/** The passages the index may not include: chrome, controls, and this layer itself. */
export const QUOTE_SKIP_SELECTOR = [
  ".quote-origin-layer",
  ".selection-quote-menu",
  "button",
  "input",
  "textarea",
  "select",
  "[role='button']",
  ".turn-nav",
  ".conversation-bar",
].join(",");

/** One stretch of one text node, with its place in the concatenated text. */
export interface TextSpan {
  node: Text;
  start: number;
  end: number;
}

/** The transcript's text in reading order, cut into spans for mapping back. */
export interface TranscriptIndex {
  text: string;
  spans: TextSpan[];
}

const BLOCK_SELECTOR =
  "p,li,td,th,pre,code,blockquote,h1,h2,h3,h4,h5,h6,div,section,article,dt,dd,summary,details";

function blockOf(node: Node): Element | null {
  return node.parentElement?.closest(BLOCK_SELECTOR) ?? null;
}

/**
 * The transcript's text nodes as one string, with a newline wherever the walk
 * crosses from one block element to another — the shape a selection's text has
 * between blocks, so a passage picked across paragraphs still finds its place.
 */
export function buildTranscriptIndex(
  root: Element,
  skipSelector: string,
  exclude?: Element | null,
): TranscriptIndex {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      // A quotation is reading text even though it is also a control: it has to be
    // searchable, or following a citation that points at it would find nothing.
    const skipped = parent.closest(skipSelector);
    if (skipped && !skipped.classList.contains("quoted-passage")) {
      return NodeFilter.FILTER_REJECT;
    }
      // A quotation matches its own quoted passage; leaving the subtree out is
      // what makes the remaining match the place the passage came from.
      if (exclude && exclude !== parent && exclude.contains(parent)) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const spans: TextSpan[] = [];
  let text = "";
  let previousBlock: Element | null = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const value = (node as Text).data;
    if (!value) continue;
    const block = blockOf(node);
    if (spans.length > 0 && block !== previousBlock) text += "\n";
    const start = text.length;
    text += value;
    spans.push({ node: node as Text, start, end: text.length });
    previousBlock = block;
  }
  return { text, spans };
}

/**
 * A passage as a whitespace-flexible pattern: the selection's text and the
 * transcript's concatenated text agree on the words but not on how much
 * whitespace sat between them, so runs of whitespace match any run — or none.
 */
export function whitespacePattern(needle: string): RegExp | null {
  const tokens = needle.split(/\s+/).filter((token) => token.length > 0);
  if (tokens.length === 0) return null;
  const body = tokens
    .map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s*");
  return new RegExp(body, "u");
}

/** A located passage: where it starts and ends, in text nodes. */
export interface LocatedRange {
  start: { node: Text; offset: number };
  end: { node: Text; offset: number };
}

/** The first place the passage's words stand in the index, if they stand there. */
export function locateQuote(index: TranscriptIndex, needle: string): LocatedRange | null {
  const pattern = whitespacePattern(needle);
  if (!pattern) return null;
  const match = pattern.exec(index.text);
  if (!match) return null;
  const from = match.index;
  const to = from + match[0].length;
  const startSpan = index.spans.find((span) => span.end > from);
  const endSpan = [...index.spans].reverse().find((span) => span.start < to);
  if (!startSpan || !endSpan) return null;
  return {
    start: { node: startSpan.node, offset: from - startSpan.start },
    end: { node: endSpan.node, offset: to - endSpan.start },
  };
}

/** The shape a mark's rectangle needs, so tests can build plain objects. */
export interface MarkRect {
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
}

/**
 * Rects of the same visual line merged into one: a range crossing inline
 * elements yields one rect per element, and translucent rects painted over
 * each other darken at the seams.
 */
export function mergeRects(rects: ArrayLike<MarkRect>): MarkRect[] {
  const live = Array.from(rects).filter((rect) => rect.width > 0 && rect.height > 0);
  live.sort((a, b) => a.top - b.top || a.left - b.left);
  const out: MarkRect[] = [];
  for (const rect of live) {
    const last = out[out.length - 1];
    const sameLine =
      last !== undefined &&
      rect.top < last.bottom - 1 &&
      rect.left <= last.right + 2;
    if (sameLine && last) {
      out[out.length - 1] = {
        left: last.left,
        top: Math.min(last.top, rect.top),
        right: Math.max(last.right, rect.right),
        bottom: Math.max(last.bottom, rect.bottom),
        width: 0,
        height: 0,
      };
      const merged = out[out.length - 1];
      merged.width = merged.right - merged.left;
      merged.height = merged.bottom - merged.top;
    } else {
      /* Copied property by property: a DOMRect keeps the numbers on its
       * prototype, so spreading one yields an empty object. */
      out.push({
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      });
    }
  }
  return out;
}

/** One quote's marks: a rectangle per visual line, in viewport coordinates. */
export interface QuoteMark {
  seq: number;
  rects: MarkRect[];
}

/**
 * The element holding a quoted passage, found the same way the marks are.
 *
 * A quotation inside a message would otherwise match itself, so the caller's
 * own subtree is skipped while the index is built; with it skipped, the first
 * match is the passage the quotation was taken from.
 */
export function locatePassageElement(
  root: Element,
  skipSelector: string,
  text: string,
  exclude?: Element | null,
): Element | null {
  if (!text.trim()) return null;
  const index = buildTranscriptIndex(root, skipSelector, exclude);
  const located = locateQuote(index, text);
  if (!located) return null;
  let node: Node | null = located.start.node;
  while (node && node.nodeType !== Node.ELEMENT_NODE) node = node.parentNode;
  return (node as Element | null) ?? null;
}

/** Every quote's marks, measured against the transcript as it stands. */
export function measureQuoteMarks(
  root: Element,
  skipSelector: string,
  quotes: readonly Quote[],
): QuoteMark[] {
  if (quotes.length === 0) return [];
  const index = buildTranscriptIndex(root, skipSelector);
  const marks: QuoteMark[] = [];
  for (const quote of quotes) {
    const located = locateQuote(index, quote.text);
    if (!located) continue;
    const range = document.createRange();
    range.setStart(located.start.node, Math.max(0, Math.min(located.start.offset, located.start.node.length)));
    range.setEnd(located.end.node, Math.max(0, Math.min(located.end.offset, located.end.node.length)));
    const rects = mergeRects(range.getClientRects());
    if (rects.length > 0) marks.push({ seq: quote.seq, rects });
  }
  return marks;
}

/**
 * The marks, drawn: rectangles over each passage, and one numbered chip at the
 * first rectangle's top right, matching the badge in the composer. Coordinates
 * are the transcript's content coordinates, so the layer scrolls with the text.
 */
export function drawQuoteMarks(layer: HTMLElement, root: HTMLElement, marks: readonly QuoteMark[]): void {
  layer.replaceChildren();
  if (marks.length === 0) return;
  const rootRect = root.getBoundingClientRect();
  const originTop = rootRect.top - root.scrollTop;
  const originLeft = rootRect.left - root.scrollLeft;
  const position = (element: HTMLElement, top: number, left: number, width?: number, height?: number) => {
    element.style.top = `${top - originTop}px`;
    element.style.left = `${left - originLeft}px`;
    if (width !== undefined) element.style.width = `${width}px`;
    if (height !== undefined) element.style.height = `${height}px`;
  };
  for (const mark of marks) {
    for (const rect of mark.rects) {
      const div = document.createElement("div");
      div.className = "quote-origin-rect";
      div.dataset.seq = String(mark.seq);
      position(div, rect.top, rect.left, rect.width, rect.height);
      layer.appendChild(div);
    }
    const first = mark.rects[0];
    const chip = document.createElement("span");
    chip.className = "quote-origin-chip";
    chip.dataset.seq = String(mark.seq);
    chip.textContent = String(mark.seq);
    /* Clamped at the content's own top: a chip above the first line would
     * otherwise reach past the content and add scroll room of its own. */
    position(chip, Math.max(first.top - 10, originTop), first.right - 6);
    layer.appendChild(chip);
  }
}

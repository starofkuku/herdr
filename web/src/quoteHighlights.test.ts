import { describe, expect, test } from "bun:test";
import {
  locateQuote,
  type MarkRect,
  mergeRects,
  whitespacePattern,
  type TranscriptIndex,
} from "./quoteHighlights";

function index(text: string, cuts: number[]): TranscriptIndex {
  // A stand-in transcript: one span per cut, each holding its slice of `text`.
  const spans = cuts.map((start, i) => ({
    node: { length: (i + 1 < cuts.length ? cuts[i + 1] : text.length) - start } as unknown as Text,
    start,
    end: i + 1 < cuts.length ? cuts[i + 1] : text.length,
  }));
  return { text, spans };
}

describe("whitespacePattern", () => {
  test("matches with any whitespace where the needle has some", () => {
    expect(whitespacePattern("看 这个")?.test("看\n\n这个")).toBe(true);
  });

  test("matches where the transcript has no whitespace at all", () => {
    expect(whitespacePattern("看 这个")?.test("看这个")).toBe(true);
  });

  test("regex metacharacters in the passage are matched literally", () => {
    expect(whitespacePattern("a.b (c) [d]")?.test("xa.b (c) [d]y")).toBe(true);
    expect(whitespacePattern("a.b")?.test("axb")).toBe(false);
  });

  test("an empty passage yields no pattern", () => {
    expect(whitespacePattern("  \n ")).toBeNull();
  });
});

describe("locateQuote", () => {
  test("finds a passage spanning two spans and maps the offsets back", () => {
    const idx = index("看这里的一段话，后面还有。", [0, 5]);
    const at = locateQuote(idx, "一段话，后面");
    expect(at).not.toBeNull();
    // 一(4) 在第一个 span 里，面(9) 在第二个里
    expect(at!.start.node).toBe(idx.spans[0].node);
    expect(at!.start.offset).toBe(4);
    expect(at!.end.node).toBe(idx.spans[1].node);
    expect(at!.end.offset).toBe(5);
  });

  test("returns null when the words are not there", () => {
    const idx = index("完全不同的内容", [0]);
    expect(locateQuote(idx, "一段话")).toBeNull();
  });
});

describe("mergeRects", () => {
  const rect = (left: number, top: number, width: number, height: number): MarkRect => ({
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
  });

  /* A DOMRect keeps its numbers on the prototype; a plain spread of one is
   * empty, which is how NaN marks shipped once. */
  class PrototypeRect {
    constructor(private l: number, private t: number, private w: number, private h: number) {}
    get left() { return this.l; }
    get top() { return this.t; }
    get width() { return this.w; }
    get height() { return this.h; }
    get right() { return this.l + this.w; }
    get bottom() { return this.t + this.h; }
  }

  test("a rect whose numbers live on the prototype keeps them", () => {
    const merged = mergeRects([new PrototypeRect(10, 20, 30, 14) as unknown as MarkRect]);
    expect(merged).toHaveLength(1);
    expect(merged[0].top).toBe(20);
    expect(merged[0].right).toBe(40);
    expect(merged[0].width).toBe(30);
  });

  test("rects on one line with a small gap become one", () => {
    const merged = mergeRects([rect(10, 20, 30, 14), rect(42, 20, 20, 14)]);
    expect(merged).toHaveLength(1);
    expect(merged[0].left).toBe(10);
    expect(merged[0].width).toBe(52);
  });

  test("rects on different lines stay apart", () => {
    expect(mergeRects([rect(10, 20, 30, 14), rect(10, 40, 30, 14)])).toHaveLength(2);
  });

  test("empty rects are dropped", () => {
    expect(mergeRects([rect(0, 0, 0, 0), rect(5, 5, 3, 3)])).toHaveLength(1);
  });
});

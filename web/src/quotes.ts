/*
 * The passages a reader pulled out of the conversation and attached to a prompt.
 *
 * They are context rather than text: a reader quotes a passage to refer to it,
 * not to edit it, so the quotes are held beside the draft and shown as one chip
 * above the composer. Splicing them into the field instead — the first attempt at
 * this — made the passage editable and mixed it in with whatever the reader was
 * writing; ZCode's arrangement, which this follows, keeps the two apart and puts
 * them together only on the way out.
 */

/** The most one quote may carry. ZCode's number for the same job. */
export const QUOTE_MAX_CHARS = 8000;

/**
 * How many quotes a prompt may carry, and how much text they may add up to.
 * The count is ours — twenty, raised from ZCode's eight — while the two size
 * caps stay as they were: many short passages are cheap, and one huge pile is
 * what the total cap is there to stop.
 */
export const QUOTE_MAX_COUNT = 20;
export const QUOTE_MAX_TOTAL = 16_000;

/** Which part of the conversation a quote came out of. */
export type QuoteSource = "user" | "agent" | "reasoning" | "tool" | "terminal" | "unknown";

/** How each source is named: in the prompt, and under the passage in the chip. */
export const QUOTE_SOURCE_LABELS: Record<QuoteSource, string> = {
  user: "用户的提问",
  agent: "agent 的回答",
  reasoning: "推理内容",
  tool: "工具输出",
  terminal: "终端输出",
  unknown: "上文",
};

export interface Quote {
  id: string;
  /** The number its placeholder carries; fixed for as long as the quote lives. */
  seq: number;
  text: string;
  source: QuoteSource;
}

/** Why a quote was turned away. */
export type QuoteLimit = "single" | "count" | "total";

/**
 * What each refusal says.
 *
 * ZCode's wording for the same three limits. A quote is refused rather than
 * shortened: half a sentence in the prompt leaves the agent answering about a
 * passage the reader never picked, and the reader with no way to tell.
 */
export const QUOTE_LIMIT_MESSAGES: Record<QuoteLimit, string> = {
  single: `单条引用最多 ${QUOTE_MAX_CHARS.toLocaleString()} 个字符。`,
  count: `最多可添加 ${QUOTE_MAX_COUNT} 条对话引用。`,
  total: `对话引用总计最多 ${QUOTE_MAX_TOTAL.toLocaleString()} 个字符。`,
};

/** The quotes carried with the draft, and the last refusal still to explain. */
export interface QuoteState {
  quotes: Quote[];
  limit: QuoteLimit | null;
}

export const NO_QUOTES: QuoteState = { quotes: [], limit: null };

/**
 * A quote with an id of its own.
 *
 * The id is what lets the chip remove exactly one passage: two quotes of the same
 * text from the same source would otherwise be indistinguishable.
 */
export function newQuote(text: string, source: QuoteSource, seq: number): Quote {
  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    seq,
    text,
    source,
  };
}

/**
 * The state with one more quote, or with the reason it does not fit.
 *
 * A passage that is already quoted is left alone rather than refused: selecting
 * the same sentence twice means it once, and a second copy would reach the agent
 * twice. Any refusal that was showing is cleared, because the reader has since
 * done something that succeeded.
 */
export function addQuote(state: QuoteState, quote: Quote): QuoteState {
  if (quote.text.length > QUOTE_MAX_CHARS) return { quotes: state.quotes, limit: "single" };
  if (state.quotes.some((item) => item.text === quote.text && item.source === quote.source)) {
    return { quotes: state.quotes, limit: null };
  }
  if (state.quotes.length >= QUOTE_MAX_COUNT) return { quotes: state.quotes, limit: "count" };
  const total = state.quotes.reduce((sum, item) => sum + item.text.length, 0);
  if (total + quote.text.length > QUOTE_MAX_TOTAL) return { quotes: state.quotes, limit: "total" };
  return { quotes: [...state.quotes, quote], limit: null };
}

/** The state without one quote; the refusal it explained goes with it. */
export function removeQuote(state: QuoteState, id: string): QuoteState {
  return { quotes: state.quotes.filter((quote) => quote.id !== id), limit: null };
}

/**
 * One quote as it goes into the prompt.
 *
 * A blockquote with its source named on the first line, which is the lesson ZCode
 * recorded for this feature: an excerpt on its own loses where it came from. ZCode
 * sends a fenced JSON block instead, because its own reader parses that back into
 * a chip; herdr renders the sent message as Markdown, so the block is written to
 * read as a quotation both for the agent and for the reader scrolling back to it.
 */
export function quotedPromptBlock(quote: Quote): string {
  const body = quote.text
    .split("\n")
    .map((line) => (line.trim() ? `> ${line}` : ">"))
    .join("\n");
  return `> 引用${QUOTE_SOURCE_LABELS[quote.source]}：\n${body}`;
}

/** The placeholder a quote takes inside the draft, so the reader can point at a passage where they mean it. */
export function quotePlaceholder(seq: number): string {
  return `[引用${seq}]`;
}

/** Splits a line into its text and the quote numbers marked inside it. */
const PLACEHOLDER_SPLIT = /\[引用(\d+)\]/;

/** Any placeholder — a quote's or an attached file's — anchored for reading it off either edge of the caret. */
const PLACEHOLDER_ENDING = /(?:\[引用\d+\]|\[图片\d+\])$/;
const PLACEHOLDER_STARTING = /^(?:\[引用\d+\]|\[图片\d+\])/;

/**
 * The draft with every placeholder expanded into its quotation block, standing
 * exactly where the reader put it.
 *
 * A blockquote cannot sit inside a sentence, so a placeholder held mid-line
 * breaks the line into paragraphs around its block: the words before it, the
 * quotation, the words after. A number that names no quote — typed by hand, or
 * left behind by a chip that was removed — stays as the reader wrote it.
 */
export function expandQuotedPlaceholders(text: string, quotes: readonly Quote[]): string {
  const bySeq = new Map<number, Quote>();
  for (const quote of quotes) bySeq.set(quote.seq, quote);
  return text
    .split("\n")
    .map((line) => {
      if (!line.includes("[引用")) return line;
      const parts = line.split(PLACEHOLDER_SPLIT);
      if (parts.length === 1) return line;
      const blocks: string[] = [];
      let carried = "";
      for (let index = 0; index < parts.length; index += 1) {
        const part = parts[index];
        if (index % 2 === 1) {
          const quote = bySeq.get(Number(part));
          if (quote) {
            if (carried.trim()) blocks.push(carried.trim());
            carried = "";
            blocks.push(quotedPromptBlock(quote));
          } else {
            carried += `[引用${part}]`;
          }
        } else {
          carried += part;
        }
      }
      if (carried.trim()) blocks.push(carried.trim());
      return blocks.join("\n\n");
    })
    .join("\n");
}

/** One stretch of a draft: either plain text, or one quote's placeholder. */
export type QuoteSegment = { text: string } | { seq: number };

/**
 * The draft cut at its placeholders, so the field can paint each one as a badge
 * over the text the reader is writing. Nothing is changed — the segments join
 * back to exactly the draft — this is only a view of it.
 */
export function splitQuotePlaceholders(text: string): QuoteSegment[] {
  const out: QuoteSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(/\[引用(\d+)\]/g)) {
    const at = match.index ?? 0;
    if (at > last) out.push({ text: text.slice(last, at) });
    out.push({ seq: Number(match[1]) });
    last = at + match[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

/** The draft with one quote's placeholders pulled out, as if never written. */
export function stripQuotePlaceholder(text: string, seq: number): string {
  const token = quotePlaceholder(seq);
  return text
    .split("\n")
    .map((line) =>
      line.includes(token)
        ? line.split(token).join("").replace(/ {2,}/g, " ").trim()
        : line,
    )
    .join("\n");
}

/** The draft with every listed quote's placeholders pulled out. */
export function stripAllQuotePlaceholders(text: string, quotes: readonly Quote[]): string {
  let out = text;
  for (const quote of quotes) out = stripQuotePlaceholder(out, quote.seq);
  return out;
}


/**
 * The draft after the placeholder the caret is against, for a Backspace or a
 * Delete.
 *
 * A placeholder is one thing to the reader — a badge — so a key at its edge
 * takes all of it. Peeling it character by character would leave `[引用` on
 * screen, half a badge in plain text, and would drop the quote behind it as
 * soon as the text stopped being a placeholder at all.
 *
 * Returns null when the key is not against a placeholder, so the field keeps
 * its ordinary behaviour.
 */
export function dropQuoteAtCaret(
  text: string,
  caret: number,
  key: "Backspace" | "Delete",
): { text: string; caret: number } | null {
  let from: number;
  let to: number;
  if (key === "Backspace") {
    const match = PLACEHOLDER_ENDING.exec(text.slice(0, caret));
    if (!match) return null;
    from = caret - match[0].length;
    to = caret;
  } else {
    const match = PLACEHOLDER_STARTING.exec(text.slice(caret));
    if (!match) return null;
    from = caret;
    to = caret + match[0].length;
  }
  /* The seam the removal leaves behind: the spaces that stood around the badge
   * become one, the way removing the quote from its chip does it. */
  const left = text.slice(0, from);
  const right = text.slice(to);
  if (/ $/.test(left) && /^ /.test(right)) {
    const kept = left.replace(/ +$/, " ");
    return { text: kept + right.replace(/^ +/, ""), caret: kept.length };
  }
  return { text: left + right, caret: from };
}

/** The placeholder an attached file takes in the draft, so it stands where the
 * reader pasted it rather than where a list of paths would be appended. */
export function imagePlaceholder(seq: number): string {
  return `[图片${seq}]`;
}

/** One token of a draft: prose, a quote's placeholder, or an attached file's. */
export type DraftToken =
  | { text: string }
  | { kind: "quote"; seq: number }
  | { kind: "image"; seq: number };

const ANY_TOKEN = /\[(?:引用|图片)(\d+)\]/g;

/** The draft cut at every placeholder, whichever kind, for painting badges. */
export function splitDraftTokens(text: string): DraftToken[] {
  const out: DraftToken[] = [];
  let last = 0;
  for (const match of text.matchAll(ANY_TOKEN)) {
    const at = match.index ?? 0;
    if (at > last) out.push({ text: text.slice(last, at) });
    const kind = match[0][1] === "图" ? "image" : "quote";
    out.push({ kind, seq: Number(match[1]) });
    last = at + match[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

/** The draft with each file's placeholder standing in for its stored path. */
export function expandImagePlaceholders(text: string, paths: ReadonlyMap<number, string>): string {
  return text.replace(
    /\[图片(\d+)\]/g,
    (token: string, digits: string, offset: number, whole: string) => {
      const path = paths.get(Number(digits));
      if (path === undefined) return "";
      /*
       * The path has to stand as its own token. A placeholder typed against the
       * next word — `[图片1]1. 说明` — would otherwise glue into `…id.png1.`, and
       * nothing downstream could tell where the file name ended. A space is
       * added on whichever side is missing one, so the sentence keeps its shape.
       */
      const before = offset > 0 ? whole[offset - 1] : "";
      const after = whole[offset + token.length] ?? "";
      const lead = before && !/\s/.test(before) ? " " : "";
      const trail = after && !/\s/.test(after) ? " " : "";
      return `${lead}${path}${trail}`;
    },
  );
}

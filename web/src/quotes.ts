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

/** How many quotes a prompt may carry, and how much text they may add up to. */
export const QUOTE_MAX_COUNT = 8;
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
export function newQuote(text: string, source: QuoteSource): Quote {
  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
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

/** Every quote's block, in the order the reader took them. */
export function quotedPromptBlocks(quotes: readonly Quote[]): string {
  return quotes.map(quotedPromptBlock).join("\n\n");
}

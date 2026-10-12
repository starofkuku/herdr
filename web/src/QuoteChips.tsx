/*
 * The quotes attached to the draft, as one chip above the composer.
 *
 * ZCode's shape: a pill naming the count, hovered (or focused) to list what it
 * holds, with a remove control for the whole set on the pill and one per passage
 * inside. The draft itself is never touched, so a quote cannot be half-edited into
 * a sentence — and a refusal to add another one is stated rather than swallowed,
 * which is why the limit line lives beside the chip and not in a toast.
 */

import { Quote as QuoteIcon, Trash2, X } from "lucide-react";
import {
  QUOTE_LIMIT_MESSAGES,
  QUOTE_SOURCE_LABELS,
  type QuoteState,
} from "./quotes";

export function QuoteChips({
  state,
  onRemove,
  onRemoveAll,
}: {
  state: QuoteState;
  /** Drops one quote, by id. */
  onRemove: (id: string) => void;
  /** Drops every quote. */
  onRemoveAll: () => void;
}) {
  const { quotes, limit } = state;
  if (quotes.length === 0 && !limit) return null;

  return (
    <div className="quote-chips">
      {quotes.length > 0 ? (
        /*
         * Focusable so the keyboard can read the passages too: the panel opens on
         * `:focus-within` for the same reason it opens on hover, and a reader with
         * no pointer has no other way to see what is attached.
         */
        <div
          className="quote-chips__pill"
          role="group"
          aria-label={`${quotes.length} 条对话引用，悬停或聚焦查看`}
          tabIndex={0}
        >
          <QuoteIcon size={14} aria-hidden="true" />
          <span className="quote-chips__label">{quotes.length} 条对话引用</span>
          <button
            type="button"
            className="quote-chips__clear"
            aria-label="移除全部对话引用"
            title="移除全部对话引用"
            onClick={onRemoveAll}
          >
            <X size={13} aria-hidden="true" />
          </button>

          <div className="quote-chips__panel">
            {quotes.map((quote) => (
              <div className="quote-chips__item" key={quote.id}>
                <QuoteIcon size={13} aria-hidden="true" className="quote-chips__item-icon" />
                <div className="quote-chips__body">
                  <p className="quote-chips__text">{quote.text}</p>
                  <p className="quote-chips__meta">{QUOTE_SOURCE_LABELS[quote.source]}</p>
                </div>
                <button
                  type="button"
                  className="quote-chips__remove"
                  aria-label="移除这条引用"
                  title="移除这条引用"
                  onClick={() => onRemove(quote.id)}
                >
                  <Trash2 size={13} aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {limit ? (
        // `alert` because the reader asked for something and did not get it, and
        // the composer otherwise looks like nothing happened.
        <p className="quote-chips__limit" role="alert">
          {QUOTE_LIMIT_MESSAGES[limit]}
        </p>
      ) : null}
    </div>
  );
}

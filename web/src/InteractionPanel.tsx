import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { InteractionAnswer, InteractionQuestion, InteractionRequest } from "./interaction";

/**
 * The panel that shows an agent's question with the options it offered.
 *
 * The options come from the agent's own protocol rather than being parsed off
 * the screen, so a choice here is a choice the agent made, not a guess about its
 * wording. Agents that do not publish a structured request never reach this
 * component; the terminal panel is used for those instead.
 *
 * Nothing is sent until the user commits. A multi-question request is answered
 * with one call so the agent cannot act on half an answer.
 */
export function InteractionPanel({
  request,
  busy,
  onAnswer,
}: {
  request: InteractionRequest;
  busy: boolean;
  /** Sends the collected answers. Resolves once the server has them. */
  onAnswer: (answers: InteractionAnswer[]) => Promise<void>;
}) {
  // Selected option ids per question. A set per question keeps multi-select
  // order-independent, which is what the agent receives.
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  // Free-text answers, used when a question allows one.
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const answersFor = (question: InteractionQuestion): InteractionAnswer => {
    const text = (typed[question.id] ?? "").trim();
    return {
      question_id: question.id,
      option_ids: selected[question.id] ?? [],
      ...(question.allowCustom && text ? { text } : {}),
    };
  };

  const toggle = (question: InteractionQuestion, optionId: string) => {
    setSelected((current) => {
      const previous = current[question.id] ?? [];
      if (!question.multiSelect) {
        return { ...current, [question.id]: [optionId] };
      }
      const next = previous.includes(optionId)
        ? previous.filter((id) => id !== optionId)
        : [...previous, optionId];
      return { ...current, [question.id]: next };
    });
  };

  // A question is satisfied by a chosen option or, when the agent allows it, by
  // typed text. Requiring both would block the common case of typing instead of
  // choosing.
  const answered = (question: InteractionQuestion): boolean => {
    if ((selected[question.id] ?? []).length > 0) return true;
    return question.allowCustom && (typed[question.id] ?? "").trim().length > 0;
  };
  const complete = request.questions.every(answered);

  const submit = async () => {
    if (!complete || busy) return;
    setError(null);
    try {
      await onAnswer(request.questions.map(answersFor));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="interaction">
      <div className="interaction-head">
        <span className="interaction-label">
          {request.kind === "approval" ? "needs your approval" : "waiting for you"}
        </span>
        {request.title ? <span className="interaction-title">{request.title}</span> : null}
      </div>

      {request.summary ? <pre className="interaction-summary">{request.summary}</pre> : null}

      {request.questions.map((question) => {
        const chosen = selected[question.id] ?? [];
        return (
          <div className="interaction-question" key={question.id}>
            <div className="interaction-question-head">
              {question.header ? (
                <span className="interaction-chip">{question.header}</span>
              ) : null}
              <span className="interaction-text">{question.question}</span>
            </div>

            <div className="interaction-options">
              {question.options.map((option) => {
                const active = chosen.includes(option.id);
                return (
                  <button
                    type="button"
                    key={option.id}
                    className={`interaction-option${active ? " selected" : ""}`}
                    aria-pressed={active}
                    disabled={busy}
                    onClick={() => toggle(question, option.id)}
                  >
                    <span className="interaction-option-main">
                      <span className="interaction-option-label">{option.label}</span>
                      {option.description ? (
                        <span className="interaction-option-desc">{option.description}</span>
                      ) : null}
                    </span>
                    {/* Preview is markdown and can be long, so it is collapsed
                        until asked for rather than pushing the options apart. */}
                    {option.preview ? (
                      <details className="interaction-preview">
                        <summary>preview</summary>
                        <div className="markdown">
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>{option.preview}</ReactMarkdown>
                        </div>
                      </details>
                    ) : null}
                  </button>
                );
              })}
            </div>

            {question.allowCustom ? (
              <textarea
                className="interaction-input"
                rows={1}
                placeholder="Or answer in your own words…"
                value={typed[question.id] ?? ""}
                disabled={busy}
                onChange={(event) =>
                  setTyped((current) => ({ ...current, [question.id]: event.target.value }))
                }
              />
            ) : null}
          </div>
        );
      })}

      {error ? <p className="error">{error}</p> : null}

      <div className="interaction-actions">
        <button
          type="button"
          className="interaction-submit"
          disabled={busy || !complete}
          onClick={() => void submit()}
        >
          {busy ? "sending…" : "Send answer"}
        </button>
      </div>
    </div>
  );
}

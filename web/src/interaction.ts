// Typed view of a pending agent interaction request.
//
// Agents that publish a structured protocol report the question they are
// waiting on, including the options they offered. Rendering those directly is
// what lets a reader answer with one tap instead of matching screen text
// against a key. The terminal remains the source for agents that do not publish
// one, so everything here is optional and a malformed payload degrades to "no
// structured request" rather than throwing.

/** One selectable answer, as the agent offered it. */
export interface InteractionOption {
  /** Sent back as the answer. Preferred over `label`, which is display text. */
  id: string;
  label: string;
  description?: string;
  /** Markdown shown beside the options, for example an ASCII mockup. */
  preview?: string;
}

export interface InteractionQuestion {
  id: string;
  header?: string;
  question: string;
  multiSelect: boolean;
  allowCustom: boolean;
  options: InteractionOption[];
}

export interface InteractionRequest {
  source: string;
  requestId: string;
  kind: "question" | "approval";
  title?: string;
  summary?: string;
  questions: InteractionQuestion[];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function parseOption(raw: unknown): InteractionOption | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const id = asString(record.id);
  const label = asString(record.label);
  // Without both, there is nothing to show and nothing to answer with.
  if (!id || !label) return null;
  return {
    id,
    label,
    description: asString(record.description),
    preview: asString(record.preview),
  };
}

function parseQuestion(raw: unknown): InteractionQuestion | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const id = asString(record.id);
  const question = asString(record.question);
  if (!id || !question) return null;
  const options = Array.isArray(record.options)
    ? record.options.map(parseOption).filter((o): o is InteractionOption => o !== null)
    : [];
  // A question with no usable options is not answerable through the UI, and
  // showing it as a choice would offer nothing to choose.
  if (options.length === 0) return null;
  return {
    id,
    header: asString(record.header),
    question,
    multiSelect: record.multi_select === true,
    allowCustom: record.allow_custom === true,
    options,
  };
}

/**
 * Parses a `pane.get`/`session.snapshot` interaction request.
 *
 * Returns null when the request is absent or unusable, which is the signal to
 * fall back to the terminal. A partially valid payload keeps whatever questions
 * parsed: dropping the whole request because one question was malformed would
 * lose an answerable question alongside it.
 */
export function parseInteractionRequest(raw: unknown): InteractionRequest | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const source = asString(record.source);
  const requestId = asString(record.request_id);
  if (!source || !requestId) return null;
  const questions = Array.isArray(record.questions)
    ? record.questions.map(parseQuestion).filter((q): q is InteractionQuestion => q !== null)
    : [];
  if (questions.length === 0) return null;
  return {
    source,
    requestId,
    kind: record.kind === "approval" ? "approval" : "question",
    title: asString(record.title),
    summary: asString(record.summary),
    questions,
  };
}

/** One answer to one question, shaped for `pane.answer_interaction`. */
export interface InteractionAnswer {
  question_id: string;
  option_ids: string[];
  text?: string;
}

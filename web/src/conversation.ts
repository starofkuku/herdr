// Typed views over the `pane.session` API.
//
// herdr parses the agent's own transcript on the server side, so the browser
// receives turns, tool calls, and token usage as data. That is what lets the
// conversation view render a real transcript instead of the terminal screen,
// which is full of TUI chrome.
//
// Everything here is read-only. Sending input, interrupting, and answering
// prompts go through `pane.send_input`, so the pane stays the single writer.

/**
 * The slice of the gateway client this module needs.
 *
 * Declared structurally rather than imported from the view, so the data layer
 * does not depend on the component that happens to define the full client type.
 */
interface ConversationClient {
  call: <T>(method: string, params?: Record<string, unknown>) => Promise<T>;
}

/** One tool invocation inside a turn. */
export interface ConversationToolCall {
  call_id?: string;
  /** Normalised category, for example `exec_command`. */
  kind?: string;
  name?: string;
  /** Raw arguments as recorded by the agent. */
  arguments?: unknown;
  /** Text the tool produced. */
  output?: string;
}

/** One message the agent produced during a turn. */
export interface ConversationMessage {
  text: string;
  is_reasoning?: boolean;
  timestamp?: string;
}

/** One exchange: a user message plus everything the agent did in response. */
export interface ConversationTurn {
  turn_id: string;
  /** Unix seconds. */
  started_at?: number;
  completed_at?: number;
  duration_ms?: number;
  status: string;
  user_message?: string;
  agent_messages?: ConversationMessage[];
  tool_calls?: ConversationToolCall[];
  final_answer?: string;
  model?: string;
  error?: string;
  aborted_reason?: string;
}

/** Where to resume when older turns are needed. */
export interface ConversationPagination {
  next_cursor?: number;
  has_more: boolean;
  total_turns: number;
}

export interface Conversation {
  paneId: string;
  /** Transcript path that was read. */
  path: string;
  /** Label the pane reports for its agent. */
  agent: string;
  /**
   * Provider the transcript file itself declares.
   *
   * Preferred over `agent` when showing what the conversation actually is, since
   * it is read from the file and cannot disagree with it.
   */
  provider: string;
  /** Working directory recorded at the start of the session. */
  cwd?: string;
  /** Total tokens across the whole session. */
  totalTokens?: number;
  turns: ConversationTurn[];
  pagination?: ConversationPagination;
}

/** Raised when a pane has no readable transcript, or the read failed. */
export class ConversationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConversationError";
  }
}

/**
 * Bytes requested per page.
 *
 * The server pages a transcript by bytes and caps a single response; asking for
 * less keeps the first paint fast on a phone, and older turns are fetched when
 * the reader scrolls to the top.
 */
export const PAGE_BYTES = 256 * 1024;

/**
 * The `pane.session` response body.
 *
 * `call()` already unwraps the envelope's `result`, so the variant fields sit at
 * the top level.
 */
interface SessionResponse {
  session?: {
    pane_id: string;
    path: string;
    agent: string;
    provider: string;
    cwd?: string;
    total_tokens?: number;
    turns: ConversationTurn[];
    pagination?: { next_cursor?: number; has_more: boolean; total_turns: number };
  };
}

/** Loads one page of a pane's parsed transcript. */
export async function loadConversation(
  client: ConversationClient,
  paneId: string,
  options: { cursor?: number; maxBytes?: number } = {},
): Promise<Conversation> {
  const envelope = await client.call<SessionResponse>("pane.session", {
    pane_id: paneId,
    cursor: options.cursor,
    max_bytes: options.maxBytes ?? PAGE_BYTES,
  });

  const session = envelope.session;
  if (!session) {
    throw new ConversationError("the server returned no session for this pane");
  }

  return {
    paneId: session.pane_id,
    path: session.path,
    agent: session.agent,
    provider: session.provider,
    cwd: session.cwd,
    totalTokens: session.total_tokens,
    turns: session.turns ?? [],
    pagination: session.pagination,
  };
}

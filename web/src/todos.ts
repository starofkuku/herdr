// The agent's own todo list, as exposed by `pane.todos`.
//
// herdr does not track this itself. The server reads it back out of the agent's
// own transcript, so an agent that keeps no list — or one whose integration has
// not reported a session yet — simply answers with an empty array. Absence is
// ordinary here, never an error, so the panel hides rather than complaining.

/** One task, as the agent recorded it. */
export interface TodoItem {
  id: number;
  subject: string;
  /** `pending`, `in_progress`, or `completed`. Held open: the agent owns it. */
  status: string;
}

/** The slice of the gateway client this module needs. */
interface TodoClient {
  call: <T>(method: string, params?: Record<string, unknown>) => Promise<T>;
}

/** How often the panel re-asks while the agent is working. */
export const TODO_POLL_MS = 4000;

/**
 * Reads the pane's todo list.
 *
 * A failure resolves to an empty list rather than rejecting: the panel is
 * supplementary, and an agent whose transcript cannot be read should not turn
 * the whole view into an error.
 */
export async function loadTodos(client: TodoClient, paneId: string): Promise<TodoItem[]> {
  try {
    const response = await client.call<{ todos?: { todos?: unknown } }>("pane.todos", {
      pane_id: paneId,
    });
    return parseTodos(response?.todos?.todos);
  } catch {
    return [];
  }
}

/**
 * Keeps only entries that are usable as a task.
 *
 * The status is deliberately left unvalidated beyond being a string, because
 * the agent owns the vocabulary; the panel renders what it is given.
 */
export function parseTodos(value: unknown): TodoItem[] {
  if (!Array.isArray(value)) return [];
  const todos: TodoItem[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    if (typeof item.id !== "number" || !Number.isFinite(item.id)) continue;
    if (typeof item.subject !== "string") continue;
    if (typeof item.status !== "string") continue;
    todos.push({ id: item.id, subject: item.subject, status: item.status });
  }
  return todos;
}

/** Whether a task still needs doing, which is what the header counts down. */
export function isOpen(todo: TodoItem): boolean {
  return todo.status !== "completed";
}

export interface TodoProgress {
  /** Every task in the list. */
  total: number;
  completed: number;
  /** Tasks neither completed nor untouched — the ones in flight. */
  inProgress: number;
}

export function todoProgress(todos: TodoItem[]): TodoProgress {
  let completed = 0;
  let inProgress = 0;
  for (const todo of todos) {
    if (!isOpen(todo)) completed += 1;
    else if (todo.status === "in_progress") inProgress += 1;
  }
  return { total: todos.length, completed, inProgress };
}

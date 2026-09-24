import { useState } from "react";
import { Circle, CircleCheck, LoaderCircle } from "lucide-react";
import { isOpen, shouldShowPanel, todoProgress, type TodoItem } from "./todos";

/**
 * The agent's todo list, pinned under the conversation.
 *
 * Collapsed to a count by default: the list is context for what the agent is
 * doing rather than the thing being read, and on a phone an expanded list would
 * take the screen.
 *
 * Only rendered while something is left to do. A finished list is not context for
 * anything — the work it described has already happened — and leaving it there
 * parks a panel over the conversation with nothing to say. This matches the CLI,
 * which puts the list away once the turn that owned it ends.
 */
export function TodoPanel({ todos }: { todos: TodoItem[] }) {
  const [open, setOpen] = useState(false);

  if (!shouldShowPanel(todos)) return null;

  const { total, completed, inProgress } = todoProgress(todos);

  return (
    <section className={`todos${open ? " open" : ""}`}>
      <button
        type="button"
        className="todos-head"
        aria-expanded={open}
        aria-label={`Agent todos, ${completed} of ${total} done`}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="todos-caret" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
        <span className="todos-title">Todos</span>
        <span className="todos-count">
          {completed}/{total}
        </span>
        {inProgress > 0 ? (
          <span
            className="todos-running"
            title={`${inProgress} in progress`}
            aria-hidden="true"
          />
        ) : null}
      </button>

      {open ? (
        <ul className="todos-list">
          {todos.map((todo) => (
            <li key={todo.id} className={`todos-item ${todo.status}`}>
              <span className="todos-mark" aria-hidden="true">
                {mark(todo)}
              </span>
              <span className="todos-subject">{todo.subject}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/**
 * The mark for one task.
 *
 * A ring for the rest, a spinner for the task in flight, and a tick once it is
 * done — the same reading order as the list, so the marks scan as progress
 * rather than as three unrelated symbols.
 */
function mark(todo: TodoItem) {
  if (!isOpen(todo)) return <CircleCheck size={14} />;
  return todo.status === "in_progress" ? <LoaderCircle size={14} /> : <Circle size={14} />;
}

import { useState } from "react";
import { isOpen, todoProgress, type TodoItem } from "./todos";

/**
 * The agent's todo list, pinned under the conversation.
 *
 * Collapsed to a count by default: the list is context for what the agent is
 * doing rather than the thing being read, and on a phone an expanded list would
 * take the screen. Nothing renders when the agent keeps no list, so panes that
 * never use the todo tool gain no chrome at all.
 */
export function TodoPanel({ todos }: { todos: TodoItem[] }) {
  const [open, setOpen] = useState(false);
  if (todos.length === 0) return null;

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
 * The glyph for one task.
 *
 * A filled dot for the task in flight, a hollow one for the rest, and a tick
 * once it is done — the same reading order as the list, so the marks scan as
 * progress rather than as three unrelated symbols.
 */
function mark(todo: TodoItem): string {
  if (!isOpen(todo)) return "✓";
  return todo.status === "in_progress" ? "●" : "○";
}

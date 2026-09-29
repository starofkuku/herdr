import { ArrowRight, Circle, CircleCheck } from "lucide-react";
import { isOpen, type TodoItem } from "./todos";

/**
 * The agent's todo list, as the body of the status panel.
 *
 * ZCode's reading, row by row: a tick for the done, an arrow for the task in
 * flight, a ring for the rest, with finished work receding behind a strike.
 * The arrow is static on purpose — ZCode's own note: the item stays on screen a
 * long time, and a spinner would read as "loading" rather than as "this one".
 */
export function TodoList({ todos }: { todos: TodoItem[] }) {
  return (
    <div className="todo-list">
      {todos.map((todo) => (
        <div key={todo.id} className={`todo-item ${todo.status}`}>
          <span className="todo-mark" aria-hidden="true">
            {mark(todo)}
          </span>
          <span className="todo-subject">{todo.subject}</span>
        </div>
      ))}
    </div>
  );
}

/** The mark for one task. */
function mark(todo: TodoItem) {
  if (!isOpen(todo)) return <CircleCheck size={14} />;
  return todo.status === "in_progress" ? <ArrowRight size={14} /> : <Circle size={14} />;
}

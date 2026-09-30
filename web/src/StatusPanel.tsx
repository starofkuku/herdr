import { ArrowRight, Bot, ListTodo, Maximize2, Minimize2 } from "lucide-react";
import { activity, type SubagentRun } from "./subagents";
import { isOpen, shouldShowPanel, todoProgress, type TodoItem } from "./todos";
import { TodoList } from "./TodoPanel";

/**
 * The session's live state, floating over the conversation's top right —
 * ZCode's status panel, scaled to the two things herdr tracks: the agent's todo
 * list and the subagents still running.
 *
 * Collapsed it is ZCode's capsule: one 2rem row whose leading glyph turns into
 * an expand mark on hover, naming the task being worked on (or the runs still
 * going) beside its count. Expanded it is the panel those sections live in. It
 * starts open when the window has room for it and collapsed otherwise, the same
 * auto rule ZCode applies.
 */
export function StatusPanel({
  todos,
  runs,
  open,
  onToggle,
  onOpenSubagents,
}: {
  todos: TodoItem[];
  runs: SubagentRun[];
  /**
   * Whether the panel is open.
   *
   * Owned by the screen rather than here: an open panel takes width away from
   * the conversation, so whoever lays the screen out has to know — and it is
   * also what decides that a file being open collapses the panel.
   */
  open: boolean;
  onToggle: (open: boolean) => void;
  onOpenSubagents: () => void;
}) {
  const hasTodos = shouldShowPanel(todos);
  const hasRuns = runs.length > 0;

  // Nothing live means no panel: a finished list is not state, and an empty
  // panel would just be chrome in the corner.
  if (!hasTodos && !hasRuns) return null;

  const { total, completed } = todoProgress(todos);
  const active = todos.find((todo) => todo.status === "in_progress") ?? todos.find(isOpen);

  if (!open) {
    // ZCode's summary chain, in its order: the task being worked on first, and
    // the running count only when there is no list to speak for.
    const summary = active
      ? { icon: <ArrowRight size={16} />, text: active.subject, count: null }
      : hasTodos
        ? { icon: <ListTodo size={16} />, text: "待办", count: `${completed}/${total}` }
        : { icon: <Bot size={16} />, text: "子智能体运行中", count: String(runs.length) };
    return (
      <button
        type="button"
        className="status-pill"
        aria-label="展开状态面板"
        onClick={() => onToggle(true)}
      >
        <span className="status-pill__icon">
          <span className="status-pill__icon-mark">{summary.icon}</span>
          <Maximize2 size={16} className="status-pill__icon-expand" aria-hidden="true" />
        </span>
        <span className="status-pill__text">{summary.text}</span>
        {summary.count ? <span className="status-pill__count">{summary.count}</span> : null}
      </button>
    );
  }

  return (
    <aside className="status-panel" aria-label="会话状态">
      <header className="status-panel__head">
        <span className="status-panel__title">状态</span>
        <button
          type="button"
          className="status-panel__collapse"
          aria-label="收起状态面板"
          title="收起"
          onClick={() => onToggle(false)}
        >
          <Minimize2 size={14} aria-hidden="true" />
        </button>
      </header>

      {/* The sections scroll inside the shell; the frame itself stays put. */}
      <div className="status-panel__body">
      {hasTodos ? (
        <section className="status-section">
          <header className="status-section__head">
            <span className="status-section__label">待办</span>
            <span className="status-section__count">
              {completed}/{total}
            </span>
          </header>
          <TodoList todos={todos} />
        </section>
      ) : null}

      {hasRuns ? (
        <section className="status-section">
          <header className="status-section__head">
            <span className="status-section__label">子智能体</span>
            <span className="status-section__count">{runs.length}</span>
          </header>
          <div className="status-runs">
            {runs.map((run) => (
              <button
                key={run.run_id}
                type="button"
                className="status-run"
                title={run.task ?? run.agent}
                onClick={onOpenSubagents}
              >
                <span className="status-run__agent">{run.agent}</span>
                <span className="status-run__activity">{activity(run)}</span>
              </button>
            ))}
          </div>
        </section>
      ) : null}
      </div>
    </aside>
  );
}

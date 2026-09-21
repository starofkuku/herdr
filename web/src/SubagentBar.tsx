import { LoaderCircle } from "lucide-react";
import { useState } from "react";
import {
  activity,
  childRuns,
  isRunning,
  rootRuns,
  shortPath,
  type SubagentRun,
} from "./subagents";

/**
 * The subagent indicator, pinned beside the todo list above the composer.
 *
 * Collapsed it is one icon and a count, which is the whole story on a phone.
 * Tapping it opens a drawer with a card per run: what it was asked to do, what
 * it is doing, and the commands it has run. Nothing renders when the agent has
 * no runs, so panes that never spawn a subagent gain no chrome.
 */
export function SubagentBar({
  active,
  runs,
  onOpen,
}: {
  active: number;
  runs: SubagentRun[];
  onOpen: () => void;
}) {
  if (runs.length === 0) return null;

  return (
    <button
      type="button"
      className={`subagent-bar${active > 0 ? " live" : ""}`}
      onClick={onOpen}
      aria-label={
        active > 0
          ? `${active} subagents working, open details`
          : `${runs.length} subagents, open details`
      }
    >
      <LoaderCircle size={14} className={active > 0 ? "spinner" : undefined} aria-hidden="true" />
      <span className="subagent-label">
        {active > 0 ? `${active} 个子 agent 工作中` : `${runs.length} 个子 agent`}
      </span>
    </button>
  );
}

/**
 * The run list, in a drawer over the conversation.
 *
 * A drawer rather than a screen: the point is to watch the runs while the
 * conversation stays where it is.
 */
export function SubagentDrawer({
  runs,
  onClose,
}: {
  runs: SubagentRun[];
  onClose: () => void;
}) {
  const roots = rootRuns(runs);

  return (
    <div className="subagent-drawer" role="dialog" aria-label="Subagents">
      <div className="subagent-drawer__panel">
        <header className="subagent-drawer__head">
          <span className="subagent-drawer__title">子 agent（{runs.length}）</span>
          <button type="button" className="ghost" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        <div className="subagent-drawer__body">
          {roots.map((run) => (
            <RunCard key={run.run_id} run={run} children={childRuns(runs, run.run_id)} />
          ))}
        </div>
      </div>
      <button
        type="button"
        className="subagent-drawer__scrim"
        onClick={onClose}
        aria-label="Close subagents"
      />
    </div>
  );
}

function RunCard({ run, children }: { run: SubagentRun; children: SubagentRun[] }) {
  const [open, setOpen] = useState(isRunning(run));

  return (
    <article className={`run-card ${run.state}`}>
      <header className="run-card__head">
        <span className={`run-dot ${run.state}`} aria-hidden="true" />
        <span className="run-agent">{run.agent}</span>
        <span className="run-state">{run.state}</span>
        {run.tool_count !== undefined ? (
          <span className="run-metric">{run.tool_count} 次工具</span>
        ) : null}
        {run.tokens !== undefined ? (
          <span className="run-metric">{formatTokens(run.tokens)} tok</span>
        ) : null}
      </header>

      {run.task ? <p className="run-task">{run.task}</p> : null}

      {run.target ? (
        <p className="run-target">
          <span className="run-target__label">目标文件</span>
          <code>{shortPath(run.target, 3)}</code>
        </p>
      ) : null}

      <p className="run-activity">{activity(run)}</p>

      {children.length > 0 ? (
        <ul className="run-children">
          {children.map((child) => (
            <li key={child.run_id} className={child.state}>
              <span className="run-dot" aria-hidden="true" />
              {child.agent} · {activity(child)}
            </li>
          ))}
        </ul>
      ) : null}

      {(run.tools?.length ?? 0) > 0 || (run.output?.length ?? 0) > 0 ? (
        <>
          <button
            type="button"
            className="run-detail-toggle"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            {open ? "▾" : "▸"} 工作原理
          </button>
          {open ? (
            <div className="run-detail">
              {run.output?.length ? (
                <div className="run-output">
                  {run.output.map((line, index) => (
                    <p key={index}>{line}</p>
                  ))}
                </div>
              ) : null}
              <ul className="run-tools">
                {(run.tools ?? []).map((call, index) => (
                  <li key={index}>
                    <span className="run-tool-name">{call.tool}</span>
                    <code>{firstLine(call.args)}</code>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      ) : null}

      {run.artifacts?.length ? (
        <ul className="run-artifacts">
          {run.artifacts.map((name) => (
            <li key={name}>{name}</li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}

/**
 * The first line of a command.
 *
 * Tool arguments are whole shell scripts, and a card is not the place to read
 * one. The full command stays in the element for copy, and the rest is shown
 * once the detail is expanded.
 */
function firstLine(args: string): string {
  const [line] = args.split("\n");
  return line.length > 120 ? `${line.slice(0, 120)}…` : line;
}

function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}

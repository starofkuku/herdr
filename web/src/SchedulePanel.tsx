/*
 * Scheduled prompts: what the server will send, and the form that makes one.
 *
 * A schedule is made of three choices — which agent, when, and what to say —
 * so the form is those three fields and nothing else. The list is the point of
 * the panel: a schedule that fired, missed its moment, or is still waiting is
 * something the reader has to be able to see, since the whole reason for
 * scheduling is that they will not be watching at the time.
 */

import { useEffect, useRef, useState, type FormEvent } from "react";
import { AlarmClock, Trash2 } from "lucide-react";
import { AgentManagementDialog } from "./AgentManagementDialog";
import { AgentIcon } from "./AgentIcon";
import type { AgentView } from "./api";
import {
  cancelSchedule,
  createSchedule,
  listSchedules,
  STATUS_LABELS,
  type ScheduleEntry,
} from "./schedule";
import "./schedule.css";

interface ScheduleClient {
  call: <T>(method: string, params?: Record<string, unknown>) => Promise<T>;
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** A local `YYYY-MM-DD HH:MM:SS` string, which the server parses as-is. */
function stamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:00`
  );
}

/** Soon enough to be useful as a default, and easy to edit. */
function defaultAt(): string {
  const at = new Date(Date.now() + 60 * 60 * 1000);
  at.setSeconds(0, 0);
  return stamp(at);
}

function tomorrowMorning(): string {
  const at = new Date();
  at.setDate(at.getDate() + 1);
  at.setHours(8, 0, 0, 0);
  return stamp(at);
}

export function SchedulePanel({
  client,
  agents,
  currentPaneId,
  onClose,
}: {
  client: ScheduleClient;
  /** The session's agents: a schedule talks to one of them. */
  agents: AgentView[];
  currentPaneId: string | null;
  onClose: () => void;
}) {
  const [schedules, setSchedules] = useState<ScheduleEntry[] | null>(null);
  const [paneId, setPaneId] = useState(currentPaneId ?? agents[0]?.paneId ?? "");
  const [at, setAt] = useState(defaultAt);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const active = useRef(true);

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  const refresh = async () => {
    try {
      const list = await listSchedules(client);
      if (active.current) setSchedules(list);
    } catch (err) {
      if (active.current) setError(errorText(err));
    }
  };

  useEffect(() => {
    void refresh();
    // Fetched once on open: the list is a record, and the server is the one
    // that changes it — nothing here polls for a local edit that cannot happen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !paneId || !message.trim() || !at.trim()) return;
    setBusy(true);
    setError("");
    try {
      const created = await createSchedule(client, paneId, at, message);
      if (!active.current) return;
      if (!created) {
        setError("服务端没有返回任务，请检查时间格式。");
        return;
      }
      setMessage("");
      await refresh();
    } catch (err) {
      if (active.current) setError(errorText(err));
    } finally {
      if (active.current) setBusy(false);
    }
  };

  const cancel = async (entry: ScheduleEntry) => {
    setBusy(true);
    setError("");
    try {
      await cancelSchedule(client, entry.id);
      await refresh();
    } catch (err) {
      if (active.current) setError(errorText(err));
    } finally {
      if (active.current) setBusy(false);
    }
  };

  const agentLabel = (entry: ScheduleEntry) => {
    const agent = agents.find((item) => item.paneId === entry.paneId);
    return agent ? `${agent.label} · ${entry.paneId}` : entry.paneId;
  };

  return (
    <AgentManagementDialog
      title="定时任务"
      description="到点由服务端给这个 agent 发一条固定提示词。错过的时刻只记录，不补发。"
      busy={busy}
      onClose={onClose}
    >
      <div className="agent-dialog-body schedule-panel">
        <div className="schedule-list" aria-label="定时任务列表">
          {schedules === null ? <p className="schedule-empty">正在读取…</p> : null}
          {schedules !== null && schedules.length === 0 ? (
            <p className="schedule-empty">还没有任务。下面可以新建一个。</p>
          ) : null}
          {schedules?.map((entry) => (
            <div key={entry.id} className="schedule-row">
              <AlarmClock size={15} aria-hidden="true" className="schedule-row__icon" />
              <div className="schedule-row__main">
                <div className="schedule-row__head">
                  <span className="schedule-row__when">{entry.due}</span>
                  <span className={`schedule-pill schedule-pill--${entry.status}`}>
                    {STATUS_LABELS[entry.status]}
                  </span>
                  <span className="schedule-row__target">
                    {entry.agent ? <AgentIcon agent={entry.agent} size={13} /> : null}
                    {agentLabel(entry)}
                  </span>
                </div>
                <p className="schedule-row__text">{entry.message}</p>
              </div>
              {entry.status === "pending" ? (
                <button
                  type="button"
                  className="agent-icon-button"
                  aria-label="取消这个任务"
                  title="取消"
                  disabled={busy}
                  onClick={() => void cancel(entry)}
                >
                  <Trash2 size={15} />
                </button>
              ) : null}
            </div>
          ))}
        </div>

        <form onSubmit={submit}>
          <fieldset className="agent-field">
            <label htmlFor="schedule-agent">目标 agent</label>
            <select
              id="schedule-agent"
              className="agent-select-trigger"
              value={paneId}
              onChange={(event) => setPaneId(event.target.value)}
            >
              {agents.map((agent) => (
                <option key={agent.paneId} value={agent.paneId}>
                  {agent.label} · {agent.paneId}
                </option>
              ))}
            </select>
          </fieldset>

          <fieldset className="agent-field">
            <label htmlFor="schedule-at">时间</label>
            <input
              id="schedule-at"
              value={at}
              onChange={(event) => setAt(event.target.value)}
              placeholder="2026-10-12 08:00:00，或只写 08:00"
              autoComplete="off"
            />
            <div className="schedule-quick">
              {(
                [
                  ["+30 分钟", () => stamp(new Date(Date.now() + 30 * 60 * 1000))],
                  ["+1 小时", () => stamp(new Date(Date.now() + 60 * 60 * 1000))],
                  ["今晩 23:00", () => `${stamp(new Date()).slice(0, 10)} 23:00:00`],
                  ["明天 08:00", tomorrowMorning],
                ] as const
              ).map(([label, value]) => (
                <button key={label} type="button" onClick={() => setAt(value())} disabled={busy}>
                  {label}
                </button>
              ))}
            </div>
            <small>只写时刻表示今天的那个点；已经过了就是明天。</small>
          </fieldset>

          <fieldset className="agent-field">
            <label htmlFor="schedule-message">提示词</label>
            <textarea
              id="schedule-message"
              className="schedule-message"
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="到点发给这个 agent 的内容，例如：继续跑昨天没跑完的测试"
              rows={3}
            />
          </fieldset>

          {error ? (
            <p className="error" role="alert">
              {error}
            </p>
          ) : null}

          <footer>
            <button type="button" onClick={onClose}>
              关闭
            </button>
            <button
              type="submit"
              className="agent-primary-button"
              disabled={busy || !paneId || !at.trim() || !message.trim()}
            >
              {busy ? "处理中…" : "新建任务"}
            </button>
          </footer>
        </form>
      </div>
    </AgentManagementDialog>
  );
}

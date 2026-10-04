import { useEffect, useRef, useState } from "react";
import type { AgentView } from "./api";
import type { GatewayClient } from "./gateway";
import { managementError, openedSession, type HistoricalAgentSession, type SessionPage } from "./agentManagement";

export function AgentHistoryPicker({ client, kind, cwd, agents, disabled, selected, onSelect, onOpen }: {
  client: GatewayClient; kind: string; cwd: string; agents: AgentView[]; disabled: boolean;
  selected: string; onSelect: (id: string) => void; onOpen: (paneId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState<number | null>();
  const [next, setNext] = useState<number | null>();
  const [sessions, setSessions] = useState<HistoricalAgentSession[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const filter = `${kind}\0${cwd}\0${query}`;
  const previous = useRef(filter);
  useEffect(() => {
    if (disabled || !cwd || !kind) return;
    let active = true;
    const changed = previous.current !== filter;
    previous.current = filter;
    if (changed) { setSessions([]); setCursor(undefined); setNext(undefined); }
    const currentCursor = changed ? undefined : cursor;
    setLoading(true); setError("");
    const timer = window.setTimeout(() => {
      void client.call<SessionPage>("agent.sessions", { kind, cwd, query, cursor: currentCursor, limit: 30 })
        .then(data => { if (active) {
          setSessions(old => currentCursor != null ? [...old, ...data.sessions] : data.sessions);
          setNext(data.next_cursor);
        } }).catch(err => { if (active) setError(managementError(err)); })
        .finally(() => { if (active) setLoading(false); });
    }, 250);
    return () => { active = false; window.clearTimeout(timer); };
  }, [client, kind, cwd, query, cursor, filter, disabled]);
  return <div className="agent-history-picker">
    <label>搜索历史<input value={query} disabled={disabled} placeholder="标题或会话 ID"
      onChange={event => { setQuery(event.target.value); onSelect(""); }} /></label>
    {error ? <p className="error" role="alert">{error}</p> : null}
    <ul>{sessions.map(session => {
      const opened = openedSession(agents, kind, session);
      return <li key={session.id}>
        <button type="button" disabled={disabled || loading} aria-pressed={selected === session.id}
          onClick={() => opened ? onOpen(opened.paneId) : onSelect(session.id)}>
          <strong>{session.title || session.id}</strong>
          <small>{session.id} · {new Date(session.updated_at).toLocaleString()}</small>
          {opened ? <span>已打开 · 进入</span> : null}
        </button>
      </li>;
    })}</ul>
    {loading ? <p role="status">读取历史会话…</p> : !error && sessions.length === 0 ? <p>该目录下暂无历史会话。</p> : null}
    {next != null ? <button type="button" disabled={disabled || loading} onClick={() => setCursor(next)}>加载更多</button> : null}
  </div>;
}

import { shortenPath, statusLabel, type AgentView } from "./api";
import { ConnectionBadge } from "./ConnectionBadge";
import type { ConnectionState } from "./gateway";
import { ThemeToggle } from "./ThemeToggle";

/** Agent overview grouped by project, matching the reference layout. */
export function AgentList({
  session,
  agents,
  detail,
  connection,
  onOpen,
  onRefresh,
  onLeave,
  onRetry,
}: {
  session: string;
  agents: AgentView[];
  detail?: string;
  connection: ConnectionState;
  onOpen: (paneId: string) => void;
  onRefresh: () => void;
  onLeave: () => void;
  onRetry: () => void;
}) {
  const groups = new Map<string, AgentView[]>();
  for (const agent of agents) {
    const list = groups.get(agent.project) ?? [];
    list.push(agent);
    groups.set(agent.project, list);
  }

  const needsAttention = agents.filter(
    (agent) => agent.status === "blocked" || agent.status === "working",
  ).length;

  return (
    <div className="list-screen">
      <header className="topbar">
        <button type="button" className="ghost" onClick={onLeave} aria-label="Sessions">
          ‹
        </button>
        <span className="topbar-title">
          <span className="title">{session || "agents"}</span>
        </span>
        <button type="button" className="ghost" onClick={onRefresh} aria-label="Refresh">
          ⟳
        </button>
        <ConnectionBadge state={connection} onRetry={onRetry} />
        <ThemeToggle />
      </header>

      <div className="summary">
        <span>
          {groups.size} {groups.size === 1 ? "project" : "projects"}
        </span>
        <span aria-hidden="true">·</span>
        <span>
          {agents.length} {agents.length === 1 ? "agent" : "agents"}
        </span>
        {needsAttention > 0 ? (
          <>
            <span aria-hidden="true">·</span>
            <span className="attention">{needsAttention} active</span>
          </>
        ) : null}
      </div>

      {detail ? <p className="error banner">{detail}</p> : null}

      {agents.length === 0 ? (
        <p className="empty">No agents running in this session.</p>
      ) : null}

      <div className="cards">
        {[...groups.entries()].map(([project, items]) => {
          // A project is "working" when any of its agents is, so the card can
          // carry the state at a glance instead of only in the small pill.
          const running = items.some((agent) => agent.status === "working");
          return (
            <section key={project} className={`card ${running ? "working" : ""}`}>
              <header className="card-head">
                <span className="project">{project}</span>
                <span className="count">
                  {items.length} {items.length === 1 ? "agent" : "agents"}
                </span>
              </header>
              <ul className="rows">
                {items.map((agent) => (
                  <li key={agent.paneId}>
                    <button type="button" onClick={() => onOpen(agent.paneId)}>
                      <span className={`dot ${agent.status}`} aria-hidden="true" />
                      <span className="row-main">
                        <span
                          className={`row-title ${agent.status === "working" ? "working" : ""}`}
                        >
                          {agent.label}
                        </span>
                        <span className="row-sub">{shortenPath(agent.cwd)}</span>
                      </span>
                      <span className={`pill ${agent.status}`}>{statusLabel(agent.status)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}

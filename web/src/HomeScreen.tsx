import { useState } from "react";
import { BackendForm, type BackendDraft } from "./BackendForm";
import { ThemeToggle } from "./ThemeToggle";
import type { BackendRuntime } from "./backends";
import { WEB_UI_VERSION } from "./version";

/** What a connection state reads as on a card. */
const STATE_LABELS: Record<string, string> = {
  ready: "已连接",
  connecting: "连接中",
  authenticating: "认证中",
  reconnecting: "重连中",
  closed: "未连接",
  error: "连接失败",
};

/**
 * The one line under a backend's address: what the connection is doing, and —
 * once a session has been bound on it — what its agents are doing.
 *
 * The agent half is absent for a backend the reader has not opened in this
 * page, and honestly so: an agent list belongs to a session, and the gateway
 * only serves one per connection, so there is nothing to show without binding
 * one. Binding starts a session's server on demand, which is not something to
 * do behind the reader's back from a page load.
 */
function metaLine(runtime: BackendRuntime, needsKey: boolean): string {
  if (needsKey) return "需要密钥";
  const parts: string[] = [];
  if (runtime.state === "ready") {
    const count = runtime.sessions.length;
    parts.push(count === 0 ? "没有会话" : `${count} 个会话`);
  } else {
    parts.push(STATE_LABELS[runtime.state] ?? runtime.state);
  }
  if (runtime.agents.length > 0) {
    const active = runtime.agents.filter(
      (agent) => agent.status === "working" || agent.status === "blocked",
    ).length;
    parts.push(
      active > 0 ? `${runtime.agents.length} 个 agent · ${active} 个进行中` : `${runtime.agents.length} 个 agent`,
    );
  }
  return parts.join(" · ");
}

/** The dot beside a backend's name: connected, working on it, or down. */
function stateDot(runtime: BackendRuntime, needsKey: boolean): string {
  if (needsKey) return "blocked";
  if (runtime.state === "ready") {
    const busy = runtime.agents.some((agent) => agent.status === "working");
    return busy ? "working" : "idle";
  }
  if (runtime.state === "connecting" || runtime.state === "authenticating") return "working";
  return "unknown";
}

/**
 * The list the page opens on: one card per saved gateway.
 *
 * A card is the way in — it leads to that gateway's sessions, then to an agent,
 * then to the conversation. The backend's name is the card's title because that
 * is what the reader will see on every screen behind it, so the two have to be
 * recognizable as the same place.
 */
export function HomeScreen({
  backends,
  onOpen,
  onRetry,
  onSubmit,
  onDelete,
}: {
  backends: BackendRuntime[];
  onOpen: (backendId: string) => void;
  onRetry: (backendId: string) => void;
  /** Adds or edits one, from the form. */
  onSubmit: (draft: BackendDraft, id: string) => void;
  onDelete: (backendId: string) => void;
}) {
  /** The profile being edited, `null` for a new one, `undefined` for closed. */
  const [editing, setEditing] = useState<{ id: string } | null | undefined>(undefined);

  if (editing !== undefined) {
    const initial =
      editing === null ? undefined : backends.find((b) => b.profile.id === editing.id)?.profile;
    return (
      <div className="home-screen">
        <BackendForm
          initial={initial}
          onSubmit={(draft, id) => {
            onSubmit(draft, id);
            setEditing(undefined);
          }}
          onCancel={() => setEditing(undefined)}
        />
      </div>
    );
  }

  return (
    <div className="home-screen">
      <header className="topbar">
        <span className="topbar-title">
          <span className="title">herdr web</span>
          <span className="subtitle">后端</span>
        </span>
        <span className="topbar-spacer" />
        <button type="button" className="ghost" onClick={() => setEditing(null)}>
          New
        </button>
        <ThemeToggle />
        <span className="web-version" title="Web UI build">
          {WEB_UI_VERSION}
        </span>
      </header>

      {backends.length === 0 ? (
        <p className="empty">
          还没有保存的后端。点 <strong>New</strong> 添加一个 herdr 网关。
        </p>
      ) : null}

      <div className="backend-cards">
        {backends.map((runtime) => {
          const profile = runtime.profile;
          const needsKey = !profile.key;
          return (
            <article key={profile.id} className="backend-card">
              <button
                type="button"
                className="backend-card__main"
                onClick={() => (needsKey ? setEditing({ id: profile.id }) : onOpen(profile.id))}
              >
                <span className="backend-card__head">
                  <span className="backend-card__name">{profile.name}</span>
                  <span
                    className={`dot ${stateDot(runtime, needsKey)}`}
                    aria-hidden="true"
                  />
                </span>
                <span className="backend-card__url">{profile.url}</span>
                <span className="backend-card__meta">{metaLine(runtime, needsKey)}</span>
              </button>
              <div className="backend-card__foot">
                {needsKey ? (
                  <button
                    type="button"
                    className="conn conn--retry"
                    onClick={() => setEditing({ id: profile.id })}
                  >
                    <span className="conn__dot" aria-hidden="true" />
                    填入密钥
                  </button>
                ) : (
                  <button
                    type="button"
                    className="conn conn--retry"
                    onClick={() => onRetry(profile.id)}
                  >
                    <span className="conn__dot" aria-hidden="true" />
                    {runtime.state === "ready" ? "已连接" : "重新连接"}
                  </button>
                )}
                <button
                  type="button"
                  className="ghost"
                  onClick={() => setEditing({ id: profile.id })}
                >
                  编辑
                </button>
                <button
                  type="button"
                  className="ghost danger"
                  onClick={() => {
                    if (window.confirm(`删除后端「${profile.name}」？`)) onDelete(profile.id);
                  }}
                >
                  删除
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}

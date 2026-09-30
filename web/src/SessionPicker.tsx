import { useState, type FormEvent } from "react";
import { BackendBadge } from "./BackendBadge";
import type { GatewayClient, SessionSummary } from "./gateway";
import { NotificationPanel } from "./NotificationPanel";
import { ThemeToggle } from "./ThemeToggle";
import type { BackendProfile } from "./settings";
import { WEB_UI_VERSION } from "./version";

interface SessionPickerProps {
  /** The gateway these sessions belong to. */
  backend: BackendProfile;
  sessions: SessionSummary[];
  connected: boolean;
  detail?: string;
  /** Used by the notification settings, which are read from and written to the server. */
  client: GatewayClient;
  onSelect: (name: string) => void;
  onRefresh: () => void;
  /** Returns to the backend list. */
  onBack: () => void;
}

/** Mirrors the server's session name rules so obvious mistakes fail locally. */
function validateSessionName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "enter a session name";
  if (trimmed.length > 64) return "name is too long";
  if (trimmed === "." || trimmed === "..") return "invalid name";
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) {
    return "use only letters, numbers, '.', '_' and '-'";
  }
  return null;
}

export function SessionPicker({
  backend,
  sessions,
  connected,
  detail,
  client,
  onSelect,
  onRefresh,
  onBack,
}: SessionPickerProps) {
  const [newName, setNewName] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const create = (event: FormEvent) => {
    event.preventDefault();
    const error = validateSessionName(newName);
    if (error) {
      setFormError(error);
      return;
    }
    setFormError(null);
    onSelect(newName.trim());
  };

  return (
    <div className="session-picker">
      <header className="topbar">
        <button type="button" className="ghost" onClick={onBack} aria-label="Backends">
          ‹
        </button>
        {/* Which gateway these sessions are on: session names repeat across
            gateways, so the name is the context for everything below it. */}
        <BackendBadge name={backend.name} url={backend.url} />
        <span className="session-name">sessions</span>
        <span className="topbar-spacer" />
        <button type="button" className="ghost" onClick={onRefresh} disabled={!connected}>
          refresh
        </button>
        <button
          type="button"
          className="ghost"
          onClick={() => setSettingsOpen(true)}
          disabled={!connected}
          aria-label="Notification settings"
          title="Notification settings"
        >
          ⚙
        </button>
        <ThemeToggle />
        {/*
          The page is served from disk and can be updated on its own, so its
          version is not the same fact as the server's. Showing it here is how
          you tell a stale tab from a stale binary.
        */}
        <span className="web-version" title="Web UI build">
          {WEB_UI_VERSION}
        </span>
      </header>

      {detail ? <p className="error">{detail}</p> : null}

      <ul className="session-list">
        {sessions.map((session) => (
          <li key={session.name}>
            <button type="button" onClick={() => onSelect(session.name)} disabled={!connected}>
              <span className="session-label">{session.name}</span>
              <span className={session.running ? "status running" : "status stopped"}>
                {session.running ? "running" : "stopped"}
              </span>
            </button>
          </li>
        ))}
        {sessions.length === 0 ? <li className="empty">no sessions yet</li> : null}
      </ul>

      <form className="new-session" onSubmit={create}>
        <label>
          <span>New or existing session</span>
          <input
            type="text"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="work"
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
          />
        </label>
        <button type="submit" disabled={!connected}>
          open
        </button>
        {formError ? <p className="error">{formError}</p> : null}
      </form>

      <p className="hint">
        Opening a session that is not running starts its server. Multiple clients can attach to the
        same session and share one state.
      </p>
      {settingsOpen ? (
        <NotificationPanel client={client} onClose={() => setSettingsOpen(false)} />
      ) : null}
    </div>
  );
}

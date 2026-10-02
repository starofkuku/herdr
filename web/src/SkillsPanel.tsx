import { useCallback, useEffect, useState } from "react";

/** The slice of the gateway client this panel needs. */
interface SkillsPanelClient {
  call: <T>(method: string, params?: Record<string, unknown>) => Promise<T>;
}
import {
  loadSkillContent,
  loadSkills,
  skillInvocationText,
  type SkillContent,
  type SkillEntry,
  type SkillsState,
} from "./skills";

/**
 * The skills installed for one pane's agent, offered as one-tap invocations.
 *
 * A skill is matched by name in conversation, so invoking one sends a prompt
 * that names it and hands over whatever the reader added. The preview shows
 * the `SKILL.md` behind the name, because the description alone does not
 * always say what a skill will do.
 */
export function SkillsPanel({
  client,
  paneId,
  onClose,
  onInvoked,
}: {
  client: SkillsPanelClient;
  paneId: string;
  onClose: () => void;
  /** Called after a prompt was sent, so the page can refresh its view. */
  onInvoked: () => void;
}) {
  const [state, setState] = useState<SkillsState | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [selected, setSelected] = useState<SkillEntry | null>(null);
  const [extra, setExtra] = useState("");
  const [sending, setSending] = useState(false);
  const [preview, setPreview] = useState<SkillContent | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoadFailed(false);
    const loaded = await loadSkills(client, paneId);
    if (!loaded) setLoadFailed(true);
    setState(loaded);
    setSelected(null);
    setExtra("");
    setPreview(null);
  }, [client, paneId]);

  useEffect(() => {
    void refresh();
    return () => {
      setSelected(null);
      setPreview(null);
    };
  }, [refresh]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const openPreview = useCallback(
    async (skill: SkillEntry) => {
      setPreviewFailed(false);
      const content = await loadSkillContent(client, paneId, skill.name);
      if (!content) setPreviewFailed(true);
      setPreview(content);
    },
    [client, paneId],
  );

  const invoke = useCallback(
    async (skill: SkillEntry) => {
      if (sending) return;
      setSending(true);
      setError(null);
      try {
        await client.call("agent.prompt", {
          target: paneId,
          text: skillInvocationText(skill.name, extra),
        });
        onInvoked();
        onClose();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setSending(false);
      }
    },
    [client, extra, onClose, onInvoked, paneId, sending],
  );

  return (
    <div className="notification-panel" onClick={onClose} role="presentation">
      <section
        className="notification-panel__panel skills-panel"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-label="Agent skills"
      >
        <header className="notification-panel__head">
          <h2 className="notification-panel__title">Skills</h2>
          <span className="skills-panel__count">
            {state ? `${state.skills.length} installed` : ""}
          </span>
          <button type="button" className="ghost" onClick={() => void refresh()}>
            Refresh
          </button>
          <button type="button" className="ghost" onClick={onClose} aria-label="Close skills">
            ✕
          </button>
        </header>
        {error ? <p className="error banner">{error}</p> : null}
        <div className="notification-panel__body skills-panel__body">
          {loadFailed ? (
            <p className="skills-panel__note">Skills could not be read from this server.</p>
          ) : !state ? (
            <p className="skills-panel__note">Loading skills…</p>
          ) : state.available === false ? (
            <p className="skills-panel__note">
              This agent has no skill system of its own; the shared skills below
              still apply when the agent reads them.
            </p>
          ) : null}
          {state?.skills.length === 0 && !loadFailed ? (
            <p className="skills-panel__note">
              No skills installed for this agent. `npx skills add &lt;package&gt;` installs one.
            </p>
          ) : null}
          <ul className="skills-panel__list">
            {state?.skills.map((skill) => (
              <li
                key={`${skill.source}:${skill.name}`}
                className={`skills-panel__item${selected === skill ? " selected" : ""}`}
              >
                <button
                  type="button"
                  className="skills-panel__open"
                  onClick={() => {
                    setPreview(null);
                    setSelected(selected === skill ? null : skill);
                    setExtra("");
                  }}
                >
                  <span className="skills-panel__name">{skill.name}</span>
                  <span className={`skills-panel__badge ${skill.source}`}>{skill.source}</span>
                  {skill.description ? (
                    <span className="skills-panel__description">{skill.description}</span>
                  ) : null}
                </button>
                {selected === skill ? (
                  <div className="skills-panel__detail">
                    <input
                      className="skills-panel__input"
                      type="text"
                      placeholder="Optional: what should the skill do?"
                      value={extra}
                      onChange={(event) => setExtra(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") void invoke(skill);
                      }}
                      disabled={sending}
                    />
                    <div className="skills-panel__actions">
                      <button
                        type="button"
                        disabled={sending}
                        onClick={() => void invoke(skill)}
                      >
                        {sending ? "Sending…" : "Invoke"}
                      </button>
                      <button
                        type="button"
                        className="ghost"
                        onClick={() => void openPreview(skill)}
                      >
                        Preview
                      </button>
                    </div>
                    {previewFailed ? (
                      <p className="skills-panel__note">The skill file could not be read.</p>
                    ) : preview ? (
                      <div className="skills-panel__preview">
                        <p className="skills-panel__path">{preview.path}</p>
                        <pre>
                          {preview.content}
                          {preview.truncated ? "\n… (truncated)" : ""}
                        </pre>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      </section>
    </div>
  );
}

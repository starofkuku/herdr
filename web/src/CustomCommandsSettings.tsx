import { useCallback, useState } from "react";

import {
  customCommandSummary,
  loadCustomCommands,
  normalizeCustomCommandName,
  saveCustomCommands,
  type CustomCommand,
} from "./customCommands";

/** The draft the add/edit form holds; `editing` names the command being edited. */
interface CommandDraft {
  /** The stored name when editing an existing command, empty when adding. */
  editing: string;
  name: string;
  content: string;
}

const emptyDraft: CommandDraft = { editing: "", name: "", content: "" };

/**
 * The custom-commands section of the settings panel: named pieces of text to
 * drop into the composer. Saved in this browser, so they apply to every pane
 * and survive server restarts.
 */
export function CustomCommandsSettings({
  onSaved,
}: {
  /** Called after the stored list changed, so the slash menu reloads it. */
  onSaved: () => void;
}) {
  const [commands, setCommands] = useState<CustomCommand[]>(() => loadCustomCommands());
  const [draft, setDraft] = useState<CommandDraft | null>(null);
  const [error, setError] = useState<string | null>(null);

  const persist = useCallback(
    (next: CustomCommand[]) => {
      setCommands(next);
      saveCustomCommands(next);
      onSaved();
    },
    [onSaved],
  );

  const saveDraft = useCallback(() => {
    if (!draft) return;
    const name = normalizeCustomCommandName(draft.name);
    const content = draft.content.trim();
    if (!name) {
      setError("命令名不能为空");
      return;
    }
    if (!content) {
      setError("命令内容不能为空");
      return;
    }
    const clash = commands.some(
      (command) => command.name === name && command.name !== draft.editing,
    );
    if (clash) {
      setError(`/${name} 已经存在`);
      return;
    }
    const next = draft.editing
      ? commands.map((command) =>
          command.name === draft.editing ? { name, content } : command,
        )
      : [...commands, { name, content }];
    persist(next.sort((a, b) => a.name.localeCompare(b.name)));
    setDraft(null);
    setError(null);
  }, [commands, draft, persist]);

  const remove = useCallback(
    (name: string) => {
      persist(commands.filter((command) => command.name !== name));
      if (draft?.editing === name) setDraft(null);
    },
    [commands, draft, persist],
  );

  return (
    <div className="custom-commands-settings">
      {error ? <p className="error banner">{error}</p> : null}
      {draft ? (
        <div className="custom-commands-panel__form">
          <label className="custom-commands-panel__label">
            命令名
            <input
              className="skills-panel__input"
              type="text"
              placeholder="deploy"
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              autoFocus
            />
          </label>
          <label className="custom-commands-panel__label">
            输入内容（发送时展开成这段文本）
            <textarea
              className="custom-commands-panel__textarea"
              rows={4}
              placeholder={"把数据库导出并打开报告\n（可多行）"}
              value={draft.content}
              onChange={(event) => setDraft({ ...draft, content: event.target.value })}
            />
          </label>
          <div className="skills-panel__actions">
            <button type="button" onClick={saveDraft}>
              保存
            </button>
            <button
              type="button"
              className="ghost"
              onClick={() => {
                setDraft(null);
                setError(null);
              }}
            >
              取消
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="custom-commands-panel__add"
          onClick={() => setDraft(emptyDraft)}
        >
          + 添加命令
        </button>
      )}
      <ul className="skills-panel__list">
        {commands.map((command) => (
          <li key={command.name} className="skills-panel__item">
            <button
              type="button"
              className="skills-panel__open"
              onClick={() =>
                setDraft(
                  draft?.editing === command.name
                    ? null
                    : { editing: command.name, name: command.name, content: command.content },
                )
              }
            >
              <span className="skills-panel__name">/{command.name}</span>
              <span className="skills-panel__description">
                {customCommandSummary(command.content)}
              </span>
            </button>
            {draft?.editing === command.name ? (
              <div className="skills-panel__actions">
                <button
                  type="button"
                  className="ghost"
                  onClick={() => void remove(command.name)}
                >
                  删除
                </button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      {commands.length === 0 && !draft ? (
        <p className="skills-panel__note">
          还没有自定义命令。添加后，在输入框打 / 就能快速调用。
        </p>
      ) : null}
    </div>
  );
}

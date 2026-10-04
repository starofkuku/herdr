import { useState } from "react";

import {
  customCommandSummary,
  MAX_CUSTOM_COMMANDS,
  normalizeCustomCommandName,
  type CustomCommand,
} from "./customCommands";

interface CommandDraft {
  /** The stored name when editing an existing command, empty when adding. */
  editing: string;
  name: string;
  content: string;
}

interface SettingsProps {
  commands: CustomCommand[];
  onChange: (commands: CustomCommand[]) => void;
}

const emptyDraft: CommandDraft = { editing: "", name: "", content: "" };

function commandsWithDraft(commands: CustomCommand[], draft: CommandDraft): CustomCommand[] {
  const name = normalizeCustomCommandName(draft.name);
  const content = draft.content.trim();
  if (!name) throw new Error("命令名不能为空");
  if (!content) throw new Error("命令内容不能为空");
  if (commands.some((command) => command.name === name && command.name !== draft.editing)) {
    throw new Error(`/${name} 已经存在`);
  }
  if (!draft.editing && commands.length >= MAX_CUSTOM_COMMANDS) {
    throw new Error(`最多保存 ${MAX_CUSTOM_COMMANDS} 条命令。`);
  }
  const next = draft.editing
    ? commands.map((command) => command.name === draft.editing ? { name, content } : command)
    : [...commands, { name, content }];
  return next.sort((a, b) => a.name.localeCompare(b.name));
}

function useCommandEditor({ commands, onChange }: SettingsProps) {
  const [draft, setDraft] = useState<CommandDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reportError = (err: unknown) =>
    setError(err instanceof Error ? err.message : "保存失败，请重试。");
  const save = () => {
    if (!draft) return;
    try {
      onChange(commandsWithDraft(commands, draft));
      setDraft(null);
      setError(null);
    } catch (err) {
      reportError(err);
    }
  };
  const remove = (name: string) => {
    try {
      onChange(commands.filter((command) => command.name !== name));
      if (draft?.editing === name) setDraft(null);
      setError(null);
    } catch (err) {
      reportError(err);
    }
  };
  const cancel = () => {
    setDraft(null);
    setError(null);
  };
  return { draft, setDraft, error, save, remove, cancel };
}

function CommandEditor({ draft, onDraft, onSave, onCancel }: {
  draft: CommandDraft;
  onDraft: (draft: CommandDraft) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="custom-commands-panel__form">
      <label className="custom-commands-panel__label">
        命令名
        <input
          className="skills-panel__input"
          type="text"
          placeholder="deploy"
          value={draft.name}
          onChange={(event) => onDraft({ ...draft, name: event.target.value })}
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
          onChange={(event) => onDraft({ ...draft, content: event.target.value })}
        />
      </label>
      <div className="skills-panel__actions">
        <button type="button" onClick={onSave}>保存</button>
        <button type="button" className="ghost" onClick={onCancel}>取消</button>
      </div>
    </div>
  );
}

function CommandsList({ commands, draft, onDraft, onRemove }: {
  commands: CustomCommand[];
  draft: CommandDraft | null;
  onDraft: (draft: CommandDraft | null) => void;
  onRemove: (name: string) => void;
}) {
  return (
    <ul className="skills-panel__list">
      {commands.map((command) => (
        <li key={command.name} className="skills-panel__item">
          <button
            type="button"
            className="skills-panel__open"
            onClick={() => onDraft(
              draft?.editing === command.name
                ? null
                : { editing: command.name, name: command.name, content: command.content },
            )}
          >
            <span className="skills-panel__name">/{command.name}</span>
            <span className="skills-panel__description">{customCommandSummary(command.content)}</span>
          </button>
          {draft?.editing === command.name ? (
            <div className="skills-panel__actions">
              <button type="button" className="ghost" onClick={() => onRemove(command.name)}>删除</button>
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** The editor and transfer controls share one saved list in SettingsPanel. */
export function CustomCommandsSettings(props: SettingsProps) {
  const editor = useCommandEditor(props);
  return (
    <div className="custom-commands-settings">
      {editor.error ? <p className="error banner" role="alert">{editor.error}</p> : null}
      {editor.draft ? (
        <CommandEditor
          draft={editor.draft}
          onDraft={editor.setDraft}
          onSave={editor.save}
          onCancel={editor.cancel}
        />
      ) : (
        <button
          type="button"
          className="custom-commands-panel__add"
          onClick={() => editor.setDraft(emptyDraft)}
        >
          + 添加命令
        </button>
      )}
      <CommandsList
        commands={props.commands}
        draft={editor.draft}
        onDraft={editor.setDraft}
        onRemove={editor.remove}
      />
      {props.commands.length === 0 && !editor.draft ? (
        <p className="skills-panel__note">还没有自定义命令。添加后，在输入框打 / 就能快速调用。</p>
      ) : null}
    </div>
  );
}

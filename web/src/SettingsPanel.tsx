import { useEffect, useState } from "react";

import { CustomCommandsSettings } from "./CustomCommandsSettings";
import { CustomCommandsTransfer, type CommandTransferFeedback } from "./CustomCommandsTransfer";
import {
  loadCustomCommands,
  mergeCustomCommands,
  saveCustomCommands,
  type CustomCommand,
} from "./customCommands";

/** One category of the settings panel. New configuration lands as a new entry. */
interface SettingsSection {
  id: "commands";
  label: string;
}

const SECTIONS: readonly SettingsSection[] = [
  { id: "commands", label: "自定义命令" },
];

interface SettingsPanelProps {
  onClose: () => void;
  /** Reloads the slash menu after edits or imports. */
  onCommandsSaved: () => void;
}

function useCommandSettings(onSaved: () => void) {
  const [commands, setCommands] = useState(loadCustomCommands);
  const [feedback, setFeedback] = useState<CommandTransferFeedback | null>(null);
  const persist = (next: CustomCommand[]) => {
    if (!saveCustomCommands(next)) {
      throw new Error("保存失败：浏览器存储不可用或空间不足，原有命令未更改。");
    }
    setCommands(next);
    setFeedback(null);
    onSaved();
  };
  const importCommands = (imported: CustomCommand[]) => {
    // Read after the file loads so edits saved while it was read are retained.
    const result = mergeCustomCommands(loadCustomCommands(), imported);
    if (result.added > 0) persist(result.commands);
    setFeedback({ text: `导入完成：新增 ${result.added} 条，跳过 ${result.skipped} 条同名命令（保留现有内容）。` });
  };
  return { commands, persist, importCommands, feedback, setFeedback };
}

function SettingsNavigation({ section, onSelect }: {
  section: SettingsSection["id"];
  onSelect: (section: SettingsSection["id"]) => void;
}) {
  return (
    <nav className="settings-panel__nav" aria-label="设置分类">
      {SECTIONS.map((entry) => (
        <button
          key={entry.id}
          type="button"
          className={`settings-panel__nav-item${section === entry.id ? " active" : ""}`}
          onClick={() => onSelect(entry.id)}
        >
          {entry.label}
        </button>
      ))}
    </nav>
  );
}

function useSettingsEscape(onClose: () => void) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);
}

/**
 * The settings dialog: a category on the left, that category's page on the
 * right. It opens from the gear in the top bar and starts on the first
 * category.
 */
export function SettingsPanel({ onClose, onCommandsSaved }: SettingsPanelProps) {
  const [section, setSection] = useState<SettingsSection["id"]>("commands");
  const { commands, persist, importCommands, feedback, setFeedback } = useCommandSettings(onCommandsSaved);
  useSettingsEscape(onClose);

  return (
    <div className="notification-panel" onClick={onClose} role="presentation">
      <section
        className="notification-panel__panel settings-panel"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-label="设置"
      >
        <header className="notification-panel__head">
          <h2 className="notification-panel__title">设置</h2>
          <div className="settings-panel__actions">
            <CustomCommandsTransfer
              commands={commands}
              onImport={importCommands}
              onFeedback={setFeedback}
            />
            <button type="button" className="ghost" onClick={onClose} aria-label="关闭设置">✕</button>
          </div>
        </header>
        <div className="settings-panel__body">
          <SettingsNavigation section={section} onSelect={setSection} />
          <div className="settings-panel__content">
            {feedback ? (
              <p
                className={`command-transfer__feedback ${feedback.error ? "error" : "hint"}`}
                role={feedback.error ? "alert" : "status"}
              >
                {feedback.text}
              </p>
            ) : null}
            {section === "commands" ? (
              <CustomCommandsSettings commands={commands} onChange={persist} />
            ) : null}
          </div>
        </div>
      </section>
    </div>
  );
}

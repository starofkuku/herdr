import { useEffect, useState } from "react";
import { Maximize2, Minimize2 } from "lucide-react";

import { CustomCommandsSettings } from "./CustomCommandsSettings";
import { CustomCommandsTransfer, type CommandTransferFeedback } from "./CustomCommandsTransfer";
import { SkillsSettings, type SkillsSettingsProps } from "./SkillsSettings";
import {
  loadCustomCommands,
  mergeCustomCommands,
  saveCustomCommands,
  type CustomCommand,
} from "./customCommands";
import "./settingsPanel.css";

/** One category of the settings panel. New configuration lands as a new entry. */
interface SettingsSection {
  id: "commands" | "skills";
  label: string;
}

const SECTIONS: readonly SettingsSection[] = [
  { id: "commands", label: "自定义命令" },
  { id: "skills", label: "Skills" },
];

interface SettingsPanelProps {
  onClose: () => void;
  /** Reloads the slash menu after edits or imports. */
  onCommandsSaved: () => void;
  /** Present only when the current pane is available in the desktop layout. */
  skills?: SkillsSettingsProps;
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

function SettingsNavigation({ section, onSelect, showSkills }: {
  section: SettingsSection["id"];
  onSelect: (section: SettingsSection["id"]) => void;
  showSkills: boolean;
}) {
  return (
    <nav className="settings-panel__nav" aria-label="设置分类">
      {SECTIONS.filter((entry) => entry.id !== "skills" || showSkills).map((entry) => (
        <button
          key={entry.id}
          type="button"
          className={`settings-panel__nav-item${section === entry.id ? " active" : ""}`}
          onClick={() => onSelect(entry.id)}
          aria-current={section === entry.id ? "page" : undefined}
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

function CommandSettingsContent({ commands, persist, feedback }: ReturnType<typeof useCommandSettings>) {
  return (
    <>
      {feedback ? (
        <p
          className={`command-transfer__feedback ${feedback.error ? "error" : "hint"}`}
          role={feedback.error ? "alert" : "status"}
        >
          {feedback.text}
        </p>
      ) : null}
      <CustomCommandsSettings commands={commands} onChange={persist} />
    </>
  );
}

function SettingsWindowToggle({ maximized, onToggle }: {
  maximized: boolean;
  onToggle: () => void;
}) {
  const label = maximized ? "还原窗口" : "全窗口查看";
  return (
    <button
      type="button"
      className="ghost settings-panel__window-toggle"
      aria-label={label}
      aria-pressed={maximized}
      title={maximized ? `${label} (Esc)` : label}
      onClick={onToggle}
    >
      {maximized ? <Minimize2 size={16} aria-hidden="true" /> : <Maximize2 size={16} aria-hidden="true" />}
    </button>
  );
}

/**
 * The settings dialog: a category on the left, that category's page on the
 * right. It opens from the gear in the top bar and starts on the first
 * category.
 */
export function SettingsPanel({ onClose, onCommandsSaved, skills }: SettingsPanelProps) {
  const [selectedSection, setSection] = useState<SettingsSection["id"]>("commands");
  const [maximized, setMaximized] = useState(false);
  const section = selectedSection === "skills" && !skills ? "commands" : selectedSection;
  const commandSettings = useCommandSettings(onCommandsSaved);
  const { commands, importCommands, setFeedback } = commandSettings;
  useSettingsEscape(maximized ? () => setMaximized(false) : onClose);

  return (
    <div
      className={`notification-panel settings-overlay${maximized ? " settings-overlay--maximized" : ""}`}
      onClick={onClose}
      role="presentation"
    >
      <section
        className="notification-panel__panel settings-panel"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-label="设置"
      >
        <header className="notification-panel__head">
          <h2 className="notification-panel__title">设置</h2>
          <div className="settings-panel__actions">
            {section === "commands" ? (
              <CustomCommandsTransfer commands={commands} onImport={importCommands} onFeedback={setFeedback} />
            ) : null}
            <SettingsWindowToggle maximized={maximized} onToggle={() => setMaximized((value) => !value)} />
            <button type="button" className="ghost" onClick={onClose} aria-label="关闭设置">✕</button>
          </div>
        </header>
        <div className="settings-panel__body">
          <SettingsNavigation section={section} onSelect={setSection} showSkills={Boolean(skills)} />
          <div className="settings-panel__content">
            {section === "commands" ? (
              <CommandSettingsContent {...commandSettings} />
            ) : skills ? <SkillsSettings key={skills.paneId} {...skills} /> : null}
          </div>
        </div>
      </section>
    </div>
  );
}

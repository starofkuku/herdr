import { useEffect, useState } from "react";

import { CustomCommandsSettings } from "./CustomCommandsSettings";

/** One category of the settings panel. New configuration lands as a new entry. */
interface SettingsSection {
  id: "commands";
  label: string;
}

const SECTIONS: readonly SettingsSection[] = [
  { id: "commands", label: "自定义命令" },
];

/**
 * The settings dialog: a category on the left, that category's page on the
 * right. It opens from the gear in the top bar and starts on the first
 * category.
 */
export function SettingsPanel({
  onClose,
  onCommandsSaved,
}: {
  onClose: () => void;
  /** Forwarded to the custom-commands page so the slash menu reloads. */
  onCommandsSaved: () => void;
}) {
  const [section, setSection] = useState<SettingsSection["id"]>("commands");

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

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
          <button type="button" className="ghost" onClick={onClose} aria-label="关闭设置">
            ✕
          </button>
        </header>
        <div className="settings-panel__body">
          <nav className="settings-panel__nav" aria-label="设置分类">
            {SECTIONS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className={`settings-panel__nav-item${section === entry.id ? " active" : ""}`}
                onClick={() => setSection(entry.id)}
              >
                {entry.label}
              </button>
            ))}
          </nav>
          <div className="settings-panel__content">
            {section === "commands" ? (
              <CustomCommandsSettings onSaved={onCommandsSaved} />
            ) : null}
          </div>
        </div>
      </section>
    </div>
  );
}

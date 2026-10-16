/*
 * The phone's share of the topbar: the actions that no longer fit, as a menu.
 *
 * On a narrow screen the conversation header keeps two buttons — the terminal
 * toggle, which shows state, and the "…" that opens this — and everything else
 * arrives here with a label, because an icon alone is a poor target on a phone.
 *
 * The menu hangs from the header itself (absolute, top: 100%), so it sits under
 * the row whatever the row's height; a transparent backdrop covering the page
 * closes it on any tap outside.
 */

import { useEffect, type ReactNode } from "react";

/** One action in the menu: an icon, a name, and what a tap does. */
export interface TopbarMenuItem {
  key: string;
  icon: ReactNode;
  label: string;
  onSelect: () => void;
  disabled?: boolean;
}

export function TopbarOverflowMenu({ items, onClose }: { items: TopbarMenuItem[]; onClose: () => void }) {
  // Escape closes, like every other popover in the app.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      <div className="topbar-menu__backdrop" onClick={onClose} aria-hidden="true" />
      <div className="topbar-menu" role="menu" aria-label="更多操作">
        {items.map((item) => (
          <button
            key={item.key}
            type="button"
            role="menuitem"
            className="topbar-menu__item"
            disabled={item.disabled}
            onClick={() => {
              onClose();
              item.onSelect();
            }}
          >
            <span className="topbar-menu__icon" aria-hidden="true">
              {item.icon}
            </span>
            <span className="topbar-menu__label">{item.label}</span>
          </button>
        ))}
      </div>
    </>
  );
}

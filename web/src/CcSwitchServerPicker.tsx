/*
 * Which server's cc-switch the tool page is on.
 *
 * A dropdown of the app's own rather than the browser's native select: the
 * native one cannot carry the second line — the gateway's host — beside the
 * server's name, does not take the app's own popover styling, and on some
 * platforms opens a menu that belongs to another decade.
 *
 * The shape is the overflow menu's: a button, a transparent backdrop covering
 * the page that closes on any tap outside, Escape, and a menu hanging from the
 * button in the app's popover vocabulary.
 */

import { useEffect, useState } from "react";
import { Check, ChevronDown, Server } from "lucide-react";

export interface CcSwitchServerOption {
  id: string;
  name: string;
  /** The server's gateway URL; its host is shown as the distinguishing second line. */
  url: string;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function CcSwitchServerPicker({
  options,
  value,
  onPick,
}: {
  /** The herdr servers this browser knows; each may run its own cc-switch. */
  options: readonly CcSwitchServerOption[];
  /** The server currently on screen. */
  value: string | null;
  onPick: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);

  // Escape closes, like every other popover in the app.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const current = options.find((option) => option.id === value);

  return (
    <div className="ccswitch-server">
      <button
        type="button"
        className="ccswitch-server__button"
        aria-haspopup="menu"
        aria-expanded={open}
        title="cc-switch 所在的服务器；每个服务器各存一份地址与令牌"
        onClick={() => setOpen((state) => !state)}
      >
        <Server size={13} aria-hidden="true" />
        <span className="ccswitch-server__name">{current?.name ?? "选择服务器"}</span>
        <ChevronDown size={13} aria-hidden="true" className={open ? "ccswitch-server__chevron is-open" : "ccswitch-server__chevron"} />
      </button>
      {open ? (
        <>
          <div className="ccswitch-menu__backdrop" onClick={() => setOpen(false)} aria-hidden="true" />
          <div className="ccswitch-menu" role="menu" aria-label="选择服务器">
            {options.map((option) => (
              <button
                key={option.id}
                type="button"
                role="menuitem"
                className={`ccswitch-menu__item${option.id === value ? " active" : ""}`}
                aria-current={option.id === value || undefined}
                onClick={() => {
                  setOpen(false);
                  onPick(option.id);
                }}
              >
                <span className="ccswitch-menu__texts">
                  <span className="ccswitch-menu__name">{option.name}</span>
                  <span className="ccswitch-menu__host">{hostOf(option.url)}</span>
                </span>
                {option.id === value ? <Check size={13} aria-hidden="true" className="ccswitch-menu__check" /> : null}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

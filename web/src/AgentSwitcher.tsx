import { useEffect, useRef, useState } from "react";
import { ChevronsUpDown } from "lucide-react";
import { shortenPath, statusLabel, type AgentView } from "./api";

/**
 * A jump list for the agents in this session.
 *
 * The back button leads to the list, and moving between two conversations that
 * are already open would then be two navigations. This keeps the same choice one
 * tap away from inside a conversation.
 */
export function AgentSwitcher({
  agents,
  current,
  onSelect,
}: {
  agents: AgentView[];
  current: string | null;
  onSelect: (paneId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  // A menu that outlives the press that dismissed it reads as broken, so a press
  // anywhere outside closes it. Escape does the same for the keyboard.
  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="agent-switcher" ref={root}>
      <button
        type="button"
        className="ghost"
        aria-label="Switch agent"
        aria-expanded={open}
        title="Switch agent"
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronsUpDown size={16} aria-hidden="true" />
      </button>
      {open ? (
        <ul className="switcher-menu" role="listbox" aria-label="Agents in this session">
          {agents.map((item) => (
            <li key={item.paneId}>
              <button
                type="button"
                role="option"
                aria-selected={item.paneId === current}
                className={`switcher-item${item.paneId === current ? " current" : ""}`}
                onClick={() => {
                  setOpen(false);
                  if (item.paneId !== current) onSelect(item.paneId);
                }}
              >
                <span className={`dot ${item.status}`} aria-hidden="true" />
                {/*
                  The name repeats across agents — six panes of one CLI all read
                  "pi" — so the directory is what tells them apart. Stacked
                  rather than inline so the menu stays narrow on a phone.
                */}
                <span className="switcher-main">
                  <span className="switcher-label">{item.label}</span>
                  <span className="switcher-path">
                    {item.project} · {shortenPath(item.cwd)}
                  </span>
                </span>
                <span className="switcher-hint">{statusLabel(item.status)}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

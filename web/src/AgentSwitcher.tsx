import { useEffect, useRef, useState } from "react";
import { ChevronsUpDown } from "lucide-react";
import { AgentIcon } from "./AgentIcon";
import { shortenPath, statusLabel, type AgentView } from "./api";
import { opensBackendGroup } from "./command-search";

/**
 * A jump list for every agent the reader has open.
 *
 * The back button leads to the list, and moving between two conversations that
 * are already open would then be two navigations. This keeps the same choice one
 * tap away from inside a conversation.
 *
 * It spans every backend and groups by backend, for the same reason the palette
 * does: the reader is looking for a pane they remember, and which gateway it is
 * on is a detail of that memory rather than a filter they should have to set.
 */
export function AgentSwitcher({
  agents,
  current,
  currentBackendId,
  onSelect,
}: {
  /** Every agent on every backend; each carries its backend's id and name. */
  agents: AgentView[];
  /** The pane on screen, marked rather than hidden. */
  current: string | null;
  /** The backend the current pane is on, so the mark lands on one row only. */
  currentBackendId?: string | null;
  onSelect: (paneId: string, backendId?: string) => void;
}) {
  const isCurrent = (agent: AgentView) =>
    agent.paneId === current && agent.backendId === currentBackendId;
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
        <ul className="switcher-menu" role="listbox" aria-label="Agents on every backend">
          {agents.map((item, index) => {
            const opensGroup = opensBackendGroup(agents, index);
            return (
            <li key={`${item.backendId ?? ""}:${item.paneId}`}>
              {/* A heading each time the backend changes, so a name that repeats
                  across gateways is not read as the same pane listed twice. */}
              {opensGroup ? <p className="switcher-group">{item.backendName ?? "backend"}</p> : null}
              <button
                type="button"
                role="option"
                aria-selected={isCurrent(item)}
                className={`switcher-item${isCurrent(item) ? " current" : ""}`}
                onClick={() => {
                  setOpen(false);
                  if (!isCurrent(item)) onSelect(item.paneId, item.backendId);
                }}
              >
                {/* Same anatomy as the jump palette's rows: the agent's own
                    mark, then its state. */}
                <span className="switcher-mark">
                  <AgentIcon agent={item.agent} size={15} />
                </span>
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
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

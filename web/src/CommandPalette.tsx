import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { statusLabel, type AgentView } from "./api";
import { describeAgent, matchAgents } from "./command-search";

/**
 * A jump-to-agent palette, opened with Ctrl/Cmd+K.
 *
 * The session activity rail already lists the panes, but reaching it means
 * looking away from the conversation and finding the rail's edge. This is for
 * the other intent: you know which pane you want and would rather type three
 * letters than aim at a row.
 *
 * Centred and modal because it takes the keyboard. An open list that leaves
 * focus in the page behind it would fight the reader's typing, and a palette
 * summoned to be typed into should own the keys until it is done.
 */
export function CommandPalette({
  agents,
  currentPaneId,
  onOpen,
  onClose,
}: {
  agents: AgentView[];
  currentPaneId?: string | null;
  onOpen: (paneId: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);

  const results = useMemo(() => matchAgents(agents, query), [agents, query]);

  // Typing replaces the list, so the highlight has to start over; keeping the
  // index would leave it pointing at whatever slid into that slot.
  useEffect(() => setActive(0), [query]);

  /**
   * Own the keyboard while open, and hand it back on close.
   *
   * A palette that removed itself would drop focus to the document, so the next
   * keystroke would go nowhere and the reader would have to click back into the
   * composer. Whatever held focus when this opened is what gets it again.
   */
  useEffect(() => {
    const previous = document.activeElement;
    inputRef.current?.focus();
    return () => {
      if (previous instanceof HTMLElement && document.contains(previous)) previous.focus();
    };
  }, []);

  // Keep the highlighted row on screen while the list is longer than the box.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const row = list.children[active];
    if (row instanceof HTMLElement) row.scrollIntoView({ block: "nearest" });
  }, [active]);

  const choose = (agent: AgentView | undefined) => {
    if (!agent) return;
    onClose();
    if (agent.paneId !== currentPaneId) onOpen(agent.paneId);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "ArrowDown" || (event.key === "n" && event.ctrlKey)) {
      event.preventDefault();
      setActive((value) => (results.length === 0 ? 0 : (value + 1) % results.length));
      return;
    }
    if (event.key === "ArrowUp" || (event.key === "p" && event.ctrlKey)) {
      event.preventDefault();
      setActive((value) => (results.length === 0 ? 0 : (value - 1 + results.length) % results.length));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      choose(results[active]);
    }
  };

  return (
    <div className="palette" role="dialog" aria-modal="true" aria-label="Jump to an agent">
      {/* Clicking away dismisses, as with every other overlay here. */}
      <button type="button" className="palette__scrim" onClick={onClose} aria-label="Close" />

      <div className="palette__panel" onKeyDown={onKeyDown}>
        <div className="palette__field">
          <Search size={16} aria-hidden="true" className="palette__icon" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            placeholder="Jump to an agent…"
            aria-label="Search agents"
            aria-controls="palette-results"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
          />
          <span className="palette__count">
            {results.length}/{agents.length}
          </span>
        </div>

        {results.length === 0 ? (
          <p className="palette__empty">No agent matches “{query}”.</p>
        ) : (
          <ul className="palette__list" id="palette-results" ref={listRef} role="listbox">
            {results.map((agent, index) => (
              <li key={agent.paneId}>
                <button
                  type="button"
                  role="option"
                  aria-selected={index === active}
                  className={`palette__item${index === active ? " active" : ""}${
                    agent.paneId === currentPaneId ? " current" : ""
                  }`}
                  // Pointer and keyboard share one highlight, so moving the mouse
                  // and then pressing Enter goes where the pointer is pointing.
                  onMouseMove={() => setActive(index)}
                  onClick={() => choose(agent)}
                >
                  <span className={`dot ${agent.status}`} aria-hidden="true" />
                  <span className="palette__name">{agent.label}</span>
                  <span className="palette__meta">{describeAgent(agent)}</span>
                  <span className={`pill ${agent.status}`}>{statusLabel(agent.status)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <footer className="palette__hint">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> 切换
          </span>
          <span>
            <kbd>↵</kbd> 打开
          </span>
          <span>
            <kbd>esc</kbd> 关闭
          </span>
        </footer>
      </div>
    </div>
  );
}
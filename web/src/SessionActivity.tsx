import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Bot } from "lucide-react";
import { shortenPath, statusLabel, type AgentStatus, type AgentView } from "./api";
import { HIGHLIGHT_MS, orderActivity, trackAgents } from "./activity-order";
import {
  loadPlacement,
  panelOpensTo,
  placementForDrop,
  positionOf,
  savePlacement,
  snapZonesFor,
  type Placement,
  type Side,
  type SnapZone,
} from "./activity-placement";

/**
 * Every pane in this session, in a rail that can be parked anywhere on the page.
 *
 * The order is the point: panes that are running or waiting come first, then
 * everything else by which changed most recently. A session is often one checkout
 * per agent doing the same job, so the list has to answer "which one needs me"
 * before it answers "what exists".
 *
 * The rail is draggable and its position is remembered, because which part of the
 * screen is free depends on the reader's window layout. Dropping it near an edge
 * docks it there — half a pixel of gap reads as a mistake rather than a position —
 * and anywhere else it stays exactly where it was let go.
 *
 * It opens itself when an agent finishes, because a finish is the one event here
 * that is worthless if unseen: the row would flash behind a closed rail, and the
 * reader would find a "done" badge that looks identical to one from an hour ago.
 * It closes itself again once the flash is over, unless the reader opened it.
 */
export function SessionActivity({
  agents,
  currentPaneId,
  onOpen,
}: {
  agents: AgentView[];
  /** Kept in the list, marked, so the rail still reads as the whole session. */
  currentPaneId?: string | null;
  onOpen: (paneId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  /** Set while the rail is open because of a finish, not because it was asked. */
  const autoOpened = useRef(false);

  /**
   * Panes that finished recently, and the status they came from.
   *
   * A finish is the event a reader misses: work in another pane ends silently,
   * and the "done" badge looks the same a minute later as it did at the moment it
   * changed. Cleared after the highlight rather than kept, so opening the rail
   * later does not re-announce an old finish.
   */
  const [finishes, setFinishes] = useState<Record<string, AgentStatus>>({});
  /**
   * When each pane was last seen to change status, as a monotonic counter.
   *
   * The server publishes no activity timestamp, and a clock reading would be
   * wrong anyway: the list only has to know which pane moved most recently, not
   * when. A counter answers that without touching the protocol.
   */
  const [lastSeen, setLastSeen] = useState<Record<string, number>>({});
  const tick = useRef(0);
  const previousStatuses = useRef<Map<string, AgentStatus>>(new Map());

  const [placement, setPlacement] = useState<Placement>(() => loadPlacement());
  /**
   * The live drag offset while a pointer is down.
   *
   * Separate from `placement` so a drag in progress does not write to storage on
   * every move, and so releasing can decide to dock without having committed the
   * half-finished position first.
   */
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  /** Where the pointer grabbed the handle, in panel-relative coordinates. */
  const grab = useRef({ x: 0, y: 0 });
  /** Whether the pointer moved, which separates a click from a drag. */
  const moved = useRef(false);
  const railRef = useRef<HTMLElement | null>(null);

  /** Re-rendered on resize so a docked rail follows its edge. */
  const [viewport, setViewport] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));

  useEffect(() => {
    const onResize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  /*
   * A list that outlives the press that dismissed it reads as broken, so a press
   * anywhere outside closes it. Escape does the same for the keyboard.
   *
   * `mousedown` rather than `click`: the handle's own press has to be excluded
   * before it turns into a drag, and a click fires too late to stop that. The rail
   * contains the check, so a press on the handle is not "outside".
   */
  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: MouseEvent) => {
      if (!railRef.current?.contains(event.target as Node)) {
        autoOpened.current = false;
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        autoOpened.current = false;
        setOpen(false);
      }
    };

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    const { finishes: seen, changed } = trackAgents(agents, previousStatuses.current);

    if (changed.length > 0) {
      setLastSeen((current) => {
        const next = { ...current };
        for (const paneId of changed) next[paneId] = ++tick.current;
        return next;
      });
    }

    if (Object.keys(seen).length === 0) return;

    setFinishes((current) => ({ ...current, ...seen }));
    // The flash is inside the rail, so the rail has to be out for it to count.
    setOpen(true);
    autoOpened.current = true;

    const panes = Object.keys(seen);
    const timer = window.setTimeout(() => {
      setFinishes((current) => {
        const next = { ...current };
        for (const paneId of panes) delete next[paneId];
        return next;
      });
      // Leave it open if the reader took over while it was showing.
      if (autoOpened.current) {
        autoOpened.current = false;
        setOpen(false);
      }
    }, HIGHLIGHT_MS);

    return () => window.clearTimeout(timer);
  }, [agents]);

  /**
   * The handle is both a button and a drag grip, so the two gestures have to be
   * told apart: a press that never moves is a click that toggles the list, and a
   * press that moves is a drag. `moved` is what separates them, and it also stops
   * the click that ends a drag from toggling the rail.
   */
  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    // Ignore secondary buttons; a right-click is not a drag.
    if (event.button !== 0) return;
    const rail = railRef.current;
    if (!rail) return;
    const box = rail.getBoundingClientRect();
    grab.current = { x: event.clientX - box.left, y: event.clientY - box.top };
    moved.current = false;
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    moved.current = true;
    setDrag({ x: event.clientX - grab.current.x, y: event.clientY - grab.current.y });
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const target = event.currentTarget;
    if (target.hasPointerCapture(event.pointerId)) {
      target.releasePointerCapture(event.pointerId);
    }

    if (!moved.current) {
      // A plain click: toggle, and hand control back to the reader.
      autoOpened.current = false;
      setOpen((value) => !value);
      setDrag(null);
      return;
    }

    const dropped = drag;
    setDrag(null);
    // The rail moved, so where the list used to open is stale.
    setOpen(false);
    if (!dropped) return;

    const box = { width: railWidth(), height: 0 };
    const landed = placementForDrop(dropped, viewport, box);
    setPlacement(landed);
    savePlacement(landed);
  };

  const busy = agents.filter((agent) => agent.status === "working" || agent.status === "blocked");
  const finished = agents.filter((agent) => agent.status === "done");
  const ordered = orderActivity(agents, lastSeen);

  // A session with no panes has nothing to pin, and a handle counting zero would
  // be pure chrome.
  if (agents.length === 0) return null;

  const box = { width: railWidth(), height: railHeight(railRef.current) };
  const live = drag ?? positionOf(placement, viewport, box);
  const zones: SnapZone[] = drag
    ? snapZonesFor(live.x, live.y, box.width, viewport.width)
    : [];
  // While dragging, the list opens towards the middle of the screen from wherever
  // the rail currently is, so it never opens off the edge.
  const opensTo: Side = drag ? panelOpensTo(live.x, box.width, viewport.width) : panelSide(placement);

  return (
    <>
      {/*
        The drop zones: one gradient band per edge the rail would attach to if
        released now. Shown only while dragging and only when a release would
        actually hold, so the tint means something rather than decorating the
        drag. A corner lights up both bands, because it holds on both axes.
      */}
      {zones.map((zone) => (
        <div key={zone} className={`dock-zone dock-zone--${zone}`} aria-hidden="true" />
      ))}

      <aside
        ref={railRef}
        className={`session-activity opens-${opensTo}${open ? " open" : ""}${
          drag ? " dragging" : ""
        }${placement.side ? ` docked dock-${placement.side}` : " floating"}${
          placement.top ? " at-top" : ""
        }`}
        style={{ left: `${live.x}px`, top: `${live.y}px` }}
        aria-label="Session activity"
      >
        <div className="session-activity__panel" aria-hidden={!open}>
          <ul className="session-activity__list">
            {ordered.map((agent) => {
              const highlight = finishes[agent.paneId];
              return (
                <li key={agent.paneId}>
                  <button
                    type="button"
                    className={`session-activity__item${
                      agent.paneId === currentPaneId ? " current" : ""
                    }${highlight ? " finished" : ""}`}
                    onClick={() => {
                      // The row did its job; keeping the list out would cover the
                      // conversation that was just opened.
                      autoOpened.current = false;
                      setOpen(false);
                      onOpen(agent.paneId);
                    }}
                    title={agent.cwd}
                  >
                    <span className={`dot ${agent.status}`} aria-hidden="true" />
                    {/*
                      The directory is what tells two panes apart: a session's panes
                      are usually the same agent in different checkouts, so the name
                      alone repeats. Stacked rather than inline so the rail stays
                      narrow.
                    */}
                    <span className="session-activity__main">
                      <span className="session-activity__name">{agent.label}</span>
                      <span className="session-activity__path">{shortenPath(agent.cwd)}</span>
                    </span>
                    <span className={`pill ${agent.status}`}>{statusLabel(agent.status)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        <button
          type="button"
          className="session-activity__head"
          aria-expanded={open}
          aria-label={`Agents: ${busy.length} working, ${finished.length} finished. Drag to move.`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          {/*
            An icon rather than a word: the handle is thirty-two pixels wide, and a
            label there has to be set sideways to fit. The count badges carry the
            information, so the marker only has to say what the counts are about.
          */}
          <Bot className="session-activity__mark" size={15} aria-hidden="true" />
          {busy.length > 0 ? (
            <span className="session-activity__busy" title={`${busy.length} working`}>
              {busy.length}
            </span>
          ) : null}
          {finished.length > 0 ? (
            <span className="session-activity__done" title={`${finished.length} finished`}>
              {finished.length}
            </span>
          ) : null}
        </button>
      </aside>
    </>
  );
}

/** The handle's width is the rail's width while collapsed, which is all that matters. */
function railWidth(): number {
  return 32;
}

function railHeight(element: HTMLElement | null): number {
  return element?.getBoundingClientRect().height ?? 58;
}

/** Which side a docked rail opens towards. */
function panelSide(placement: Placement): Side {
  if (placement.side === "left") return "right";
  if (placement.side === "right") return "left";
  // Floating: open towards the middle of the screen.
  return panelOpensTo(placement.x, railWidth(), window.innerWidth);
}

import { useRef } from "react";
import { AgentIcon } from "./AgentIcon";
import { shortenPath, statusLabel, type AgentView } from "./api";
import { ringPlacement, type RingPlacement } from "./agent-cycle";
import type { Cycle } from "./useAgentCycle";

/**
 * How far the pointer must travel before it may move the highlight.
 *
 * Turning the ring carries the cards under the pointer, so a pointer that is
 * merely resting on the panel would otherwise land on the next card each time it
 * turned, and the next — a carousel that spins by itself. Requiring real
 * movement means the ring only turns because the reader asked it to.
 */
const HOVER_SLOP_PX = 6;

/**
 * The window switcher, drawn over everything while the chord is held.
 *
 * The candidates stand on a ring rather than in a row: the highlighted card is
 * turned to face the reader flat on, and its neighbours follow the curve away
 * and back into the page. That is a better use of the screen than a row — the
 * cards that step away are seen at an angle, so more of them are visible in the
 * same width — and it is also how the reader can see that the walk goes round
 * rather than ending.
 *
 * What a card cannot carry is the Windows thumbnail: a pane has no picture to
 * take, and drawing the live transcript into a card would be a second renderer
 * with its own bugs. So a card carries identity and state, which is how the
 * reader picks between them anyway.
 *
 * Identity is the hard part: a reader with four panes of the same agent in four
 * directories gets four cards whose label, mark, and status are identical, and a
 * wall of identical cards is a switcher that cannot be used. The project name
 * and the shortened directory are therefore given equal billing with the label,
 * because they are what actually tells those four apart.
 */
export function AgentCycleOverlay({
  cycle,
  currentPaneId,
  currentBackendId,
}: {
  cycle: Cycle;
  /** Where the reader came from, marked so the walk has a visible origin. */
  currentPaneId: string | null;
  currentBackendId: string | null;
}) {
  /** Where the pointer last made a choice, so a resting hand cannot make another. */
  const lastPoint = useRef<{ x: number; y: number } | null>(null);
  const chosen = cycle.order[cycle.index];

  const onPointerMove = (event: React.PointerEvent) => {
    const card = (event.target as Element).closest(".agent-cycle__card");
    const index = Number(card?.getAttribute("data-index"));
    if (!Number.isInteger(index)) return;
    const last = lastPoint.current;
    if (last && Math.hypot(event.clientX - last.x, event.clientY - last.y) < HOVER_SLOP_PX) return;
    if (index === cycle.index) return;
    lastPoint.current = { x: event.clientX, y: event.clientY };
    cycle.highlight(index);
  };

  if (!chosen) return null;

  return (
    <div className="agent-cycle" role="dialog" aria-modal="true" aria-label="切换 agent">
      {/*
        The dim and the blur, on their own layer. A filter sits on the element
        that carries it, so keeping it off the ring's ancestors is what stops the
        three dimensions from being flattened into two.
      */}
      <div className="agent-cycle__scrim" aria-hidden="true" />

      <div className="agent-cycle__head">
        <span className="agent-cycle__name">{chosen.project || chosen.label}</span>
        <span className="agent-cycle__where">
          {[chosen.agent, chosen.backendName, shortenPath(chosen.cwd)]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </div>

      <div className="agent-cycle__stage" onPointerMove={onPointerMove}>
        {cycle.order.map((agent, index) => (
          <Card
            key={`${agent.backendId ?? ""}:${agent.paneId}`}
            agent={agent}
            index={index}
            selectedIndex={cycle.index}
            origin={agent.paneId === currentPaneId && agent.backendId === currentBackendId}
            onPick={cycle.pick}
          />
        ))}
      </div>

      <p className="agent-cycle__hint">松开 Shift 切换 · Esc 取消 · 点击卡片直接打开</p>
    </div>
  );
}

/** Where a card sits on the ring, as the transform the browser will animate. */
function transformFor(placement: RingPlacement): string {
  const x = placement.x.toFixed(3);
  const y = placement.y.toFixed(3);
  const z = placement.z.toFixed(3);
  const parts = [
    "translate(-50%, -50%)",
    `translateX(${x}rem)`,
    `translateY(${y}rem)`,
    `translateZ(${z}rem)`,
    `rotateY(${placement.angle}deg)`,
  ];
  return parts.join(" ");
}

/**
 * One candidate, placed on the ring.
 *
 * The title is the project rather than the agent name, because the agent name is
 * exactly what repeats: four panes of pi are four cards called "pi", and the card
 * has to answer "which one" instead. The mark says which agent it is, the title
 * and directory say which project, and the status — spelled out rather than left
 * as a colour — says whether it is worth going to.
 */
function Card({
  agent,
  index,
  selectedIndex,
  origin,
  onPick,
}: {
  agent: AgentView;
  index: number;
  /** The card the ring has turned to face the reader. */
  selectedIndex: number;
  origin: boolean;
  onPick: (index: number) => void;
}) {
  const placement = ringPlacement(index, selectedIndex);
  const selected = index === selectedIndex;
  const classes = [
    "agent-cycle__card",
    selected ? "agent-cycle__card--selected" : "",
    origin ? "agent-cycle__card--origin" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={classes}
      data-index={index}
      aria-current={selected ? "true" : undefined}
      onClick={() => onPick(index)}
      style={{
        /*
         * The `translate(-50%, -50%)` centres the card on its point on the ring
         * before the ring's own transform moves it, so every card turns about
         * its own middle. The function list is identical for every card, which
         * is what lets the browser interpolate one placement into the next and
         * the ring appear to turn rather than to jump.
         */
        transform: transformFor(placement),
        opacity: placement.opacity,
        pointerEvents: placement.interactive ? "auto" : "none",
      }}
    >
      {/*
        A corner chip rather than a suffix on the title: the title is the first
        thing a narrow card ellipsises, and a marker that vanishes exactly when
        the card is crowded would be worse than none.
      */}
      {origin ? <span className="agent-cycle__origin">当前</span> : null}
      <span className="agent-cycle__mark">
        <AgentIcon agent={agent.agent} size={34} />
      </span>
      <span className="agent-cycle__label" title={agent.label}>
        {agent.project || agent.label}
      </span>
      <span className="agent-cycle__path" title={agent.cwd}>
        {shortenPath(agent.cwd)}
      </span>
      <span className="agent-cycle__status">
        <span className={`dot ${agent.status}`} aria-hidden="true" />
        {statusLabel(agent.status)}
      </span>
      <span className="agent-cycle__backend">{agent.backendName ?? ""}</span>
    </div>
  );
}

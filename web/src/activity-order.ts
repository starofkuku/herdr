import type { AgentStatus, AgentView } from "./api";

/**
 * What changed since the previous snapshot.
 *
 * `finishes` holds the panes that moved from `working` to `done`, which is the
 * transition the panel announces. `changed` holds every pane whose status moved
 * at all, which is what recency ordering is built from — a pane going idle also
 * just happened, and the reader's sense of "recent" should follow that.
 *
 * Only `working` → `done` counts as a finish. A pane that was never seen running
 * finished before this panel was looking, and `idle` is the state an agent sits
 * in normally, so treating it as a completion would highlight every pane on load.
 * The previous status has to be remembered rather than derived: a timestamp
 * cannot tell "finished while you watched" from "finished an hour ago".
 *
 * `previous` is updated in place, and panes that are gone are dropped from it —
 * a closed pane's id can be reused, and a remembered `working` would make the new
 * pane look like it finished the moment it appeared.
 *
 * Pure apart from that map, so the rules are testable without a running panel.
 */
export function trackAgents(
  agents: AgentView[],
  previous: Map<string, AgentStatus>,
): { finishes: Record<string, AgentStatus>; changed: string[] } {
  const finishes: Record<string, AgentStatus> = {};
  const changed: string[] = [];

  for (const agent of agents) {
    const before = previous.get(agent.paneId);
    previous.set(agent.paneId, agent.status);
    if (before === undefined || before === agent.status) continue;
    changed.push(agent.paneId);
    if (agent.status === "done" && before === "working") {
      finishes[agent.paneId] = before;
    }
  }

  const live = new Set(agents.map((agent) => agent.paneId));
  for (const paneId of [...previous.keys()]) {
    if (!live.has(paneId)) previous.delete(paneId);
  }

  return { finishes, changed };
}

/** The finishes alone, for callers that do not care about ordering. */
export function detectFinishes(
  agents: AgentView[],
  previous: Map<string, AgentStatus>,
): Record<string, AgentStatus> {
  return trackAgents(agents, previous).finishes;
}

/**
 * The panes in the order the panel shows them.
 *
 * Status first, recency second: a pane that needs the reader must not be pushed
 * down by a pane that merely moved recently. Within a status the most recently
 * changed comes first, and panes never seen changing keep the server's order
 * behind them — which on a fresh page is all of them, so the list is at worst
 * arbitrarily ordered for the first few seconds.
 *
 * Returns a new array; the caller's `agents` state is read elsewhere.
 */
export function orderActivity(
  agents: AgentView[],
  lastSeen: Record<string, number>,
): AgentView[] {
  return [...agents].sort((a, b) => {
    const byStatus = ACTIVITY_ORDER[a.status] - ACTIVITY_ORDER[b.status];
    if (byStatus !== 0) return byStatus;
    // Absent means "never seen change", which sorts after every known time.
    return (lastSeen[b.paneId] ?? -1) - (lastSeen[a.paneId] ?? -1);
  });
}

/**
 * Statuses that put a pane at the top of the list, in display order.
 *
 * `working` and `blocked` are the states where the reader is the next step, and
 * `done` is the state they asked to be told about. Everything else is context.
 */
const ACTIVITY_ORDER: Record<AgentStatus, number> = {
  working: 0,
  blocked: 1,
  done: 2,
  idle: 3,
  unknown: 4,
};

/**
 * How long the row stays marked, and how long the panel stays open for it.
 *
 * Shared by the JS timer and the CSS animation, so the flash cannot be cut short
 * by a panel that closes first.
 */
export const HIGHLIGHT_MS = 2600;

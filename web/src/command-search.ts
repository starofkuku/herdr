import { shortenPath, statusLabel, type AgentView } from "./api";

/**
 * The agents a query matches, best match first.
 *
 * Subsequence matching rather than substring matching: a reader typing `hrdr`
 * expects to reach `~/githubwork/herdr`, and a reader typing `wN pi` expects to
 * reach a pane whose id and agent are separate fields. Every character of the
 * query has to appear in order, which keeps the result predictable — a fuzzy
 * score that allows reordering is much harder to reason about when a list is
 * short enough to read.
 *
 * The fields are searched in the order a reader thinks about them: the agent's
 * name, then the directory it runs in, then the pane id. A match in an earlier
 * field wins, so typing `pi` lists panes named pi before panes sitting in a
 * directory called `pipeline`.
 *
 * Pure, so the ranking is testable without a rendered panel.
 */
export function matchAgents(agents: AgentView[], query: string): AgentView[] {
  const needle = normalize(query);
  if (!needle) return agents;

  const scored: { agent: AgentView; rank: number; span: number }[] = [];
  for (const agent of agents) {
    let best: { rank: number; span: number } | null = null;
    for (const [rank, field] of searchFields(agent).entries()) {
      const span = subsequenceSpan(normalize(field), needle);
      if (span === null) continue;
      if (best === null || rank < best.rank || (rank === best.rank && span < best.span)) {
        best = { rank, span };
      }
    }
    if (best) scored.push({ agent, rank: best.rank, span: best.span });
  }

  // Shortest match first: a query that lands in three characters is a better hit
  // than one scattered across thirty, whatever field it landed in.
  return scored
    .sort((a, b) => a.rank - b.rank || a.span - b.span || a.agent.label.localeCompare(b.agent.label))
    .map((entry) => entry.agent);
}

/** The fields searched, in the order a match in them should win. */
function searchFields(agent: AgentView): string[] {
  return [agent.label, agent.agent, agent.cwd, shortenPath(agent.cwd), agent.project, agent.paneId];
}

/** Lowercased with separators collapsed, so `~/foo` and `~/ foo` match alike. */
function normalize(value: string): string {
  return value.toLowerCase().replace(/[\s/\\_.-]+/g, " ").trim();
}

/**
 * How far apart the query's characters are in `text`, or null when they are not
 * all present in order.
 *
 * A tighter match is a better one, and the distance is what says so.
 */
function subsequenceSpan(text: string, needle: string): number | null {
  let at = 0;
  let first = -1;
  let last = -1;
  for (const char of needle) {
    if (char === " ") continue;
    const found = text.indexOf(char, at);
    if (found === -1) return null;
    if (first === -1) first = found;
    last = found;
    at = found + 1;
  }
  return first === -1 ? null : last - first;
}

/** What a row shows besides its name, for the search list. */
export function describeAgent(agent: AgentView): string {
  const where = shortenPath(agent.cwd);
  return `${statusLabel(agent.status)} · ${where}`;
}
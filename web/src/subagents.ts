// Subagent runs started by the agent in a pane, as exposed by `pane.subagents`.
//
// herdr does not track these itself. The server reads them back from the
// pi-subagents extension's own state, and that extension prunes finished runs —
// so an empty answer is ordinary, never an error, and the bar simply hides.

/** One tool invocation a subagent made. */
export interface SubagentToolCall {
  tool: string;
  /** Arguments as recorded; for shell tools this is the command text. */
  args: string;
}

/** One subagent run. */
export interface SubagentRun {
  run_id: string;
  /** `single` for one child, `workflow` for a run that spawns others. */
  mode: string;
  /** `running`, `complete`, `failed`, or `stopped`. */
  state: string;
  agent: string;
  task?: string;
  /**
   * A file the task description names.
   *
   * This is the parent's declared intent, not evidence of what the run wrote:
   * the extension records no file effects for a child that only runs commands.
   */
  target?: string;
  cwd?: string;
  started_at?: number;
  ended_at?: number;
  turn_count?: number;
  tool_count?: number;
  tokens?: number;
  /** Present only while the run is live. */
  current_tool?: string;
  current_tool_args?: string;
  /** The workflow run this one belongs to, when it is a child of one. */
  parent_workflow_run_id?: string;
  tools?: SubagentToolCall[];
  output?: string[];
  /** Result files the extension wrote for this run. */
  artifacts?: string[];
}

/** The slice of the gateway client this module needs. */
interface SubagentClient {
  call: <T>(method: string, params?: Record<string, unknown>) => Promise<T>;
}

/** How often the bar re-asks while something is running. */
export const SUBAGENT_POLL_MS = 4000;

/**
 * Reads the pane's subagent runs.
 *
 * A failure resolves to an empty snapshot rather than rejecting: the bar is
 * supplementary, and losing it should not turn the view into an error.
 */
export async function loadSubagents(
  client: SubagentClient,
  paneId: string,
): Promise<{ active: number; runs: SubagentRun[] }> {
  try {
    const response = await client.call<{
      subagents?: { active?: unknown; runs?: unknown };
    }>("pane.subagents", { pane_id: paneId });
    const payload = response?.subagents;
    return { active: parseActive(payload?.active, payload?.runs), runs: parseRuns(payload?.runs) };
  } catch {
    return { active: 0, runs: [] };
  }
}

/**
 * Keeps only entries that are usable as a run.
 *
 * `mode`, `state`, and `agent` are required because every rendering decision
 * keys off them; everything else is optional, since the extension omits fields
 * depending on the run's state.
 */
export function parseRuns(value: unknown): SubagentRun[] {
  if (!Array.isArray(value)) return [];
  const runs: SubagentRun[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const raw = entry as Record<string, unknown>;
    if (typeof raw.run_id !== "string" || !raw.run_id) continue;
    if (typeof raw.agent !== "string") continue;
    runs.push({
      run_id: raw.run_id,
      mode: typeof raw.mode === "string" ? raw.mode : "single",
      state: typeof raw.state === "string" ? raw.state : "unknown",
      agent: raw.agent,
      ...optionalStrings(raw),
      ...optionalNumbers(raw),
      tools: parseTools(raw.tools),
      output: stringList(raw.output),
      artifacts: stringList(raw.artifacts),
    });
  }
  return runs;
}

function optionalStrings(raw: Record<string, unknown>): Partial<SubagentRun> {
  const out: Partial<SubagentRun> = {};
  for (const key of [
    "task",
    "target",
    "cwd",
    "current_tool",
    "current_tool_args",
    "parent_workflow_run_id",
  ] as const) {
    if (typeof raw[key] === "string" && raw[key]) out[key] = raw[key] as string;
  }
  return out;
}

function optionalNumbers(raw: Record<string, unknown>): Partial<SubagentRun> {
  const out: Partial<SubagentRun> = {};
  for (const key of [
    "started_at",
    "ended_at",
    "turn_count",
    "tool_count",
    "tokens",
  ] as const) {
    const value = raw[key];
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

function parseTools(value: unknown): SubagentToolCall[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const raw = entry as Record<string, unknown>;
    if (typeof raw.tool !== "string") return [];
    return [{ tool: raw.tool, args: typeof raw.args === "string" ? raw.args : "" }];
  });
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

/**
 * The active count.
 *
 * Taken from the runs rather than trusted from the server, so the number on the
 * bar always agrees with the list behind it. A run the server considered active
 * but this client dropped as malformed must not be counted.
 */
function parseActive(value: unknown, runs: unknown): number {
  const parsed = parseRuns(runs);
  if (parsed.length === 0 && typeof value === "number") {
    // No usable runs but a count: report nothing rather than a number with
    // nothing behind it.
    return 0;
  }
  return parsed.filter(isRunning).length;
}

/** Whether a run is still going. */
export function isRunning(run: SubagentRun): boolean {
  return run.state === "running";
}

/**
 * What a run is doing right now, in one line.
 *
 * A live run has a current tool; a finished one is described by its state
 * alone, because the extension drops the tool fields when it settles.
 */
export function activity(run: SubagentRun): string {
  if (isRunning(run)) {
    const args = run.current_tool_args?.trim();
    if (run.current_tool && args) return `${run.current_tool} ${args}`;
    if (run.current_tool) return run.current_tool;
  }
  return run.state;
}

/** The runs that belong to a workflow, keyed by that workflow's run id. */
export function childRuns(runs: SubagentRun[], parentId: string): SubagentRun[] {
  return runs.filter((run) => run.parent_workflow_run_id === parentId);
}

/** The top-level runs: everything that is not a child of another run. */
export function rootRuns(runs: SubagentRun[]): SubagentRun[] {
  const ids = new Set(runs.map((run) => run.run_id));
  return runs.filter(
    (run) => !run.parent_workflow_run_id || !ids.has(run.parent_workflow_run_id),
  );
}

/** Shortens a path for display. */
export function shortPath(path: string, max = 3): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= max) return path;
  return `…/${parts.slice(-max).join("/")}`;
}

/**
 * Groups finished runs by the turn that was running when they started.
 *
 * A run is placed under the turn whose time span contains its `started_at`, so
 * the record appears where the work was asked for rather than at the bottom of
 * the pane forever. Runs that started before the oldest loaded turn, or whose
 * timestamps are missing, come back under `unplaced` instead of being dropped:
 * the panel still has to account for them, just in the fallback position.
 *
 * `run.started_at` is milliseconds (the extension records `startedAt` that way and
 * the API passes it through), while `turn.started_at` is Unix seconds. The
 * conversion happens here, where both are in hand, rather than being spread
 * across callers.
 */
export function runsByTurn(
  runs: SubagentRun[],
  turns: { turn_id: string; started_at?: number; completed_at?: number }[],
): { byTurn: Map<string, SubagentRun[]>; unplaced: SubagentRun[] } {
  const byTurn = new Map<string, SubagentRun[]>();
  const unplaced: SubagentRun[] = [];

  for (const run of runs) {
    if (run.started_at === undefined) {
      unplaced.push(run);
      continue;
    }
    const at = Math.floor(run.started_at / 1000);

    // The last turn that had already started, which is the one in progress when
    // the run began. Turns are chronological, so the first match walking forward
    // is the one to keep.
    let found: string | undefined;
    for (const turn of turns) {
      const started = turn.started_at;
      if (started === undefined) continue;
      // A turn with no end is still open, so anything after its start belongs to
      // it; otherwise the run has to fall inside the span.
      const ended = turn.completed_at;
      const withinSpan = ended === undefined ? at >= started : at >= started && at <= ended;
      if (withinSpan) found = turn.turn_id;
      if (started > at) break;
    }

    if (found === undefined) {
      unplaced.push(run);
      continue;
    }
    const existing = byTurn.get(found);
    if (existing) existing.push(run);
    else byTurn.set(found, [run]);
  }

  return { byTurn, unplaced };
}

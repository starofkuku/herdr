// Typed views over the herdr JSON API responses.
//
// Only the fields the UI consumes are declared; the API may return more.

/** Agent lifecycle state as reported by herdr. */
export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export interface AgentRecord {
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  agent?: string;
  name?: string;
  title?: string;
  display_agent?: string;
  agent_status: AgentStatus;
  cwd?: string;
  foreground_cwd?: string;
  focused?: boolean;
  agent_session?: AgentSessionRecord;
}

/**
 * Native agent session identity, reported by the agent's own integration.
 *
 * `value` is either a transcript path or an opaque session id; only `path`
 * kinds can be used to read the conversation off disk.
 */
export interface AgentSessionRecord {
  source?: string;
  agent?: string;
  kind?: string;
  value?: string;
}

export interface WorkspaceRecord {
  workspace_id: string;
  label?: string;
  number?: number;
  agent_status?: AgentStatus;
  pane_count?: number;
  tab_count?: number;
  focused?: boolean;
}

export interface TabRecord {
  tab_id: string;
  workspace_id: string;
  label?: string;
  number?: number;
  agent_status?: AgentStatus;
  pane_count?: number;
  focused?: boolean;
}

/** One agent shown in the UI, with its workspace resolved. */
export interface AgentView {
  paneId: string;
  workspaceId: string;
  /** Name shown as the card title. */
  label: string;
  /** Detected agent, for example "pi" or "codex". */
  agent: string;
  status: AgentStatus;
  /** Workspace label, used as the project heading. */
  project: string;
  /** Directory shown under the title. */
  cwd: string;
  /** Local path of the agent's own transcript, when the agent reports one. */
  transcriptPath?: string;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asStatus(value: unknown): AgentStatus {
  switch (value) {
    case "idle":
    case "working":
    case "blocked":
    case "done":
      return value;
    default:
      return "unknown";
  }
}

/** True when a workspace contains an activity report for any known agent. */
export function agentsFromSnapshot(
  agents: unknown,
  workspaces: unknown,
): AgentView[] {
  const workspaceLabels = new Map<string, string>();
  if (Array.isArray(workspaces)) {
    for (const raw of workspaces) {
      const workspace = raw as Partial<WorkspaceRecord>;
      const id = asString(workspace.workspace_id);
      if (!id) continue;
      workspaceLabels.set(
        id,
        asString(workspace.label) ?? `workspace ${workspace.number ?? ""}`.trim(),
      );
    }
  }

  const out: AgentView[] = [];
  if (!Array.isArray(agents)) return out;
  for (const raw of agents) {
    const agent = raw as Partial<AgentRecord>;
    const paneId = asString(agent.pane_id);
    const workspaceId = asString(agent.workspace_id);
    if (!paneId || !workspaceId) continue;
    const detected = asString(agent.agent) ?? "";
    out.push({
      paneId,
      workspaceId,
      label:
        asString(agent.name) ??
        asString(agent.title) ??
        asString(agent.display_agent) ??
        (detected || paneId),
      agent: detected,
      status: asStatus(agent.agent_status),
      project: workspaceLabels.get(workspaceId) ?? workspaceId,
      cwd: asString(agent.foreground_cwd) ?? asString(agent.cwd) ?? "",
      transcriptPath: transcriptPathOf(agent),
    });
  }
  return out;
}

/**
 * The agent's own transcript on disk, if it reported one.
 *
 * Only `kind: "path"` values are usable; session ids name an internal agent
 * session, not a readable file.
 */
function transcriptPathOf(agent: Partial<AgentRecord>): string | undefined {
  const session = agent.agent_session;
  if (!session || session.kind !== "path") return undefined;
  return asString(session.value);
}

/** Human-readable label for a status value. */
export function statusLabel(status: AgentStatus): string {
  switch (status) {
    case "working":
      return "working";
    case "blocked":
      return "needs input";
    case "done":
      return "done";
    case "idle":
      return "idle";
    default:
      return "unknown";
  }
}

/** Order statuses so urgent ones surface first. */
const STATUS_ORDER: Record<AgentStatus, number> = {
  blocked: 0,
  working: 1,
  done: 2,
  idle: 3,
  unknown: 4,
};

export function compareAgents(a: AgentView, b: AgentView): number {
  const byStatus = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
  if (byStatus !== 0) return byStatus;
  return a.label.localeCompare(b.label);
}

/**
 * Rows requested per history page.
 *
 * The API caps a single read, so the detail view pages backwards through the
 * transcript instead of asking for everything at once.
 */
export const HISTORY_PAGE_LINES = 120;

/**
 * How often to re-read a page while an agent is working.
 *
 * The API emits no event when a pane's scrollback grows, so a live view has to
 * poll for it. The interval is a compromise between latency and load: fast
 * enough that a streaming answer keeps appearing, slow enough that a long turn
 * does not hammer the server.
 */
export const LIVE_POLL_MS = 1500;

/**
 * The pane a `pane.updated` event refers to.
 *
 * Subscriptions are per event kind rather than per pane, so every pane's update
 * reaches every listener. Callers use this to ignore updates for panes they are
 * not showing: a busy session emits these constantly for unrelated panes.
 */
export function paneIdOfEvent(payload: unknown): string | undefined {
  const data = (payload as { data?: { pane?: { pane_id?: unknown } } } | null)?.data;
  const id = data?.pane?.pane_id;
  return typeof id === "string" ? id : undefined;
}

/** Extracts the text of a `pane.read` response. */
export function paneText(envelope: Record<string, unknown>): string {
  const read = envelope.read as { text?: unknown } | undefined;
  return typeof read?.text === "string" ? read.text : "";
}

/** How many rows of history currently exist behind the newest row. */
export function scrollbackRows(envelope: Record<string, unknown>): number {
  const pane = (envelope.data as { pane?: { scroll?: { max_offset_from_bottom?: unknown } } })
    ?.pane;
  const value = pane?.scroll?.max_offset_from_bottom;
  return typeof value === "number" && value > 0 ? value : 0;
}

/** Formats a directory for display, shortening the home prefix. */
export function shortenPath(path: string): string {
  const home = path.match(/^\/(?:home|Users)\/[^/]+/);
  return home ? path.replace(home[0], "~") : path;
}

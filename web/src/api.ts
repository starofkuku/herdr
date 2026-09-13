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
    });
  }
  return out;
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

/** Extracts the text of a `pane.read` response. */
export function paneText(envelope: Record<string, unknown>): string {
  const read = envelope.read as { text?: unknown } | undefined;
  return typeof read?.text === "string" ? read.text : "";
}

/** Formats a directory for display, shortening the home prefix. */
export function shortenPath(path: string): string {
  const home = path.match(/^\/(?:home|Users)\/[^/]+/);
  return home ? path.replace(home[0], "~") : path;
}

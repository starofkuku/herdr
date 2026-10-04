import { ApiError, type GatewayClient } from "./gateway";
import type { AgentView, WorkspaceRecord } from "./api";

export interface AgentKind { kind: string; label: string; available: boolean; resumable: boolean }
export interface AgentCatalog { agents: AgentKind[]; home: string }
export interface HistoricalAgentSession { id: string; title: string; cwd: string; updated_at: number; path?: string }
export interface SessionPage { sessions: HistoricalAgentSession[]; next_cursor?: number | null }
export interface DirectoryPage { path: string; parent?: string | null; directories: { name: string; path: string }[] }
export interface LaunchForm { kind: string; cwd: string; name: string; workspace_id: string; project_label: string; session_id: string }
export interface AgentManagementProps {
  client: GatewayClient;
  agents: AgentView[];
  connected: boolean;
  onOpen: (paneId: string) => void;
  onRefresh: () => void;
}
export type Workspace = WorkspaceRecord & { worktree?: { checkout_path: string } };
export function managementError(error: unknown): string {
  if (error instanceof ApiError && (/unknown_method|method_not_found|unsupported_method/.test(error.code) ||
    (error.code === "invalid_request" && /unknown variant.*(?:agent\.catalog|agent\.sessions|agent\.launch|directories\.list)/s.test(error.message)))) {
    return "当前后端尚不支持此功能，请更新 Herdr 后端后重试。";
  }
  if (error instanceof ApiError && error.code === "confirmation_required") {
    return "此操作会关闭受保护的 worktree 分组，请在 CLI 中确认关闭。";
  }
  return error instanceof Error ? error.message : "操作失败，请重试。";
}
export function openedSession(agents: AgentView[], kind: string, session: HistoricalAgentSession) {
  return agents.find(agent => agent.agent === kind &&
    (agent.sessionId === session.id || (!!session.path && agent.transcriptPath === session.path)));
}

import { useEffect, useRef, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Ellipsis, Square } from "lucide-react";
import type { AgentView } from "./api";
import type { GatewayClient } from "./gateway";
import { AgentManagementDialog } from "./AgentManagementDialog";
import { managementError, type Workspace } from "./agentManagement";

export function AgentCloseButton({ agent, client, connected, onRefresh }: {
  agent: AgentView; client: GatewayClient; connected: boolean; onRefresh: () => void;
}) {
  const [open, setOpen] = useState(false);
  return <>
    <DropdownMenu.Root><DropdownMenu.Trigger className="agent-menu-trigger" disabled={!connected} aria-label={`${agent.label} 操作`}>
      <Ellipsis size={18} /></DropdownMenu.Trigger>
      <DropdownMenu.Portal><DropdownMenu.Content className="agent-menu-content" align="end" sideOffset={6}
        onCloseAutoFocus={event => { if (open) event.preventDefault(); }}>
        <DropdownMenu.Item className="agent-menu-item" onSelect={() => setOpen(true)}><Square size={14} />关闭 Agent</DropdownMenu.Item>
      </DropdownMenu.Content></DropdownMenu.Portal>
    </DropdownMenu.Root>
    {open ? <AgentCloseDialog agent={agent} client={client} connected={connected}
      onRefresh={onRefresh} onClose={() => setOpen(false)} /> : null}
  </>;
}

function useCloseAgent(client: GatewayClient, agent: AgentView, connected: boolean, onDone: () => void) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [workspace, setWorkspace] = useState<Workspace>();
  const active = useRef(true);
  const inFlight = useRef(false);
  useEffect(() => {
    active.current = true;
    void client.call<{ workspaces: Workspace[] }>("workspace.list").then(result => {
      if (active.current) setWorkspace(result.workspaces.find(item => item.workspace_id === agent.workspaceId));
    }).catch(err => { if (active.current) setError(managementError(err)); });
    return () => { active.current = false; };
  }, [client, agent.workspaceId]);
  const close = async () => {
    if (!connected || inFlight.current || !workspace) return;
    inFlight.current = true; setBusy(true); setError("");
    try {
      await client.call("pane.close", { pane_id: agent.paneId });
      if (active.current) onDone();
    } catch (err) { if (active.current) setError(managementError(err)); }
    finally { inFlight.current = false; if (active.current) setBusy(false); }
  };
  return { error, busy, workspace, close };
}

function AgentCloseDialog({ agent, client, connected, onRefresh, onClose }: {
  agent: AgentView; client: GatewayClient; connected: boolean; onRefresh: () => void; onClose: () => void;
}) {
  const { error, busy, workspace, close } = useCloseAgent(client, agent, connected, () => { onRefresh(); onClose(); });
  return <AgentManagementDialog title="关闭 Agent" busy={busy} onClose={onClose}>
    <div className="agent-dialog-body"><p>关闭 <strong>{agent.label}</strong> 的窗格及运行进程？</p>
    <p className="agent-path">{agent.cwd}</p><p>状态：{agent.status}</p>
    <p>这会结束整个 Agent，不只是停止本轮回答。已有历史日志会保留。</p>
    {workspace?.pane_count === 1 ? <p>这是项目中的最后一个窗格，项目分组也会关闭。</p> : null}
    {!connected ? <p>连接恢复后才能操作。</p> : null}
    {error ? <p className="error" role="alert">{error}</p> : null}
    </div><footer><button type="button" disabled={busy} onClick={onClose}>取消</button>
      <button className="agent-danger-button" type="button" disabled={busy || !connected || !workspace} onClick={() => void close()}>
        {busy ? "正在关闭…" : "确认关闭"}</button></footer>
  </AgentManagementDialog>;
}

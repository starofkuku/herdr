/*
 * Restarting an agent: close the pane, launch the same agent again.
 *
 * The reason this exists is the provider switch: cc-switch rewrites the agent's
 * configuration files, and a running process reads them only at startup, so
 * after a switch the agent has to be brought back to pick the new provider up.
 * The conversation survives — the agent's own session is resumed — so the
 * restart costs a process, not the history.
 *
 * Closing comes first because a launch that finds the session already running
 * simply points at the old pane: the process has to be gone before the new one
 * can own the session.
 */

import { useEffect, useRef, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Ellipsis, RotateCw, Square } from "lucide-react";
import type { AgentView } from "./api";
import type { DetailClient } from "./AgentDetail";
import { AgentManagementDialog } from "./AgentManagementDialog";
import { managementError } from "./agentManagement";

function restartRequestId(): string {
  return `web-restart-${Date.now().toString(36)}-${Array.from(crypto.getRandomValues(new Uint32Array(4)), (value) => value.toString(16)).join("")}`;
}

/**
 * Closes the pane and launches the same agent again.
 *
 * The launch mirrors what the pane already was — kind, directory, name,
 * workspace — and passes the agent's own session id, which the backend turns
 * into that agent's resume arguments. Without a reported session the restart
 * is still useful: a fresh agent in the same place, reading the new provider.
 */
export async function restartAgent(client: DetailClient, agent: AgentView): Promise<string> {
  await client.call("pane.close", { pane_id: agent.paneId });
  const result = await client.call<{ pane_id: string }>("agent.launch", {
    request_id: restartRequestId(),
    kind: agent.agent,
    cwd: agent.cwd,
    name: agent.label,
    workspace_id: agent.workspaceId,
    ...(agent.sessionId ? { session_id: agent.sessionId } : {}),
  });
  return result.pane_id;
}

function useRestartAgent(client: DetailClient, agent: AgentView, connected: boolean, onRestarted: (pane: string) => void) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const restart = async () => {
    if (!connected || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const pane = await restartAgent(client, agent);
      if (active.current) onRestarted(pane);
    } catch (err) {
      if (active.current) setError(managementError(err));
    } finally {
      inFlight.current = false;
      if (active.current) setBusy(false);
    }
  };
  return { error, busy, restart };
}

export function AgentRestartDialog({ agent, client, connected, onRestarted, onClose }: {
  agent: AgentView;
  client: DetailClient;
  connected: boolean;
  onRestarted: (pane: string) => void;
  onClose: () => void;
}) {
  const { error, busy, restart } = useRestartAgent(client, agent, connected, (pane) => {
    onRestarted(pane);
    onClose();
  });
  return (
    <AgentManagementDialog title="重启 Agent" busy={busy} onClose={onClose}>
      <div className="agent-dialog-body">
        <p>
          重启 <strong>{agent.label}</strong>？
        </p>
        <p className="agent-path">{agent.cwd}</p>
        <p>当前进程会结束，然后以同样的目录{agent.sessionId ? "和会话" : ""}重新打开。</p>
        <p>切换供应商后需要这样重启一次，新配置才会生效。</p>
        {!connected ? <p>连接恢复后才能操作。</p> : null}
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
      <footer>
        <button type="button" disabled={busy} onClick={onClose}>
          取消
        </button>
        <button className="agent-primary-button" type="button" disabled={busy || !connected} onClick={() => void restart()}>
          {busy ? "正在重启…" : "确认重启"}
        </button>
      </footer>
    </AgentManagementDialog>
  );
}

/** The topbar's restart control: an icon that asks before it restarts. */
export function AgentRestartIconButton({ agent, client, connected, onRestarted }: {
  agent: AgentView;
  client: DetailClient;
  connected: boolean;
  onRestarted: (pane: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="ghost"
        onClick={() => setOpen(true)}
        disabled={!connected}
        aria-label="重启"
        title="重启 Agent（结束当前进程，保留会话重新打开；切换供应商后需要）"
      >
        <RotateCw size={15} aria-hidden="true" />
      </button>
      {open ? (
        <AgentRestartDialog agent={agent} client={client} connected={connected} onRestarted={onRestarted} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}

/** The list row's menu, with restarting beside closing. */
export function AgentRowMenu({ agent, client, connected, onRefresh }: {
  agent: AgentView;
  client: DetailClient;
  connected: boolean;
  onRefresh: () => void;
}) {
  const [restartOpen, setRestartOpen] = useState(false);
  const [closeOpen, setCloseOpen] = useState(false);
  return (
    <>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger className="agent-menu-trigger" disabled={!connected} aria-label={`${agent.label} 操作`}>
          <Ellipsis size={18} />
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className="agent-menu-content" align="end" sideOffset={6} onCloseAutoFocus={(event) => event.preventDefault()}>
            <DropdownMenu.Item className="agent-menu-item" onSelect={() => setRestartOpen(true)}>
              <RotateCw size={14} />
              重启 Agent
            </DropdownMenu.Item>
            <DropdownMenu.Item className="agent-menu-item" onSelect={() => setCloseOpen(true)}>
              <Square size={14} />
              关闭 Agent
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      {restartOpen ? (
        <AgentRestartDialog agent={agent} client={client} connected={connected} onRestarted={() => onRefresh()} onClose={() => setRestartOpen(false)} />
      ) : null}
      {closeOpen ? <RowCloseDialog agent={agent} client={client} connected={connected} onRefresh={onRefresh} onClose={() => setCloseOpen(false)} /> : null}
    </>
  );
}

/* The close half of the menu, unchanged from the button it replaced. */
function RowCloseDialog({ agent, client, connected, onRefresh, onClose }: {
  agent: AgentView;
  client: DetailClient;
  connected: boolean;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!busy) setError("");
  }, [busy]);
  const close = async () => {
    if (!connected || busy) return;
    setBusy(true);
    setError("");
    try {
      await client.call("pane.close", { pane_id: agent.paneId });
      onRefresh();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <AgentManagementDialog title="关闭 Agent" busy={busy} onClose={onClose}>
      <div className="agent-dialog-body">
        <p>
          关闭 <strong>{agent.label}</strong> 的窗格及运行进程？
        </p>
        <p className="agent-path">{agent.cwd}</p>
        <p>状态：{agent.status}</p>
        <p>这会结束整个 Agent，不只是停止本轮回答。已有历史日志会保留。</p>
        {!connected ? <p>连接恢复后才能操作。</p> : null}
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
      <footer>
        <button type="button" disabled={busy} onClick={onClose}>
          取消
        </button>
        <button className="agent-danger-button" type="button" disabled={busy || !connected} onClick={() => void close()}>
          {busy ? "正在关闭…" : "确认关闭"}
        </button>
      </footer>
    </AgentManagementDialog>
  );
}

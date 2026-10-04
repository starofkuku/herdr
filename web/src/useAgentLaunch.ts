import { ApiError } from "./gateway";
import { useEffect, useRef, useState } from "react";
import { managementError, type AgentCatalog, type AgentManagementProps, type LaunchForm, type Workspace } from "./agentManagement";

export function useAgentLaunch({ client, connected, onOpen, onRefresh }: AgentManagementProps) {
  const [catalog, setCatalog] = useState<AgentCatalog>();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [createdPane, setCreatedPane] = useState<string>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<LaunchForm>({ kind: "", cwd: "", name: "", workspace_id: "", project_label: "", session_id: "" });
  const attempt = useRef<{ payload: string; id: string } | undefined>(undefined);
  const inFlight = useRef(false);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => {
    if (!connected) return;
    let current = true;
    setLoading(true); setError("");
    void Promise.all([client.call<AgentCatalog>("agent.catalog"),
      client.call<{ workspaces: Workspace[] }>("workspace.list")]).then(([data, list]) => {
      if (!current) return;
      setCatalog(data); setWorkspaces(list.workspaces);
      setForm(old => ({ ...old, kind: old.kind || data.agents.find(agent => agent.available)?.kind || "", cwd: old.cwd || data.home }));
    }).catch(err => { if (current) setError(managementError(err)); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [client, connected]);
  const launch = async () => {
    if (!connected || inFlight.current) return;
    inFlight.current = true; setBusy(true); setError("");
    try {
      if (createdPane) {
        const listed = await client.call<{ panes: { pane_id: string }[] }>("pane.list");
        if (listed.panes.some(pane => pane.pane_id === createdPane)) {
          await client.call("pane.close", { pane_id: createdPane });
        }
        if (active.current) setCreatedPane(undefined);
        attempt.current = undefined;
      }
      const params = { kind: form.kind, cwd: form.cwd.trim(), name: form.name.trim() || undefined,
        workspace_id: form.workspace_id || undefined, project_label: form.workspace_id ? undefined : form.project_label.trim() || undefined,
        session_id: form.session_id || undefined };
      const payload = JSON.stringify(params);
      if (attempt.current?.payload !== payload) attempt.current = { payload, id: `web-launch-${Date.now().toString(36)}-${Array.from(crypto.getRandomValues(new Uint32Array(4)), value => value.toString(16)).join("")}` };
      const result = await client.call<{ pane_id: string }>("agent.launch", { ...params, request_id: attempt.current.id });
      if (active.current) { onRefresh(); onOpen(result.pane_id); }
    } catch (err) { if (active.current) {
      const details = err instanceof ApiError ? err.details : undefined;
      const stage = typeof details?.stage === "string" ? `（阶段：${details.stage}）` : "";
      setError(`${managementError(err)}${stage}`);
      if (typeof details?.pane_id === "string") { setCreatedPane(details.pane_id); onRefresh(); }
    } }
    finally { inFlight.current = false; if (active.current) setBusy(false); }
  };
  return { createdPane, catalog, workspaces, error, loading, busy, form, setForm, launch };
}

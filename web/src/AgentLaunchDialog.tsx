import { useState } from "react";
import * as ToggleGroup from "@radix-ui/react-toggle-group";
import { ArrowRight, History, LoaderCircle, Plus, Terminal } from "lucide-react";
import { AgentManagementDialog } from "./AgentManagementDialog";
import { AgentSelect } from "./AgentSelect";
import { AgentDirectoryPicker } from "./AgentDirectoryPicker";
import { AgentHistoryPicker } from "./AgentHistoryPicker";
import type { AgentManagementProps } from "./agentManagement";
import { useAgentLaunch } from "./useAgentLaunch";

export function AgentLaunchDialog(props: AgentManagementProps & { onClose: () => void }) {
  const model = useAgentLaunch(props);
  const [resume, setResume] = useState(false);
  const { createdPane, form, setForm, catalog, workspaces, loading, busy, error, launch } = model;
  const disabled = busy || loading || !props.connected;
  const supportsResume = catalog?.agents.find(agent => agent.kind === form.kind)?.resumable;
  const change = (field: keyof typeof form, value: string) => setForm(old => ({ ...old, [field]: value }));
  const selectWorkspace = (id: string) => {
    const workspace = workspaces.find(item => item.workspace_id === id);
    const cwd = workspace?.worktree?.checkout_path || props.agents.find(agent => agent.workspaceId === id)?.cwd;
    setForm(old => ({ ...old, workspace_id: id, cwd: cwd || old.cwd, session_id: "" }));
  };
  return <AgentManagementDialog title="新增 Agent" description="选择你的编码助手，在指定项目中开始工作。" busy={busy} onClose={props.onClose}>
    <form onSubmit={event => { event.preventDefault(); void launch(); }}>
      <div className="agent-dialog-body tw:space-y-5">
        {error ? <p className="error" role="alert">{error}</p> : null}
        {createdPane ? <p>上次创建的窗格仍保留。可修改表单；重试会关闭该窗格及其中的进程，再按当前设置创建。
          <button type="button" disabled={!props.connected} onClick={() => props.onOpen(createdPane)}>查看已创建窗格</button></p> : null}
        {!props.connected ? <p role="status">连接恢复后才能操作。</p> : null}
        {loading ? <p role="status">读取可用 Agent…</p> : null}
        <fieldset disabled={disabled} className="tw:grid tw:grid-cols-1 tw:gap-4 tw:sm:grid-cols-2">
          <AgentSelect label="Agent 类型" value={form.kind} disabled={disabled} onChange={kind => {
            setForm(old => ({ ...old, kind, session_id: "" })); setResume(false);
          }} options={catalog?.agents.map(agent => ({ value: agent.kind, label: `${agent.label}${agent.available ? "" : "（未安装）"}`, disabled: !agent.available })) || []} />
          <AgentSelect label="所属项目" value={form.workspace_id || "__new__"} disabled={disabled}
            onChange={id => selectWorkspace(id === "__new__" ? "" : id)} options={[
              { value: "__new__", label: "新建项目" }, ...workspaces.map(workspace => ({ value: workspace.workspace_id, label: workspace.label || workspace.workspace_id }))]} />
          {!form.workspace_id ? <label className="tw:sm:col-span-2">项目名称 <span className="agent-optional">可选</span>
            <input value={form.project_label} placeholder="例如：我的项目" onChange={event => change("project_label", event.target.value)} /></label> : null}
          <div className="tw:sm:col-span-2"><AgentDirectoryPicker client={props.client} cwd={form.cwd} disabled={disabled}
            onChange={cwd => setForm(old => ({ ...old, cwd, session_id: "" }))} /></div>
          <label className="tw:sm:col-span-2">Agent 名称 <span className="agent-optional">可选</span>
            <input value={form.name} placeholder="例如：frontend-agent" maxLength={32} pattern="[a-z][a-z0-9_\-]{0,31}"
              title="以小写字母开头，仅含小写字母、数字、下划线或连字符，最多 32 位" onChange={event => change("name", event.target.value)} />
            <small>以小写字母开头，可含数字、_ 和 -，最多 32 位。</small></label>
        </fieldset>
        <div className="agent-field"><span className="agent-field-label">打开方式</span>
          <ToggleGroup.Root className="agent-session-mode" type="single" value={resume ? "resume" : "new"} disabled={disabled}
            aria-label="打开方式" onValueChange={value => { if (value) { setResume(value === "resume"); change("session_id", ""); } }}>
            <ToggleGroup.Item value="new"><Plus size={17} /><span>新会话<small>开始新的任务</small></span></ToggleGroup.Item>
            <ToggleGroup.Item value="resume" disabled={!supportsResume}><History size={17} />
              <span>恢复历史<small>{supportsResume ? "接着上次的进度" : "此 Agent 暂不支持"}</small></span></ToggleGroup.Item>
          </ToggleGroup.Root>
        </div>
        {resume ? <AgentHistoryPicker key={`${form.kind}:${form.cwd}`} client={props.client} kind={form.kind} cwd={form.cwd}
          agents={props.agents} disabled={disabled} selected={form.session_id} onSelect={id => change("session_id", id)} onOpen={props.onOpen} /> : null}
        <p className="agent-management-note tw:flex tw:items-center tw:gap-2"><Terminal size={15} />与 CLI 同步，不打断当前工作。</p>
      </div>
      <footer><button type="button" disabled={busy} onClick={props.onClose}>取消</button>
        <button className="agent-primary-button" type="submit" disabled={disabled || !form.kind || !form.cwd.trim() || (resume && !form.session_id)}>
          {busy ? <LoaderCircle size={16} className="tw:animate-spin" /> : <ArrowRight size={16} />}
          {busy ? "正在处理…" : createdPane ? "关闭失败窗格并重试" : resume ? "恢复会话" : "启动 Agent"}</button></footer>
    </form>
  </AgentManagementDialog>;
}

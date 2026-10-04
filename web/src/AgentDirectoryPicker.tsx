import { useEffect, useId, useState } from "react";
import { Folder, FolderOpen } from "lucide-react";
import { AgentDirectoryInput } from "./AgentDirectoryInput";
import type { GatewayClient } from "./gateway";
import { managementError, type DirectoryPage } from "./agentManagement";

export function AgentDirectoryPicker({ client, cwd, disabled, onChange }: {
  client: GatewayClient; cwd: string; disabled: boolean; onChange: (path: string) => void;
}) {
  const inputId = useId();
  const [browse, setBrowse] = useState(false);
  const [path, setPath] = useState<string>();
  const [page, setPage] = useState<DirectoryPage>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!browse || disabled) return;
    let active = true;
    setLoading(true); setError(""); setPage(undefined);
    void client.call<DirectoryPage>("directories.list", { path }).then(data => {
      if (active) setPage(data);
    }).catch(err => { if (active) setError(managementError(err)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [client, path, browse, disabled]);
  return <div>
    <label htmlFor={inputId}>工作目录</label>
    <AgentDirectoryInput id={inputId} client={client} value={cwd} disabled={disabled} onChange={onChange}>
    <button type="button" disabled={disabled} onClick={() => { setPath(cwd || undefined); setBrowse(!browse); }}>
      <FolderOpen size={16} />{browse ? "收起" : "浏览"}</button></AgentDirectoryInput>
    {browse ? <div className="agent-directory-browser">
      {loading ? <p role="status">读取目录…</p> : null}
      {error ? <p role="alert" className="error">{error}</p> : null}
      {page ? <><p className="agent-path">{page.path}</p>
        <button type="button" disabled={disabled} onClick={() => { onChange(page.path); setBrowse(false); }}>使用此目录</button>
        {page.parent ? <button type="button" disabled={disabled} onClick={() => setPath(page.parent || undefined)}>上一级</button> : null}
        <ul>{page.directories.map(dir => <li key={dir.path}><button type="button" disabled={disabled}
          onClick={() => setPath(dir.path)}><Folder size={15} />{dir.name}</button></li>)}</ul>
      </> : null}
    </div> : null}
  </div>;
}

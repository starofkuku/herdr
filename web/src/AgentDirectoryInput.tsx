import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Folder } from "lucide-react";
import type { GatewayClient } from "./gateway";
import { useDirectorySuggestions } from "./useDirectorySuggestions";

export function AgentDirectoryInput({ id, client, value, disabled, onChange, children }: {
  id: string; client: GatewayClient; value: string; disabled: boolean; onChange: (path: string) => void;
  children: ReactNode;
}) {
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [selected, setSelected] = useState(0);
  const suggestions = useDirectorySuggestions(client, value, focused && !dismissed && !disabled);
  const open = focused && !dismissed && !disabled && suggestions.supported;
  const index = Math.min(selected, suggestions.matches.length - 1);
  useEffect(() => {
    if (open && index >= 0) document.getElementById(`${listId}-${index}`)?.scrollIntoView({ block: "nearest" });
  }, [index, open, listId, value]);
  const choose = (path: string) => {
    const separator = path.includes("\\") ? "\\" : "/";
    onChange(path.endsWith(separator) ? path : path + separator);
    setSelected(0); setDismissed(false); input.current?.focus();
  };
  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); setDismissed(true); }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault(); setDismissed(false);
      const count = suggestions.matches.length;
      if (count) setSelected(open ? (index + (event.key === "ArrowDown" ? 1 : -1) + count) % count : 0);
    }
    if (event.key === "Enter" && open) {
      event.preventDefault();
      if (index >= 0) choose(suggestions.matches[index].path);
    }
  };
  return <div onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}>
    <div className="agent-directory-input"><input ref={input} id={id} required value={value} disabled={disabled}
      role="combobox" aria-autocomplete="list" aria-expanded={open} aria-controls={open ? listId : undefined}
      aria-activedescendant={open && index >= 0 ? `${listId}-${index}` : undefined}
      autoComplete="off" spellCheck={false} placeholder="服务器上的绝对路径"
      onFocus={() => { setFocused(true); setDismissed(false); }} onBlur={() => setFocused(false)} onKeyDown={keyDown}
      onChange={event => { onChange(event.target.value); setSelected(0); setDismissed(false); }} />{children}</div>
    {open ? <div className="agent-directory-suggestions">
      <ul id={listId} role="listbox" aria-label="匹配的子目录" aria-busy={suggestions.loading}>
        {suggestions.matches.map((directory, i) => <li id={`${listId}-${i}`} key={directory.path} role="option"
          aria-selected={i === index} onMouseDown={event => event.preventDefault()} onClick={() => choose(directory.path)}>
          <Folder size={15} /><span>{directory.name}</span><span className="agent-directory-slash">/</span>
        </li>)}
      </ul>
      <p role="status">{suggestions.loading ? "读取目录…" : suggestions.error ? `无法读取目录：${suggestions.error}`
        : suggestions.matches.length === 0 ? "没有匹配的子目录，可继续手动输入。"
          : suggestions.truncated ? "显示前 50 项，继续输入以缩小范围。" : "↑ ↓ 选择 · Enter 补全 · Esc 收起"}</p>
    </div> : null}
  </div>;
}

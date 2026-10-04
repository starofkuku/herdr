import type { Dispatch, KeyboardEvent, SetStateAction } from "react";
import type { buildSlashMenu, SlashMenuItem } from "./skills";

export interface SlashMenuState {
  open: boolean;
  menu: ReturnType<typeof buildSlashMenu>;
  highlighted: number;
  onIndexChange: Dispatch<SetStateAction<number>>;
  onChooseItem: (item: SlashMenuItem) => void;
  onChooseSkill: (name: string) => void;
  onDismiss: () => void;
}

export function handleSlashKey(event: KeyboardEvent<HTMLTextAreaElement>, state: SlashMenuState) {
  const matches = state.menu.flat;
  if (!state.open || matches.length === 0) return false;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    state.onIndexChange((index) => event.key === "ArrowDown"
      ? (index + 1) % matches.length : (index - 1 + matches.length) % matches.length);
    return true;
  }
  if (event.key === "Enter" || event.key === "Tab") {
    if (event.nativeEvent.isComposing) return true;
    event.preventDefault();
    const chosen = matches[state.highlighted];
    if (chosen) state.onChooseItem(chosen);
    return true;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    state.onDismiss();
    return true;
  }
  return false;
}

function SlashGroup({ title, items, state, skills = false }: {
  title: string; items: (SlashMenuItem & { source?: string })[]; state: SlashMenuState; skills?: boolean;
}) {
  if (!items.length) return null;
  return <>
    <li className="slash-menu__group" role="presentation">{title}</li>
    {items.map((item) => {
      const selected = state.menu.flat.indexOf(item) === state.highlighted;
      return (
        <li key={`${item.source ?? title}:${item.name}`} role="option" aria-selected={selected}>
          <button type="button" className={selected ? "selected" : ""}
            onMouseDown={(event) => {
              event.preventDefault();
              if (skills) state.onChooseSkill(item.name);
              else state.onChooseItem(item);
            }}>
            <span className="slash-menu__name">/{item.name}</span>
            {item.description ? <span className="slash-menu__description">{item.description}</span> : null}
            <span className="slash-menu__source">{skills ? item.source : title}</span>
          </button>
        </li>
      );
    })}
  </>;
}

export function SlashMenu({ state }: { state: SlashMenuState }) {
  return (
    <div className="slash-menu" role="listbox" aria-label="Skills and commands">
      <ul>
        {state.menu.flat.length === 0 ? (
          <li className="slash-menu__empty">
            没有匹配的 Skill 或命令。命令提示收录了 Claude Code、Codex、
            ZCode 与 Pi；Skills 需要服务端 v0.8.1 及以上。
          </li>
        ) : null}
        <SlashGroup title="自定义" items={state.menu.custom} state={state} />
        <SlashGroup title="Skills" items={state.menu.skills} state={state} skills />
        <SlashGroup title="命令" items={state.menu.commands} state={state} />
      </ul>
      <p className="slash-menu__hint">
        <span>↑↓ 选择</span><span>Enter 确认</span><span>Esc 关闭</span>
      </p>
    </div>
  );
}

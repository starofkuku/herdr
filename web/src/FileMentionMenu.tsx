import { useEffect, useRef } from "react";
import { File, Folder } from "lucide-react";
import { fileIconDataUri } from "./fileIcons";
import type { FileEntry } from "./files";
import type { FileMentionController } from "./useFileMentions";
import "./fileMentions.css";

function MentionIcon({ entry }: { entry: FileEntry }) {
  if (entry.kind === "dir") return <Folder size={14} aria-hidden="true" />;
  const icon = fileIconDataUri(entry.path);
  return icon ? <img className="file-tree__icon" src={icon} alt="" />
    : <File size={14} aria-hidden="true" />;
}

function MentionRow({ entry, index, menu }: {
  entry: FileEntry; index: number; menu: FileMentionController;
}) {
  return (
    <li id={`${menu.listId}-${index}`} role="option" aria-selected={index === menu.selected}>
      <button
        type="button" tabIndex={-1}
        className={index === menu.selected ? "selected" : ""}
        onMouseDown={(event) => event.preventDefault()}
        onMouseMove={() => menu.setSelected(index)}
        onClick={() => menu.choose(entry)}
        title={entry.path}
      >
        <MentionIcon entry={entry} />
        <span className="file-mention__path">{entry.path}{entry.kind === "dir" ? "/" : ""}</span>
        <span className="slash-menu__source">{entry.kind === "dir" ? "目录" : "文件"}</span>
      </button>
    </li>
  );
}

export function FileMentionMenu({ menu }: { menu: FileMentionController }) {
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [menu.selected, menu.matches]);
  const note = menu.loading ? "正在读取项目文件和目录…"
    : menu.unavailable ? "无法读取项目目录，请关闭菜单后重试。"
      : menu.matches.length === 0 ? "没有匹配的文件或目录" : null;
  return (
    <div className="slash-menu file-mention">
      <p className="file-mention__heading">@ 引用项目文件或目录</p>
      {note ? <p className="file-mention__note" role="status">{note}</p> : null}
      <ul id={menu.listId} ref={listRef} role="listbox" aria-label="项目文件和目录" aria-busy={menu.loading}>
        {menu.matches.map((entry, index) => <MentionRow key={entry.path} entry={entry} index={index} menu={menu} />)}
      </ul>
      {menu.truncated ? <p className="file-mention__note">文件较多，仅显示部分索引；输入目录前缀可查看该目录。</p> : null}
      <p className="slash-menu__hint">
        <span>↑↓ 选择</span><span>Enter / Tab 插入</span><span>Esc 关闭</span>
      </p>
    </div>
  );
}

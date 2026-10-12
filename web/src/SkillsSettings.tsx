import { useEffect, useState } from "react";
import { CopyButton, Markdown } from "./Markdown";
import {
  filterSkills,
  loadSkillContent,
  loadSkills,
  type SkillContent,
  type SkillEntry,
  type SkillsClient,
  type SkillsState,
} from "./skills";
import "./skillsSettings.css";

export interface SkillsSettingsProps {
  client: SkillsClient;
  paneId: string;
}

function useSkillsCatalog({ client, paneId }: SkillsSettingsProps) {
  const [state, setState] = useState<SkillsState | null>();
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setState(undefined);
    void loadSkills(client, paneId).then((result) => {
      if (active) setState(result);
    });
    return () => { active = false; };
  }, [client, paneId, revision]);
  return { state, refresh: () => setRevision((value) => value + 1) };
}

function useSkillPreview({ client, paneId }: SkillsSettingsProps, name: string) {
  const [preview, setPreview] = useState<SkillContent | null>();
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setPreview(undefined);
    void loadSkillContent(client, paneId, name).then((result) => {
      if (active) setPreview(result);
    });
    return () => { active = false; };
  }, [client, paneId, name, revision]);
  return { preview, retry: () => setRevision((value) => value + 1) };
}

function SkillList({ skills, onSelect }: {
  skills: SkillEntry[];
  onSelect: (skill: SkillEntry) => void;
}) {
  return (
    <ul className="skills-panel__list">
      {skills.map((skill) => (
        <li key={`${skill.dir}:${skill.name}`} className="skills-panel__item">
          <button type="button" className="skills-panel__open" onClick={() => onSelect(skill)}>
            <span className="skills-panel__name">{skill.name}</span>
            <span className="skills-panel__badge">{skill.source === "project" ? "项目" : "用户"}</span>
            {skill.description ? <span className="skills-panel__description">{skill.description}</span> : null}
          </button>
        </li>
      ))}
    </ul>
  );
}

function SkillDetails({ skill, onBack, ...target }: SkillsSettingsProps & {
  skill: SkillEntry;
  onBack: () => void;
}) {
  const { preview, retry } = useSkillPreview(target, skill.name);
  return (
    <article className="skills-settings__detail" aria-label={`${skill.name} 详情`}>
      <div className="skills-settings__toolbar">
        <button type="button" className="ghost" onClick={onBack} autoFocus>‹ 返回 Skills 列表</button>
        {preview ? <CopyButton text={preview.content} title="复制 Skill 内容" /> : null}
      </div>
      <h3 className="skills-settings__title">{skill.name}</h3>
      <p className="skills-panel__note">{skill.source === "project" ? "项目 Skill" : "用户 Skill"}</p>
      {skill.description ? <p className="skills-settings__description">{skill.description}</p> : null}
      {preview === undefined ? <p className="skills-panel__note" role="status">正在读取 Skill 内容…</p> : null}
      {preview === null ? (
        <div role="alert">
          <p className="skills-panel__note">无法读取 Skill 内容，请确认服务器连接后重试。</p>
          <button type="button" className="ghost" onClick={retry}>重试</button>
        </div>
      ) : preview ? (
        <>
          <p className="skills-panel__path">{preview.path}</p>
          {preview.truncated ? (
            <p className="skills-panel__note" role="status">文件较大，当前仅显示服务器返回的部分内容。</p>
          ) : null}
          <Markdown text={preview.content} />
        </>
      ) : null}
    </article>
  );
}

/** Skills are read from the current pane's server only when this category opens. */
export function SkillsSettings(target: SkillsSettingsProps) {
  const { state, refresh } = useSkillsCatalog(target);
  const [selected, setSelected] = useState<SkillEntry | null>(null);
  const [query, setQuery] = useState("");
  const filtered = filterSkills(state?.skills ?? [], query);
  return (
    <div className="skills-settings">
      {selected ? <SkillDetails {...target} skill={selected} onBack={() => setSelected(null)} /> : (
        <>
          <div className="skills-settings__toolbar">
            <h3 className="skills-settings__title">Skills{state ? `（${state.skills.length}）` : ""}</h3>
            <button type="button" className="ghost" onClick={refresh} disabled={state === undefined}>刷新</button>
          </div>
          <p className="skills-panel__note">查看当前 Agent 可用的 Skills，点击名称阅读详细内容。</p>
          {state === undefined ? <p className="skills-panel__note" role="status">正在加载 Skills…</p> : null}
          {state === null ? <p className="skills-panel__note" role="alert">无法加载 Skills，请确认服务器连接后刷新。</p> : null}
          {state?.available === false ? <p className="skills-panel__note">当前 Agent 未提供专属 Skills，以下展示可读取的共享 Skills。</p> : null}
          {state && state.skills.length === 0 ? <p className="skills-panel__note">当前 Agent 没有可查看的 Skills。</p> : null}
          {state && state.skills.length > 0 ? (
            <>
              <input
                type="search"
                className="skills-panel__input skills-settings__search"
                aria-label="搜索 Skills"
                placeholder="搜索名称或说明"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <SkillList skills={filtered} onSelect={setSelected} />
              {filtered.length === 0 ? <p className="skills-panel__note">没有匹配的 Skills。</p> : null}
            </>
          ) : null}
        </>
      )}
    </div>
  );
}

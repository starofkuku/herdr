/*
 * The editor for one global preamble preset: an id (only when creating), a
 * name, and the markdown that gets rendered at the top of every app's live
 * prompt file while this preset is the active one.
 *
 * The content is markdown like any other prompt, so the preview beside it is the
 * same renderer the conversation uses — what you see is what the agents read.
 */

import type { CcSwitchCommonPreset } from "./ccswitch";
import { Markdown } from "./Markdown";

export interface CommonDraft {
  id: string;
  name: string;
  content: string;
}

export function draftFromCommon(preset: CcSwitchCommonPreset | null): CommonDraft {
  return {
    id: preset?.id ?? "",
    name: preset?.name ?? "",
    content: preset?.content ?? "",
  };
}

export function CcSwitchCommonForm({
  editing,
  draft,
  onChange,
  onCancel,
  onSubmit,
  busy,
  error,
}: {
  /** The preset being edited; null when creating one. */
  editing: CcSwitchCommonPreset | null;
  draft: CommonDraft;
  onChange: (next: CommonDraft) => void;
  onCancel: () => void;
  onSubmit: (draft: CommonDraft) => void;
  busy: boolean;
  error: string;
}) {
  const created = editing === null;
  const patch = (part: Partial<CommonDraft>) => onChange({ ...draft, ...part });

  return (
    <form
      className="ccswitch__editor"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(draft);
      }}
    >
      <div className="ccswitch__pair">
        {created ? (
          <label className="ccswitch__field">
            <span>id</span>
            <input
              value={draft.id}
              onChange={(event) => patch({ id: event.target.value })}
              placeholder="唯一标识，例如 house-style"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
        ) : (
          <label className="ccswitch__field">
            <span>id（不可改）</span>
            <input value={draft.id} readOnly />
          </label>
        )}
        <label className="ccswitch__field">
          <span>名称</span>
          <input
            value={draft.name}
            onChange={(event) => patch({ name: event.target.value })}
            placeholder="显示名"
            autoComplete="off"
          />
        </label>
      </div>

      <div className="ccswitch__field ccswitch__field--grow">
        <span>内容（markdown；激活时渲染到每个 agent 的提示词文件顶部）</span>
        <div className="ccswitch__md">
          <div className="ccswitch__md-edit">
            <textarea
              className="ccswitch__settings"
              value={draft.content}
              onChange={(event) => patch({ content: event.target.value })}
              spellCheck={false}
              rows={12}
              placeholder="# 公共前导词…"
            />
          </div>
          <div className="ccswitch__md-preview" aria-label="渲染预览">
            {draft.content.trim() ? (
              <Markdown text={draft.content} />
            ) : (
              <p className="ccswitch__hint">预览：开始输入后，这里显示渲染后的样子。</p>
            )}
          </div>
        </div>
      </div>

      <p className="ccswitch__hint">
        {editing
          ? "保存后若这个预设正在使用，服务端会重新渲染所有 agent 的提示词文件。"
          : "新建只入库，不写任何文件；要生效需要点列表里的「激活」。"}
      </p>

      {error ? (
        <p className="ccswitch__note error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="ccswitch__actions">
        <button type="button" className="ghost" onClick={onCancel} disabled={busy}>
          取消
        </button>
        <button
          type="submit"
          className="agent-primary-button"
          disabled={busy || !draft.id.trim() || !draft.content.trim()}
        >
          {busy ? "保存中…" : created ? "新建预设" : "保存修改"}
        </button>
      </div>
    </form>
  );
}

/*
 * The prompt editor: one preset, as the CLI would ask for it.
 *
 * Content is markdown and can be a whole AGENTS.md, so it is edited as text —
 * the same document activate will write into the app's live prompt file.
 *
 * The one rule that surprises: saving an enabled preset does not change the
 * live file. The editor therefore re-activates after saving an enabled preset,
 * so what the agent reads is what was just saved.
 */

import { Markdown } from "./Markdown";
import type { CcSwitchPrompt } from "./ccswitch";

export interface PromptDraft {
  name: string;
  description: string;
  content: string;
}

export function draftFromPrompt(prompt: CcSwitchPrompt | null): PromptDraft {
  return {
    name: prompt?.name ?? "",
    description: typeof prompt?.description === "string" ? prompt.description : "",
    content: prompt?.content ?? "",
  };
}

export function CcSwitchPromptForm({
  editing,
  draft,
  onChange,
  onCancel,
  onSubmit,
  busy,
  error,
}: {
  /** The preset being edited; null when creating one. */
  editing: CcSwitchPrompt | null;
  draft: PromptDraft;
  onChange: (next: PromptDraft) => void;
  onCancel: () => void;
  onSubmit: (draft: PromptDraft) => void;
  busy: boolean;
  error: string;
}) {
  const created = editing === null;
  const patch = (part: Partial<PromptDraft>) => onChange({ ...draft, ...part });

  return (
    <form
      className="ccswitch__editor"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(draft);
      }}
    >
      <div className="ccswitch__pair">
        <label className="ccswitch__field">
          <span>名称</span>
          <input
            value={draft.name}
            onChange={(event) => patch({ name: event.target.value })}
            placeholder="例如：日常 / 代码评审"
            autoComplete="off"
          />
        </label>
        <label className="ccswitch__field">
          <span>备注</span>
          <input
            value={draft.description}
            onChange={(event) => patch({ description: event.target.value })}
            placeholder="一句话说明"
            autoComplete="off"
          />
        </label>
      </div>

      <div className="ccswitch__field ccswitch__field--grow">
        <span>内容（markdown 全文；启用时会原样写入该 app 的提示词文件）</span>
        <div className="ccswitch__md">
          <div className="ccswitch__md-edit">
            <textarea
              className="ccswitch__settings"
              value={draft.content}
              onChange={(event) => patch({ content: event.target.value })}
              spellCheck={false}
              rows={14}
              placeholder="# 提示词内容…"
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
        {created ? "保存新建的预设。" : "保存对该预设的修改；写入实际文件由服务端处理。"}
      </p>

      {error ? (
        <p className="ccswitch__note error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="ccswitch__actions">
        <button
          type="button"
          className="ghost"
          onClick={onCancel}
          disabled={busy}
        >
          取消
        </button>
        <button type="submit" className="agent-primary-button" disabled={busy || !draft.name.trim()}>
          {busy ? "保存中…" : created ? "新建预设" : "保存修改"}
        </button>
      </div>
    </form>
  );
}

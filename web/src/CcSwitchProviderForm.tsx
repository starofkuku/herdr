/*
 * The provider editor: the same document the CLI wants, in a form.
 *
 * Each app keeps provider settings its own way, so the settings are edited as
 * the JSON document the API takes rather than as per-app fields — which is also
 * what makes this work for an app whose shape herdr has never seen.
 *
 * The one rule that matters: reads mask secrets as `***`, and writes store what
 * they are given, so a masked document sent back would replace a real key with
 * that literal. Saving is therefore blocked while `***` is still in the text,
 * and an untouched document is not sent at all — a rename must not be a way to
 * lose a key.
 */

import { useState } from "react";
import { needsProviderId, type CcSwitchProviderDetail } from "./ccswitch";
import { CcSwitchJsonEditor } from "./CcSwitchJsonEditor";

export interface ProviderDraft {
  id: string;
  name: string;
  notes: string;
  websiteUrl: string;
  settings: string;
}

export function draftFrom(provider: CcSwitchProviderDetail | null): ProviderDraft {
  return {
    id: provider?.id ?? "",
    name: provider?.name ?? "",
    notes: typeof provider?.notes === "string" ? provider.notes : "",
    websiteUrl: typeof provider?.website_url === "string" ? provider.website_url : "",
    settings: provider ? JSON.stringify(provider.settingsConfig ?? {}, null, 2) : "",
  };
}

/** Whether a document still carries the mask a read put there. */
export function hasMaskedSecret(settings: string): boolean {
  return settings.includes("\"***\"") || settings.includes("'***'") || /:\s*\*\*\*/.test(settings);
}

/** The parsed document, or the reason it is not one. */
export function parseSettings(settings: string): { value?: unknown; error?: string } {
  const trimmed = settings.trim();
  if (!trimmed) return { error: "配置不能为空：它是这个渠道的连接信息。" };
  try {
    return { value: JSON.parse(trimmed) };
  } catch (err) {
    return { error: `配置不是合法 JSON：${err instanceof Error ? err.message : String(err)}` };
  }
}

export function CcSwitchProviderForm({
  app,
  editing,
  draft,
  onChange,
  onCancel,
  onSubmit,
  busy,
  error,
}: {
  app: string;
  /** The provider being edited; null when creating one. */
  editing: CcSwitchProviderDetail | null;
  draft: ProviderDraft;
  onChange: (next: ProviderDraft) => void;
  onCancel: () => void;
  onSubmit: (draft: ProviderDraft) => void;
  busy: boolean;
  error: string;
}) {
  const [showSettings, setShowSettings] = useState(!editing);
  const masked = hasMaskedSecret(draft.settings);
  const created = editing === null;
  const idRequired = created && needsProviderId(app);

  const patch = (part: Partial<ProviderDraft>) => onChange({ ...draft, ...part });

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
            placeholder="显示名，例如 home-wsl"
            autoComplete="off"
          />
        </label>
        {created ? (
          idRequired ? (
            <label className="ccswitch__field">
              <span>id（这个 app 必填）</span>
              <input
                value={draft.id}
                onChange={(event) => patch({ id: event.target.value })}
                placeholder="唯一标识"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
          ) : null
        ) : (
          <label className="ccswitch__field">
            <span>id（不可改）</span>
            <input value={draft.id} readOnly />
          </label>
        )}
      </div>

      <div className="ccswitch__pair">
        <label className="ccswitch__field">
          <span>备注</span>
          <input
            value={draft.notes}
            onChange={(event) => patch({ notes: event.target.value })}
            autoComplete="off"
          />
        </label>
        <label className="ccswitch__field">
          <span>站点</span>
          <input
            value={draft.websiteUrl}
            onChange={(event) => patch({ websiteUrl: event.target.value })}
            placeholder="https://…"
            autoComplete="off"
          />
        </label>
      </div>

      <div className="ccswitch__editor-settings">
        <button type="button" className="ghost" onClick={() => setShowSettings(!showSettings)}>
          {showSettings ? "收起配置" : "编辑配置 JSON"}
        </button>
        {editing && !showSettings ? (
          <span className="ccswitch__hint">不改动配置，只保存名称/备注/站点。</span>
        ) : null}
      </div>

      {showSettings ? (
        <>
          <div className="ccswitch__cm">
            <CcSwitchJsonEditor value={draft.settings} onChange={(next) => patch({ settings: next })} />
          </div>
          <p className={`ccswitch__hint${masked ? " error" : ""}`}>
            {masked
              ? "配置里还有 *** ：那是读取时的掩码占位符，直接保存会把真实密钥覆盖成这三个字符。请把它换成真实值，或收起配置只改其它字段。"
              : "读取时密钥显示为 ***；保存会把这里的内容原样写入，所以请填真实值。"}
          </p>
        </>
      ) : null}

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
          disabled={busy || !draft.name.trim() || (idRequired && !draft.id.trim()) || (showSettings && masked)}
        >
          {busy ? "保存中…" : created ? "新建渠道" : "保存修改"}
        </button>
      </div>
    </form>
  );
}

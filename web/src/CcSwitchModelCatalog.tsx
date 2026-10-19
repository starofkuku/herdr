/*
 * The catalog split into models: one row per entry, one form per field.
 *
 * The file is a strict-deserialize document — one bad entry can make Codex
 * drop the whole catalog — so the editor works at the entry level and only
 * touches the nine documented, editable fields. Everything else a model
 * carries (the tool shapes, the instruction packs, the plan tiers) is
 * inherited untouched from the entry it was cloned from, because those are
 * undocumented territory where a guess costs the whole file.
 *
 * New entries are always clones: a blank form for this file is a trap, not a
 * convenience — the required field set has no public documentation, and
 * missing one of them takes every model down with it.
 */

import { useEffect, useState } from "react";
import { AlertTriangle, Copy, RotateCcw, Save } from "lucide-react";
import {
  ccswitchModelCatalog,
  ccswitchSaveModelCatalog,
  type CcSwitchSettings,
} from "./ccswitch";
import { CcSwitchDrawer } from "./CcSwitchDrawer";

/** The fields the form exposes; everything else passes through untouched. */
interface EditableFields {
  slug: string;
  display_name: string;
  description: string;
  priority: number;
  context_window: number;
  max_context_window: number;
  auto_compact_token_limit: number | null;
  input_modalities: string[];
  default_reasoning_level: string;
}

type Model = Record<string, unknown> & { slug?: string };

const EDITABLE_KEYS: (keyof EditableFields)[] = [
  "slug",
  "display_name",
  "description",
  "priority",
  "context_window",
  "max_context_window",
  "auto_compact_token_limit",
  "input_modalities",
  "default_reasoning_level",
];

function pickEditable(model: Model): EditableFields {
  return {
    slug: String(model.slug ?? ""),
    display_name: String(model.display_name ?? ""),
    description: String(model.description ?? ""),
    priority: Number(model.priority ?? 1000),
    context_window: Number(model.context_window ?? 128000),
    max_context_window: Number(model.max_context_window ?? 128000),
    auto_compact_token_limit:
      model.auto_compact_token_limit === null || model.auto_compact_token_limit === undefined
        ? null
        : Number(model.auto_compact_token_limit),
    input_modalities: Array.isArray(model.input_modalities)
      ? (model.input_modalities as string[]).filter((m) => m === "text" || m === "image")
      : ["text"],
    default_reasoning_level: String(model.default_reasoning_level ?? "medium"),
  };
}

function applyEditable(model: Model, fields: EditableFields): Model {
  return { ...model, ...fields };
}

function validate(models: Model[], fields: EditableFields, editingIndex: number): string {
  const slug = fields.slug.trim();
  if (!slug) return "slug 不能为空。";
  if (!fields.display_name.trim()) return "display_name 不能为空。";
  if (models.some((m, i) => i !== editingIndex && String(m.slug ?? "") === slug)) {
    return `slug "${slug}" 已存在：文件内不可重复。`;
  }
  if (!Number.isInteger(fields.context_window) || fields.context_window <= 0) {
    return "context_window 必须是正整数。";
  }
  if (
    !Number.isInteger(fields.max_context_window) ||
    fields.max_context_window < fields.context_window
  ) {
    return "max_context_window 必须是正整数且 ≥ context_window。";
  }
  if (
    fields.auto_compact_token_limit !== null &&
    (!Number.isInteger(fields.auto_compact_token_limit) || fields.auto_compact_token_limit <= 0)
  ) {
    return "auto_compact_token_limit 要么留空（用 Codex 默认），要么是正整数。";
  }
  if (fields.input_modalities.length === 0) return "至少选一种输入模态（text / image）。";
  return "";
}

/** The list of models, one row each, with the editing form under the row. */
export function CcSwitchModelCatalogEditor({
  settings,
  revision,
  onChanged,
  onRestartDaemon,
}: {
  settings: CcSwitchSettings;
  revision: number;
  onChanged: () => void;
  /**
   * Restarts the Codex app-server daemon on the server this cc-switch belongs
   * to. Absent when no herdr server is reachable to run it.
   */
  onRestartDaemon?: () => Promise<unknown>;
}) {
  const [models, setModels] = useState<Model[] | null>(null);
  const [referenced, setReferenced] = useState<boolean | null>(null);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<number | null>(null);
  /* The entry whose drawer is open to be copied; null when none. */
  const [copyIndex, setCopyIndex] = useState<number | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "saving">("loading");
  /* The daemon restart: idle, waiting for the reader to confirm, or running. */
  const [restart, setRestart] = useState<"idle" | "confirm" | "running">("idle");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let live = true;
    setState("loading");
    setError("");
    ccswitchModelCatalog(settings)
      .then((result) => {
        if (!live) return;
        const content = result.content as { models?: unknown };
        setModels(Array.isArray(content.models) ? (content.models as Model[]) : []);
        setReferenced(result.referenced);
        setState("ready");
      })
      .catch((err: unknown) => {
        if (!live) return;
        setError(err instanceof Error ? err.message : String(err));
        setModels([]);
        setState("ready");
      });
    return () => {
      live = false;
    };
  }, [settings, revision]);

  const saveAll = async (next: Model[], note: string) => {
    setState("saving");
    setError("");
    setNotice("");
    try {
      const result = await ccswitchSaveModelCatalog(settings, { models: next });
      setModels(next);
      setReferenced(result.referenced);
      setNotice(note);
      setEditingIndex(null);
      setConfirmingDelete(null);
      setCopyIndex(null);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setState("ready");
    }
  };

  const saveEntry = (index: number, fields: EditableFields) => {
    if (!models) return;
    const problem = validate(models, fields, index);
    if (problem) {
      setError(problem);
      return;
    }
    const next = [...models];
    next[index] = applyEditable(next[index], fields);
    void saveAll(next, `已保存「${fields.display_name}」。`);
  };

  const createFrom = (templateIndex: number, fields: EditableFields) => {
    if (!models) return;
    const problem = validate(models, fields, -1);
    if (problem) {
      setError(problem);
      return;
    }
    const clone = structuredClone(models[templateIndex]);
    const next = [...models, applyEditable(clone, fields)];
    void saveAll(next, `已新建「${fields.display_name}」（从「${models[templateIndex]?.slug}」克隆）。`);
  };

  const remove = (index: number) => {
    if (!models) return;
    const entry = models[index];
    const next = models.filter((_, i) => i !== index);
    void saveAll(next, `已删除「${String(entry?.slug ?? index)}」。`);
  };

  if (state === "loading") {
    return (
      <div className="ccswitch__section">
        <p className="ccswitch__note">正在读取模型目录…</p>
      </div>
    );
  }

  return (
    <div className="ccswitch__section">
      <div className="ccswitch__section-head">
        <span className="ccswitch__hint">
          Codex 自定义模型目录 · 共 {models?.length ?? 0} 条 · 每条只开放 9
          个安全可编辑字段，其余原样保留
        </span>

        {/*
          The daemon reads the catalog once, at startup; a save on disk is not
          visible to it until a restart. Two steps, because a restart interrupts
          every running Codex conversation on that server.
        */}
        {onRestartDaemon ? (
          restart === "running" ? (
            <span className="ccswitch__hint">正在重启 App Server…</span>
          ) : restart === "confirm" ? (
            <>
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  setRestart("running");
                  setError("");
                  setNotice("");
                  onRestartDaemon()
                    .then(() => {
                      setRestart("idle");
                      setNotice("App Server 已重启，模型列表已更新。");
                    })
                    .catch((err: unknown) => {
                      setRestart("idle");
                      setError(err instanceof Error ? err.message : String(err));
                    });
                }}
              >
                确认重启（会中断正在运行的 Codex 会话 ✗
              </button>
              <button type="button" className="ghost" onClick={() => setRestart("idle")}>
                取消
              </button>
            </>
          ) : (
            <button type="button" className="ghost" onClick={() => setRestart("confirm")}>
              <RotateCcw size={13} aria-hidden="true" /> 重启 App Server 生效新目录
            </button>
          )
        ) : null}
      </div>

      {referenced === false ? (
        <p className="ccswitch__note warn" role="alert">
          <AlertTriangle size={13} aria-hidden="true" /> config.toml
          目前没有引用这个文件 —— Codex 不会加载它。任意一次保存都会把引用键加回去。
        </p>
      ) : null}

      <ul className="ccswitch__list">
        {models?.map((model, index) => {
          const slug = String(model.slug ?? "?");
          const isEditing = editingIndex === index;
          const isDeleting = confirmingDelete === index;
          return (
            <li key={`${slug}-${index}`} className={`ccswitch__row${isEditing ? " current" : ""}`}>
              <div className="ccswitch__row-line">
                <button
                  type="button"
                  className="ccswitch__row-main"
                  onClick={() => {
                    setEditingIndex(isEditing ? null : index);
                    setConfirmingDelete(null);
                    setError("");
                  }}
                  title="点击编辑此模型"
                >
                  <span className="ccswitch__name">{String(model.display_name ?? slug)}</span>
                  <span className="ccswitch__id">{slug}</span>
                  <span className="ccswitch__agent">
                    ctx {String(model.context_window ?? "?")}
                    {" · "}
                    {Array.isArray(model.input_modalities) ? (model.input_modalities as string[]).join("/") : "text"}
                  </span>
                </button>
                <button
                  type="button"
                  className="ghost ccswitch__action"
                  disabled={state === "saving"}
                  onClick={() => {
                    setEditingIndex(isEditing ? null : index);
                    setConfirmingDelete(null);
                    setError("");
                  }}
                >
                  编辑
                </button>
                <button
                  type="button"
                  className="ghost ccswitch__action"
                  disabled={state === "saving"}
                  onClick={() => {
                    setCopyIndex(index);
                    setEditingIndex(null);
                    setConfirmingDelete(null);
                    setError("");
                  }}
                >
                  <Copy size={13} aria-hidden="true" /> 复制
                </button>
                <button
                  type="button"
                  className="ghost ccswitch__action"
                  disabled={state === "saving"}
                  onClick={() => {
                    setEditingIndex(null);
                    setConfirmingDelete(isDeleting ? null : index);
                    setError("");
                  }}
                >
                  删除
                </button>
              </div>

              {isDeleting ? (
                <div className="ccswitch__detail-actions">
                  <span className="ccswitch__hint">
                    删除「{slug}」？整个文件会立即重写。不可撤销。
                  </span>
                  <button type="button" className="ghost" onClick={() => setConfirmingDelete(null)}>
                    取消
                  </button>
                  <button
                    type="button"
                    className="agent-danger-button"
                    onClick={() => void remove(index)}
                  >
                    确认删除
                  </button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>



      {editingIndex !== null && models ? (
        <CcSwitchDrawer
          title={`编辑模型：${String(models[editingIndex]?.slug ?? "")}`}
          onClose={() => setEditingIndex(null)}
          armed={false}
          onDismissArmed={() => setEditingIndex(null)}
        >
          <ModelForm
            initial={pickEditable(models[editingIndex])}
            template={models[editingIndex]}
            busy={state === "saving"}
            onCancel={() => setEditingIndex(null)}
            onSubmit={(fields) => saveEntry(editingIndex, fields)}
          />
        </CcSwitchDrawer>
      ) : null}

      {copyIndex !== null && models ? (
        <CcSwitchDrawer
          title={`复制模型：${String(models[copyIndex]?.slug ?? "")}`}
          onClose={() => setCopyIndex(null)}
          armed={false}
          onDismissArmed={() => setCopyIndex(null)}
        >
          <CloneForm
            model={models[copyIndex]}
            busy={state === "saving"}
            onCancel={() => setCopyIndex(null)}
            onCreate={(fields) => createFrom(copyIndex, fields)}
          />
        </CcSwitchDrawer>
      ) : null}

      {error ? (
        <p className="ccswitch__note error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="ccswitch__note ok" role="status">
          {notice}
        </p>
      ) : null}
    </div>
  );
}

/** The form for the nine editable fields, with the untouched keys listed beside. */
function ModelForm({
  initial,
  template,
  busy,
  onCancel,
  onSubmit,
}: {
  initial: EditableFields;
  template: Model;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (fields: EditableFields) => void;
}) {
  const [fields, setFields] = useState(initial);
  const patch = (part: Partial<EditableFields>) => setFields((current) => ({ ...current, ...part }));
  const untouchedKeys = Object.keys(template).filter((key) => !EDITABLE_KEYS.includes(key as keyof EditableFields));

  return (
    <form
      className="ccswitch-catalog__form"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(fields);
      }}
    >
      <div className="ccswitch__pair">
        <label className="ccswitch__field">
          <span>slug（API 请求的模型 id ✗ 必须与渠道一致 ✗</span>
          <input
            value={fields.slug}
            onChange={(e) => patch({ slug: e.target.value })}
            spellCheck={false}
          />
        </label>
        <label className="ccswitch__field">
          <span>display_name</span>
          <input
            value={fields.display_name}
            onChange={(e) => patch({ display_name: e.target.value })}
          />
        </label>
      </div>
      <div className="ccswitch__pair">
        <label className="ccswitch__field">
          <span>description</span>
          <input
            value={fields.description}
            onChange={(e) => patch({ description: e.target.value })}
          />
        </label>
        <label className="ccswitch__field">
          <span>priority（排序，小靠前 ✗</span>
          <input
            value={String(fields.priority)}
            inputMode="numeric"
            onChange={(e) => patch({ priority: Number(e.target.value) || 0 })}
          />
        </label>
      </div>
      <div className="ccswitch__pair">
        <label className="ccswitch__field">
          <span>context_window</span>
          <input
            value={String(fields.context_window)}
            inputMode="numeric"
            onChange={(e) => patch({ context_window: Number(e.target.value) || 0 })}
          />
        </label>
        <label className="ccswitch__field">
          <span>max_context_window（≥ context ✗</span>
          <input
            value={String(fields.max_context_window)}
            inputMode="numeric"
            onChange={(e) => patch({ max_context_window: Number(e.target.value) || 0 })}
          />
        </label>
      </div>
      <div className="ccswitch__pair">
        <label className="ccswitch__field">
          <span>auto_compact_token_limit（空 = Codex 默认 ✗</span>
          <input
            value={fields.auto_compact_token_limit === null ? "" : String(fields.auto_compact_token_limit)}
            inputMode="numeric"
            placeholder="留空 = Codex 默认"
            onChange={(e) =>
              patch({
                auto_compact_token_limit: e.target.value.trim() === "" ? null : Number(e.target.value) || 0,
              })
            }
          />
        </label>
        <label className="ccswitch__field">
          <span>default_reasoning_level</span>
          <select
            value={fields.default_reasoning_level}
            onChange={(e) => patch({ default_reasoning_level: e.target.value })}
          >
            {["minimal", "low", "medium", "high", "xhigh"].map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="ccswitch__field">
        <span>input_modalities</span>
        <div className="ccswitch-catalog__modalities">
          {["text", "image"].map((modality) => (
            <label key={modality} className="ccswitch-catalog__modality">
              <input
                type="checkbox"
                checked={fields.input_modalities.includes(modality)}
                onChange={(e) => {
                  const next = e.target.checked
                    ? [...fields.input_modalities, modality]
                    : fields.input_modalities.filter((m) => m !== modality);
                  patch({ input_modalities: next });
                }}
              />
              {modality}
            </label>
          ))}
        </div>
      </div>
      <p className="ccswitch__hint">
        其余 {untouchedKeys.length} 个字段（工具形态 ✗ 指令包 ✗ 计划分层等 ✗ 原样保留不动 ✓
      </p>
      <div className="ccswitch__actions">
        <button type="button" className="ghost" onClick={onCancel} disabled={busy}>
          取消
        </button>
        <button type="submit" className="agent-primary-button" disabled={busy}>
          {busy ? "保存中…" : <><Save size={14} aria-hidden="true" /> 保存此条</>}
        </button>
      </div>
    </form>
  );
}

/** Copy one entry: the safe fields are offered, the rest is inherited as-is. */
function CloneForm({
  model,
  busy,
  onCancel,
  onCreate,
}: {
  model: Model;
  busy: boolean;
  onCancel: () => void;
  onCreate: (fields: EditableFields) => void;
}) {
  const [fields, setFields] = useState<EditableFields>(() => pickEditable(model));
  const patch = (part: Partial<EditableFields>) => setFields((current) => ({ ...current, ...part }));

  return (
    <form
      className="ccswitch-catalog__form"
      onSubmit={(event) => {
        event.preventDefault();
        onCreate(fields);
      }}
    >
      <p className="ccswitch__hint">
        从「{String(model.slug ?? "")}」复制 ✗ 工具形态 ✗ 指令包等字段全部继承 ✗ 下面改掉需要不同的部分
      </p>
      <div className="ccswitch__pair">
        <label className="ccswitch__field">
          <span>slug（新的模型 id，必须与渠道一致 ✗</span>
          <input value={fields.slug} onChange={(e) => patch({ slug: e.target.value })} spellCheck={false} />
        </label>
        <label className="ccswitch__field">
          <span>display_name</span>
          <input value={fields.display_name} onChange={(e) => patch({ display_name: e.target.value })} />
        </label>
      </div>
      <div className="ccswitch__pair">
        <label className="ccswitch__field">
          <span>description</span>
          <input value={fields.description} onChange={(e) => patch({ description: e.target.value })} />
        </label>
        <label className="ccswitch__field">
          <span>priority</span>
          <input
            value={String(fields.priority)}
            inputMode="numeric"
            onChange={(e) => patch({ priority: Number(e.target.value) || 0 })}
          />
        </label>
      </div>
      <div className="ccswitch__pair">
        <label className="ccswitch__field">
          <span>context_window</span>
          <input
            value={String(fields.context_window)}
            inputMode="numeric"
            onChange={(e) => patch({ context_window: Number(e.target.value) || 0 })}
          />
        </label>
        <label className="ccswitch__field">
          <span>max_context_window（≥ context ✗</span>
          <input
            value={String(fields.max_context_window)}
            inputMode="numeric"
            onChange={(e) => patch({ max_context_window: Number(e.target.value) || 0 })}
          />
        </label>
      </div>
      <div className="ccswitch__pair">
        <label className="ccswitch__field">
          <span>auto_compact_token_limit（空 = 默认 ✗</span>
          <input
            value={fields.auto_compact_token_limit === null ? "" : String(fields.auto_compact_token_limit)}
            inputMode="numeric"
            placeholder="留空 = Codex 默认"
            onChange={(e) =>
              patch({
                auto_compact_token_limit: e.target.value.trim() === "" ? null : Number(e.target.value) || 0,
              })
            }
          />
        </label>
        <label className="ccswitch__field">
          <span>default_reasoning_level</span>
          <select
            value={fields.default_reasoning_level}
            onChange={(e) => patch({ default_reasoning_level: e.target.value })}
          >
            {["minimal", "low", "medium", "high", "xhigh"].map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="ccswitch__field">
        <span>input_modalities</span>
        <div className="ccswitch-catalog__modalities">
          {["text", "image"].map((modality) => (
            <label key={modality} className="ccswitch-catalog__modality">
              <input
                type="checkbox"
                checked={fields.input_modalities.includes(modality)}
                onChange={(e) => {
                  const next = e.target.checked
                    ? [...fields.input_modalities, modality]
                    : fields.input_modalities.filter((m) => m !== modality);
                  patch({ input_modalities: next });
                }}
              />
              {modality}
            </label>
          ))}
        </div>
      </div>
      <div className="ccswitch__actions">
        <button type="button" className="ghost" onClick={onCancel} disabled={busy}>
          取消
        </button>
        <button type="submit" className="agent-primary-button" disabled={busy}>
          {busy ? "创建中…" : <><Copy size={14} aria-hidden="true" /> 复制并新建</>}
        </button>
      </div>
    </form>
  );
}

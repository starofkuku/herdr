/*
 * The global prompt preamble: one preset at a time, rendered into the top of
 * every app's live prompt file.
 *
 * Unlike the per-app prompt presets beside it, activating one here rewrites
 * every file cc-switch manages, so the wide-reaching actions — activate,
 * deactivate, re-render — ask first and report how many files they changed.
 * Creating and editing a preset that is not active touches no file at all.
 */

import { useEffect, useState } from "react";
import { Check, Loader2, Pencil, Plus, RefreshCw, Trash2, X } from "lucide-react";
import {
  ccswitchCommon,
  ccswitchCommonCreate,
  ccswitchCommonDelete,
  ccswitchCommonOff,
  ccswitchCommonReapply,
  ccswitchCommonUpdate,
  ccswitchCommonUse,
  type CcSwitchCommonPreset,
  type CcSwitchSettings,
} from "./ccswitch";
import { CcSwitchDrawer } from "./CcSwitchDrawer";
import { CcSwitchCommonForm, draftFromCommon, type CommonDraft } from "./CcSwitchCommonForm";

type Mode = { kind: "list" } | { kind: "create" } | { kind: "edit"; preset: CcSwitchCommonPreset };
/** The action that repaints every live file, while it waits for a second press. */
type Pending = { kind: "use"; id: string } | { kind: "off" } | { kind: "reapply" } | { kind: "delete"; id: string };

export function CcSwitchCommon({ settings, revision }: { settings: CcSwitchSettings; revision: number }) {
  const [presets, setPresets] = useState<CcSwitchCommonPreset[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: "list" });
  const [draft, setDraft] = useState<CommonDraft>(() => draftFromCommon(null));
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let live = true;
    setPresets(null);
    setOpenId(null);
    setMode({ kind: "list" });
    setPending(null);
    ccswitchCommon(settings)
      .then((state) => {
        if (!live) return;
        setPresets(state.presets);
        setActiveId(state.activeId);
      })
      .catch((err: unknown) => {
        if (!live) return;
        setPresets([]);
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      live = false;
    };
  }, [settings, revision]);

  const run = async (label: string, action: () => Promise<string>) => {
    setBusy(label);
    setError("");
    setNotice("");
    try {
      setNotice(await action());
      setPending(null);
      setMode({ kind: "list" });
      // 列表来自服务端，本地不猜：重新读一次 ✓
      ccswitchCommon(settings)
        .then((state) => {
          setPresets(state.presets);
          setActiveId(state.activeId);
        })
        .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const files = (count: number | undefined) =>
    typeof count === "number" ? `（重写 ${count} 个文件）` : "";

  const save = (draft: CommonDraft) =>
    mode.kind === "edit"
      ? run("save", async () => {
          await ccswitchCommonUpdate(settings, mode.preset.id, draft);
          return `已保存「${draft.name || draft.id}」。`;
        })
      : run("save", async () => {
          const result = await ccswitchCommonCreate(settings, draft);
          return `已${result.updated ? "覆盖" : "新建"}预设「${draft.name || draft.id}」。它未激活时不写文件。`;
        });

  return (
    <div className="ccswitch__section">
      <p className="ccswitch__hint">
        公共提示词是<b>一份全局前导词</b>：同一时间只有一个处于激活状态，它会渲染到<b>所有</b> agent 的提示词文件顶部
        （pi 的 AGENTS.md、codex/claude 的对应文件）。激活、停用、重新渲染都会重写这些文件。
      </p>

      {error ? (
        <p className="ccswitch__note error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? <p className="ccswitch__note ok">{notice}</p> : null}

      <div className="ccswitch__section-head">
        <span className="ccswitch__hint">
          共 {presets?.length ?? "…"} 个预设；
          {activeId ? `当前激活：${activeId}` : "当前没有激活的前导词"}
        </span>
        <div className="ccswitch__head-actions">
          {activeId ? (
            <button
              type="button"
              className="ghost"
              disabled={busy !== null}
              onClick={() => setPending(pending?.kind === "off" ? null : { kind: "off" })}
            >
              <X size={13} aria-hidden="true" /> 停用
            </button>
          ) : null}
          <button
            type="button"
            className="ghost"
            disabled={busy !== null}
            title="把当前激活的前导词重新渲染进所有已存在的提示词文件"
            onClick={() => setPending(pending?.kind === "reapply" ? null : { kind: "reapply" })}
          >
            <RefreshCw size={13} aria-hidden="true" /> 重新渲染
          </button>
          <button
            type="button"
            className="ghost ccswitch__new"
            disabled={busy !== null}
            onClick={() => {
              setDraft(draftFromCommon(null));
              setMode({ kind: "create" });
              setError("");
            }}
          >
            <Plus size={13} aria-hidden="true" /> 新建预设
          </button>
        </div>
      </div>

      {/*
        One confirmation bar for the actions that rewrite every live file. It sits
        outside the row's detail block, because activating from the list must show
        its own confirmation whether or not that row happens to be expanded.
      */}
      {pending && pending.kind !== "delete" ? (
        <div className="ccswitch__danger-zone" role="alertdialog">
          <p className="ccswitch__hint">
            {pending.kind === "off"
              ? "停用会从所有 agent 的提示词文件里移除这段前导词。"
              : pending.kind === "reapply"
                ? "重新渲染会把当前激活的前导词重新写进每一个已存在的提示词文件。"
                : `激活「${
                    presets?.find((p) => p.id === pending.id)?.name ?? pending.id
                  }」会把它写进所有 agent 的提示词文件。`}
            确定继续？
          </p>
          <div className="ccswitch__sync-actions">
            <button type="button" className="ghost" onClick={() => setPending(null)} disabled={busy !== null}>
              取消
            </button>
            <button
              type="button"
              className="agent-danger-button"
              disabled={busy !== null}
              onClick={() =>
                void run(pending.kind, async () => {
                  if (pending.kind === "off") {
                    const r = await ccswitchCommonOff(settings);
                    return `已停用公共前导词${files(r.repainted)}。`;
                  }
                  if (pending.kind === "reapply") {
                    const r = await ccswitchCommonReapply(settings);
                    return `已重新渲染${files(r.repainted)}。`;
                  }
                  const r = await ccswitchCommonUse(settings, pending.id);
                  const name = presets?.find((p) => p.id === pending.id)?.name ?? pending.id;
                  return `已激活「${name}」${files(r.repainted)}。`;
                })
              }
            >
              确认
            </button>
          </div>
        </div>
      ) : null}

      {presets === null ? (
        <p className="ccswitch__note">
          <Loader2 size={13} className="ccswitch__spin" aria-hidden="true" /> 正在读取…
        </p>
      ) : null}
      {presets?.length === 0 ? (
        <p className="ccswitch__note">还没有公共预设，点「新建预设」添加一个。</p>
      ) : null}

      <ul className="ccswitch__list">
        {presets?.map((preset) => {
          const isActive = preset.id === activeId;
          return (
            <li key={preset.id} className={`ccswitch__row${isActive ? " current" : ""}`}>
              <div className="ccswitch__row-line">
                <button
                  type="button"
                  className="ccswitch__row-main"
                  onClick={() => {
                    setOpenId(openId === preset.id ? null : preset.id);
                    setPending(null);
                  }}
                  aria-expanded={openId === preset.id}
                >
                  <span className="ccswitch__name">{preset.name}</span>
                  <span className="ccswitch__id">{preset.id}</span>
                  {isActive ? (
                    <span className="ccswitch__badge">
                      <Check size={11} aria-hidden="true" /> 使用中
                    </span>
                  ) : null}
                </button>
                <button
                  type="button"
                  className="ghost ccswitch__action"
                  disabled={isActive || busy !== null}
                  onClick={() => setPending({ kind: "use", id: preset.id })}
                >
                  {isActive ? "使用中" : "激活"}
                </button>
              </div>

              {openId === preset.id ? (
                <div className="ccswitch__detail">
                  <pre className="ccswitch__json">{preset.content || "（无内容）"}</pre>
                  <div className="ccswitch__detail-actions">
                    {pending?.kind === "delete" && pending.id === preset.id ? (
                      <>
                        <span className="ccswitch__hint">
                          {isActive ? "它是当前激活的；删除会先停用并重写所有文件。" : "删除后无法恢复。"}
                        </span>
                        <button type="button" className="ghost" onClick={() => setPending(null)} disabled={busy !== null}>
                          取消
                        </button>
                        <button
                          type="button"
                          className="agent-danger-button"
                          disabled={busy !== null}
                          onClick={() =>
                            void run("delete", async () => {
                              await ccswitchCommonDelete(settings, preset.id);
                              setOpenId(null);
                              return `已删除「${preset.name}」。`;
                            })
                          }
                        >
                          确认删除
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="ghost"
                          disabled={busy !== null}
                          onClick={() => {
                            setDraft(draftFromCommon(preset));
                            setMode({ kind: "edit", preset });
                          }}
                        >
                          <Pencil size={13} aria-hidden="true" /> 编辑
                        </button>
                        <button
                          type="button"
                          className="ghost"
                          disabled={busy !== null}
                          onClick={() => setPending({ kind: "delete", id: preset.id })}
                        >
                          <Trash2 size={13} aria-hidden="true" /> 删除
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      {mode.kind !== "list" ? (
        <CcSwitchDrawer
          title={mode.kind === "edit" ? `编辑公共预设：${mode.preset.name}` : "新建公共预设"}
          onClose={() => setMode({ kind: "list" })}
          armed={false}
          onDismissArmed={() => undefined}
        >
          <CcSwitchCommonForm
            editing={mode.kind === "edit" ? mode.preset : null}
            draft={draft}
            onChange={setDraft}
            onCancel={() => setMode({ kind: "list" })}
            onSubmit={(next) => void save(next)}
            busy={busy !== null}
            error={error}
          />
        </CcSwitchDrawer>
      ) : null}
    </div>
  );
}

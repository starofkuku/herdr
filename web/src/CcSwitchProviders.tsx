/*
 * One cc-switch app's providers: what it can run, which one is in use, and how to
 * add, change, or remove one.
 *
 * Switching is the everyday action — the CLI wants a provider id that only this
 * list knows — but the list is also the only place a channel can be edited at
 * all: the CLI wants a JSON document on its command line. Everything that writes
 * goes through `onChanged`, so the list on screen is always the server's answer
 * rather than a local guess.
 */

import { useEffect, useState } from "react";
import { Check, FileInput, Loader2, Plus } from "lucide-react";
import {
  ccswitchCreateProvider,
  ccswitchDeleteProvider,
  ccswitchImportLive,
  ccswitchProvider,
  ccswitchProviders,
  ccswitchSwitch,
  ccswitchUpdateProvider,
  type CcSwitchProvider,
  type CcSwitchProviderDetail,
  type CcSwitchSettings,
} from "./ccswitch";
import { CcSwitchProviderDetailView } from "./CcSwitchProviderDetail";
import { CcSwitchDrawer } from "./CcSwitchDrawer";
import {
  CcSwitchProviderForm,
  draftFrom,
  parseSettings,
  type ProviderDraft,
} from "./CcSwitchProviderForm";

/** What the section is doing instead of just listing. */
type Mode = { kind: "list" } | { kind: "create" } | { kind: "edit" };

export function CcSwitchProviders({
  settings,
  app,
  revision,
  onChanged,
}: {
  settings: CcSwitchSettings;
  app: string;
  /** Bumped by the panel after a write, so this refetches the server's answer. */
  revision: number;
  onChanged: () => void;
}) {
  const [providers, setProviders] = useState<CcSwitchProvider[] | null>(null);
  const [current, setCurrent] = useState<string | undefined>(undefined);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CcSwitchProviderDetail | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: "list" });
  const [draft, setDraft] = useState<ProviderDraft>(() => draftFrom(null));
  const [editing, setEditing] = useState<CcSwitchProviderDetail | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [armed, setArmed] = useState(false);
  // The import variants that overwrite or prune are pi-only; the plain button
  // covers every app, so the menu only appears where it does something.
  const [importMenu, setImportMenu] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let live = true;
    setProviders(null);
    setDetail(null);
    setOpenId(null);
    setMode({ kind: "list" });
    ccswitchProviders(settings, app)
      .then((result) => {
        if (!live) return;
        setProviders(result.providers);
        // The row's own mark wins: `current` is only set once cc-switch has
        // recorded a switch, while the list marks what the live config holds.
        setCurrent(result.providers.find((provider) => provider.current)?.id ?? result.current);
      })
      .catch((err: unknown) => {
        if (!live) return;
        setProviders([]);
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      live = false;
    };
  }, [settings, app, revision]);

  // Cleared when the app changes rather than on every refetch, so the answer to a
  // write is not wiped by the refetch that write caused.
  useEffect(() => {
    setError("");
    setNotice("");
  }, [app]);


    const beginEdit = async (provider: CcSwitchProvider) => {
      setError("");
      try {
        startEdit(await ccswitchProvider(settings, app, provider.id));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    };

    const beginDelete = async (provider: CcSwitchProvider) => {
      setOpenId(provider.id);
      setDetail(null);
      setConfirmingDelete(false);
      setError("");
      try {
        setDetail(await ccswitchProvider(settings, app, provider.id));
        setConfirmingDelete(true);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    };

  const switchTo = async (provider: CcSwitchProvider) => {
    if (busy) return;
    setBusy(provider.id);
    setError("");
    setNotice("");
    try {
      await ccswitchSwitch(settings, app, provider.id);
      setNotice(`已切换到 ${provider.name}。运行中的 agent 要重新启动才会读到新配置。`);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const startCreate = () => {
    setEditing(null);
    setDraft(draftFrom(null));
    setMode({ kind: "create" });
    setArmed(false);
    setError("");
  };

  const startEdit = (provider: CcSwitchProviderDetail) => {
    setEditing(provider);
    setDraft(draftFrom(provider));
    setMode({ kind: "edit" });
    setArmed(false);
    setError("");
  };

  /*
   * Adopts the live config into the database.
   *
   * cc-switch is normally the source — its database is written into the live
   * file; this is the reverse, for when something else (an editor, a migration,
   * another tool) wrote the file first. The summary says what it did, because
   * "nothing to adopt" and "adopted three" are very different answers.
   */
  const importLive = async (options: { update?: boolean; prune?: boolean }) => {
    setBusy("import");
    setError("");
    setNotice("");
    try {
      const result = await ccswitchImportLive(settings, app, options);
      const parts: string[] = [];
      if (result.added) parts.push(`新增 ${result.added}`);
      if (result.updated) parts.push(`更新 ${result.updated}`);
      if (result.pruned) parts.push(`清理 ${result.pruned}`);
      setNotice(
        parts.length
          ? `已从配置文件导入：${parts.join("，")}。`
          : "已从配置文件导入：没有需要收编的条目。",
      );
      setImportMenu(false);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const save = async (next: ProviderDraft) => {
    setBusy("save");
    setError("");
    setNotice("");
    try {
      if (editing) {
        const parsed = parseSettings(next.settings);
        // Only send the document when it actually changed: a rename must not be
        // able to overwrite a secret with the mask a read put there.
        const changed = next.settings.trim() !== draftFrom(editing).settings.trim();
        if (changed && parsed.error) throw new Error(parsed.error);
        /*
         * A `***` in the document is the mask a read put there, not a value:
         * cc-switch restores those leaves from what it stores before writing,
         * so an edit may be saved with the mask still in it. No guard, no
         * retyping — this tool is for the reader's own intranet.
         */
        await ccswitchUpdateProvider(settings, app, editing.id, {
          name: next.name,
          notes: next.notes,
          websiteUrl: next.websiteUrl,
          ...(changed ? { settingsConfig: parsed.value } : {}),
        });
        setNotice(`已保存 ${next.name}${changed ? "（含配置改动）" : "（只改了名称/备注/站点）"}。`);
      } else {
        const parsed = parseSettings(next.settings);
        if (parsed.error) throw new Error(parsed.error);
        const id = await ccswitchCreateProvider(settings, app, {
          id: next.id.trim() || undefined,
          name: next.name,
          notes: next.notes,
          websiteUrl: next.websiteUrl,
          settingsConfig: parsed.value,
        });
        setNotice(`已新建渠道 ${next.name}${id ? `（id ${id}）` : ""}。它还不是当前渠道，需要时点「切换」。`);
      }
      setMode({ kind: "list" });
      setEditing(null);
      setArmed(false);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  /*
   * Closing is armed while the draft differs from what was opened: the drawer
   * asks once before dropping an edit, and any further change disarms it again.
   */
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftFrom(editing));
  const closeEditor = () => {
    setMode({ kind: "list" });
    setEditing(null);
    setArmed(false);
    setError("");
  };
  const requestClose = () => {
    if (mode.kind !== "list" && dirty && !armed) {
      setArmed(true);
      return;
    }
    closeEditor();
  };

  const remove = async (provider: CcSwitchProviderDetail) => {
    setBusy("delete");
    setError("");
    setNotice("");
    try {
      await ccswitchDeleteProvider(settings, app, provider.id);
      setNotice(`已删除 ${provider.name}。`);
      setConfirmingDelete(false);
      setOpenId(null);
      setDetail(null);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="ccswitch__section">
      {error ? (
        <p className="ccswitch__note error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? <p className="ccswitch__note ok">{notice}</p> : null}

      <>
          <div className="ccswitch__section-head">
            <span className="ccswitch__hint">
              共 {providers?.length ?? "…"} 个渠道
              {current ? "，绿色边框是当前使用的那个" : ""}
            </span>
            <div className="ccswitch__head-actions">
              <div className="ccswitch__import">
                <button
                  type="button"
                  className="ghost"
                  onClick={() => void importLive({})}
                  disabled={busy !== null}
                  title={
                    app === "pi"
                      ? "把 ~/.pi/agent/models.json 里手工加过的渠道收编进库（只增）"
                      : "把该 app 当前实际的 live 配置收编为库里的一个供应商"
                  }
                >
                  <FileInput size={13} aria-hidden="true" />
                  {busy === "import" ? "导入中…" : "从配置文件导入"}
                </button>
                {app === "pi" ? (
                  <button
                    type="button"
                    className="ghost ccswitch__import-caret"
                    onClick={() => setImportMenu((open) => !open)}
                    disabled={busy !== null}
                    aria-expanded={importMenu}
                    aria-label="更多导入方式"
                    title="更多导入方式（覆盖/清理仅 pi 支持）"
                  >
                    ▾
                  </button>
                ) : null}
                {importMenu && app === "pi" ? (
                  <div className="ccswitch__import-menu" role="menu">
                    <button type="button" role="menuitem" onClick={() => void importLive({})}>
                      只增（默认）
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => void importLive({ update: true })}
                      title="两边都有的渠道，用文件里的内容覆盖库"
                    >
                      覆盖已有条目
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => void importLive({ update: true, prune: true })}
                      title="覆盖之外，还删掉库里存在但文件里已消失的渠道"
                    >
                      覆盖 + 清理已消失的
                    </button>
                  </div>
                ) : null}
              </div>
              <button type="button" className="ghost ccswitch__new" onClick={startCreate} disabled={busy !== null}>
                <Plus size={13} aria-hidden="true" /> 新建渠道
              </button>
            </div>
          </div>

          {providers === null ? (
            <p className="ccswitch__note">
              <Loader2 size={13} className="ccswitch__spin" aria-hidden="true" /> 正在读取…
            </p>
          ) : null}
          {providers?.length === 0 ? (
            <p className="ccswitch__note">这个 app 还没有渠道，点「新建渠道」添加一个。</p>
          ) : null}

          <ul className="ccswitch__list">
            {providers?.map((provider) => {
              const isCurrent = provider.id === current;
              return (
                <li key={provider.id} className={`ccswitch__row${isCurrent ? " current" : ""}`}>
                  {/* The row itself no longer opens anything on a click: editing and
                     deleting are explicit buttons beside it, so a tap that only
                     meant to look costs nothing. */}
                  <button
                    type="button"
                    className="ccswitch__row-main"
                    onClick={() => void beginEdit(provider)}
                    title="点击编辑此渠道"
                  >
                    <span className="ccswitch__name">{provider.name}</span>
                    <span className="ccswitch__id">{provider.id}</span>
                    {isCurrent ? (
                      <span className="ccswitch__badge">
                        <Check size={11} aria-hidden="true" /> 使用中
                      </span>
                    ) : null}
                  </button>
                  <button
                    type="button"
                    className="ghost ccswitch__action"
                    disabled={busy !== null}
                    onClick={() => void beginEdit(provider)}
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    className="ghost ccswitch__action"
                    disabled={busy !== null}
                    onClick={() => void beginDelete(provider)}
                  >
                    删除
                  </button>
                  <button
                    type="button"
                    className="ghost ccswitch__action"
                    disabled={isCurrent || busy !== null}
                    onClick={() => void switchTo(provider)}
                  >
                    {busy === provider.id ? "切换中…" : isCurrent ? "当前" : "切换"}
                  </button>
                                  </li>
              );
            })}
          </ul>

          {openId && detail ? (
            <CcSwitchProviderDetailView
              detail={detail}
              confirming={confirmingDelete}
              busy={busy !== null}
              onEdit={() => startEdit(detail)}
              onRequestDelete={() => setConfirmingDelete(true)}
              onConfirmDelete={() => void remove(detail)}
              onCancelDelete={() => setConfirmingDelete(false)}
            />
          ) : null}
          {openId && !detail && !error ? <p className="ccswitch__note">正在读取渠道…</p> : null}
        </>

      {mode.kind !== "list" ? (
        <CcSwitchDrawer
          title={editing ? `编辑渠道：${editing.name}` : "新建渠道"}
          onClose={requestClose}
          armed={armed}
          onDismissArmed={() => setArmed(false)}
        >
          <CcSwitchProviderForm
            app={app}
            connection={settings}
            editing={editing}
            draft={draft}
            onChange={(next) => {
              setDraft(next);
              setArmed(false);
            }}
            onCancel={requestClose}
            onSubmit={(next) => void save(next)}
            busy={busy !== null}
            error={error}
          />
        </CcSwitchDrawer>
      ) : null}
    </div>
  );
}

/*
 * Prompt presets for one cc-switch app: the ones it keeps, and which is live.
 *
 * An app reads its prompt from a live file (pi's `AGENTS.md`, for example), and
 * activating a preset writes that file — so the list marks the enabled one and
 * the rest are one action away. Editing an enabled preset re-activates it after
 * saving, because a saved record alone never reaches the file the agent reads.
 */

import { useEffect, useState } from "react";
import { Check, Loader2, Pencil, Plus } from "lucide-react";
import {
  ccswitchActivatePrompt,
  ccswitchCreatePrompt,
  ccswitchPrompts,
  ccswitchUpdatePrompt,
  type CcSwitchPrompt,
  type CcSwitchSettings,
} from "./ccswitch";
import { CcSwitchPromptForm, draftFromPrompt, type PromptDraft } from "./CcSwitchPromptForm";
import { CcSwitchDrawer } from "./CcSwitchDrawer";

/** What the section is doing instead of just listing. */
type Mode = { kind: "list" } | { kind: "create" } | { kind: "edit"; prompt: CcSwitchPrompt };

export function CcSwitchPrompts({
  settings,
  app,
  revision,
  onChanged,
}: {
  settings: CcSwitchSettings;
  app: string;
  revision: number;
  onChanged: () => void;
}) {
  const [prompts, setPrompts] = useState<CcSwitchPrompt[] | null>(null);
  const [active, setActive] = useState<string[]>([]);
  const [mode, setMode] = useState<Mode>({ kind: "list" });
  const [draft, setDraft] = useState<PromptDraft>(() => draftFromPrompt(null));
  const [busy, setBusy] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  // Cleared when the app changes rather than on every refetch: a refetch is
  // usually the tail of a write, and wiping the notice right then would hide the
  // answer to the click that caused it.
  useEffect(() => {
    setError("");
    setNotice("");
  }, [app]);

  useEffect(() => {
    let live = true;
    setPrompts(null);
    setMode({ kind: "list" });
    ccswitchPrompts(settings, app)
      .then((result) => {
        if (!live) return;
        setPrompts(result.prompts);
        setActive(result.active);
      })
      .catch((err: unknown) => {
        if (!live) return;
        setPrompts([]);
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      live = false;
    };
  }, [settings, app, revision]);

  const activate = async (prompt: CcSwitchPrompt) => {
    if (busy) return;
    setBusy(prompt.id);
    setError("");
    setNotice("");
    try {
      await ccswitchActivatePrompt(settings, app, prompt.id);
      setNotice(`已启用「${prompt.name}」：内容已写入该 app 的实际提示词文件，正在运行的 agent 要重启才会读到。`);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const save = async (next: PromptDraft) => {
    setBusy("save");
    setError("");
    setNotice("");
    try {
      if (mode.kind === "edit") {
        // Whether an enabled preset's new content reaches the live prompt file
        // is the server's call now; the page only saves the record.
        await ccswitchUpdatePrompt(settings, app, mode.prompt.id, next);
        setNotice(`已保存「${next.name}」。`);
      } else {
        const id = await ccswitchCreatePrompt(settings, app, next);
        setNotice(`已新建预设「${next.name}」${id ? `（id ${id}）` : ""}。`);
      }
      setMode({ kind: "list" });
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
  const dirty =
    JSON.stringify(draft) !== JSON.stringify(draftFromPrompt(mode.kind === "edit" ? mode.prompt : null));
  const closeEditor = () => {
    setMode({ kind: "list" });
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
              共 {prompts?.length ?? "…"} 个预设；已启用的那个就是当前写进实际文件的
            </span>
            <button
              type="button"
              className="ghost ccswitch__new"
              onClick={() => {
                setDraft(draftFromPrompt(null));
                setMode({ kind: "create" });
                setArmed(false);
                setError("");
              }}
              disabled={busy !== null}
            >
              <Plus size={13} aria-hidden="true" /> 新建预设
            </button>
          </div>

          {prompts === null ? (
            <p className="ccswitch__note">
              <Loader2 size={13} className="ccswitch__spin" aria-hidden="true" /> 正在读取…
            </p>
          ) : null}
          {prompts?.length === 0 && !error ? (
            <p className="ccswitch__note">这个 app 还没有提示词预设，点「新建预设」添加一个。</p>
          ) : null}

          <ul className="ccswitch__list">
            {prompts?.map((prompt) => {
              const isActive = active.includes(prompt.id);
              return (
                <li key={prompt.id} className={`ccswitch__row${isActive ? " current" : ""}`}>
                  <div className="ccswitch__row-line">
                    <button
                      type="button"
                      className="ccswitch__row-main"
                      onClick={() => {
                        setDraft(draftFromPrompt(prompt));
                        setMode({ kind: "edit", prompt });
                        setArmed(false);
                        setError("");
                      }}
                      title="点击编辑此预设"
                    >
                        <span className="ccswitch__name">{prompt.name}</span>
                        {prompt.description ? (
                          <span className="ccswitch__agent" title={prompt.description}>
                            {prompt.description}
                          </span>
                        ) : null}
                        {isActive ? (
                          <span className="ccswitch__badge">
                            <Check size={11} aria-hidden="true" /> 已启用
                          </span>
                        ) : null}
                      </button>
                      <button
                        type="button"
                        className="ghost ccswitch__action"
                        onClick={() => {
                          setDraft(draftFromPrompt(prompt));
                          setMode({ kind: "edit", prompt });
                          setArmed(false);
                          setError("");
                        }}
                        disabled={busy !== null}
                      >
                        <Pencil size={13} aria-hidden="true" /> 编辑
                      </button>                    <button
                      type="button"
                      className="ghost ccswitch__action"
                      disabled={isActive || busy !== null}
                      onClick={() => void activate(prompt)}
                    >
                      {busy === prompt.id ? "启用中…" : isActive ? "启用中" : "启用"}
                    </button>
                  </div>

                </li>
              );
            })}
          </ul>
        </>

      {mode.kind !== "list" ? (
        <CcSwitchDrawer
          title={mode.kind === "edit" ? `编辑预设：${mode.prompt.name}` : "新建预设"}
          onClose={requestClose}
          armed={armed}
          onDismissArmed={() => setArmed(false)}
        >
          <CcSwitchPromptForm
            editing={mode.kind === "edit" ? mode.prompt : null}
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

/*
 * The per-app common config snippet, on the tool page.
 *
 * This is the part of an app's live config that carries across provider
 * switches: Claude's hooks and permissions, Codex's non-provider TOML tables,
 * Gemini's proxy env. cc-switch merges it into the live file on every switch;
 * editing it here means editing it once instead of per-provider.
 *
 * The content is raw text — JSON for most apps, TOML for Codex — so the editor
 * is a plain textarea with the format stated, not a CodeMirror JSON editor that
 * would reject the TOML half.
 */

import { useEffect, useState } from "react";
import { Save } from "lucide-react";
import {
  ccswitchCommonConfig,
  ccswitchSaveCommonConfig,
  type CcSwitchSettings,
} from "./ccswitch";

export function CcSwitchCommonConfigEditor({
  settings,
  app,
  revision,
  onChanged,
}: {
  settings: CcSwitchSettings;
  app: string;
  /** Bumped by the panel after a write, so this refetches. */
  revision: number;
  onChanged: () => void;
}) {
  const [text, setText] = useState("");
  const [format, setFormat] = useState<"json" | "toml">("json");
  const [state, setState] = useState<"loading" | "ready" | "saving">("loading");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let live = true;
    setState("loading");
    setError("");
    setNotice("");
    ccswitchCommonConfig(settings, app)
      .then((result) => {
        if (!live) return;
        setText(result.content ?? "");
        setFormat(result.format);
        setState("ready");
      })
      .catch((err: unknown) => {
        if (!live) return;
        setError(err instanceof Error ? err.message : String(err));
        setText("");
        setState("ready");
      });
    return () => {
      live = false;
    };
  }, [settings, app, revision]);

  const save = async () => {
    if (format === "json" && text.trim()) {
      try {
        JSON.parse(text);
      } catch (err) {
        setError(`JSON 不合法：${err instanceof Error ? err.message : String(err)}`);
        return;
      }
    }
    setState("saving");
    setError("");
    setNotice("");
    try {
      await ccswitchSaveCommonConfig(settings, app, text);
      setNotice(text.trim() ? "已保存。切换渠道时会合并进 live 配置。" : "已清除该 app 的公用配置。");
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setState("ready");
    }
  };

  if (state === "loading") {
    return (
      <div className="ccswitch__section">
        <p className="ccswitch__note">正在读取公用配置…</p>
      </div>
    );
  }

  return (
    <div className="ccswitch__section">
      <div className="ccswitch__section-head">
        <span className="ccswitch__hint">
          {format === "toml" ? "TOML" : "JSON"} 格式 ✗ 切换渠道时这部分会合并进 live
          配置，不用每个渠道重复配 ✓
        </span>
      </div>

      {!text.trim() ? (
        <p className="ccswitch__note">这个 app 还没有设置公用配置。写好内容后点保存。</p>
      ) : null}

      <div className="ccswitch__field ccswitch__field--grow">
        <span>公用配置内容（{format === "toml" ? "TOML" : "JSON"} ✗</span>
        <textarea
          className="ccswitch__settings"
          value={text}
          onChange={(event) => setText(event.target.value)}
          spellCheck={false}
          rows={16}
          placeholder={format === "toml" ? "# TOML…" : '{ "key": "value" }'}
        />
      </div>

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

      <div className="ccswitch__actions">
        <button
          type="button"
          className="ghost"
          disabled={state === "saving"}
          onClick={() => setText("")}
        >
          清空
        </button>
        <button
          type="button"
          className="agent-primary-button"
          disabled={state === "saving"}
          onClick={() => void save()}
        >
          {state === "saving" ? "保存中…" : <><Save size={14} aria-hidden="true" /> 保存</>}
        </button>
      </div>
    </div>
  );
}

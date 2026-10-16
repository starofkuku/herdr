/*
 * The cc-switch page: the tool that manages every CLI agent's provider
 * configurations, as a page of its own rather than a dialog over a
 * conversation, so creating and editing have room to work in.
 *
 * Two things are the reader's to set — where cc-switch listens and what token it
 * wants — so the page opens on a short form the first time, and keeps both in
 * this browser. Everything after that is the tool's own model: pick an app, then
 * its providers, its prompt presets, or cloud sync beside them.
 */

import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, BookText, CloudCog, Plug, RefreshCw, Settings2 } from "lucide-react";
import { ThemeToggle } from "./ThemeToggle";
import {
  appLabel,
  ccswitchHealth,
  loadCcSwitchSettings,
  saveCcSwitchSettings,
  type CcSwitchHealth,
  type CcSwitchSettings,
} from "./ccswitch";
import { CcSwitchProviders } from "./CcSwitchProviders";
import { CcSwitchPrompts } from "./CcSwitchPrompts";
import { CcSwitchSync } from "./CcSwitchSync";
import { CcSwitchCommon } from "./CcSwitchCommon";
import "./ccswitch.css";

type Section = "providers" | "prompts";

/** The port cc-switch serves on unless it was told otherwise. */
const DEFAULT_CCSWITCH_PORT = "7861";

/** The port of a stored `host:port` address, when it carries one. */
function portOf(address: string | undefined): string | null {
  if (!address) return null;
  const withoutScheme = address.trim().replace(/^https?:\/\//i, "");
  const port = withoutScheme.split("/")[0]?.split(":")[1];
  return port && /^\d+$/.test(port) ? port : null;
}

export function CcSwitchPage({ onBack }: { onBack: () => void }) {
  const [settings, setSettings] = useState<CcSwitchSettings | null>(loadCcSwitchSettings);
  const [editing, setEditing] = useState(settings === null);
  const [health, setHealth] = useState<CcSwitchHealth | null>(null);
  const [app, setApp] = useState<string | null>(null);
  const [section, setSection] = useState<Section>("providers");
  // Sync and the global preamble are not per-app — one snapshots the whole tool,
  // the other is a single active preset rendered into every app's files — so
  // they are views beside the apps rather than tabs among the per-app sections.
  const [view, setView] = useState<"app" | "sync" | "common">("app");
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  const [connecting, setConnecting] = useState(false);

  /*
   * The host is not typed, it is observed: cc-switch runs beside the gateway
   * that served this page, so the name in the address bar is already the right
   * one — and only it is right, since `127.0.0.1` here would mean the browser's
   * own machine rather than the one the gateway is on. The port is the one thing
   * that can differ, so it is the one thing offered.
   */
  const host = window.location.hostname || "127.0.0.1";
  const [port, setPort] = useState(() => portOf(settings?.address) ?? DEFAULT_CCSWITCH_PORT);
  const [token, setToken] = useState(settings?.token ?? "");

  useEffect(() => {
    if (!settings) return;
    let live = true;
    setHealth(null);
    setError("");
    ccswitchHealth(settings)
      .then((result) => {
        if (!live) return;
        setHealth(result);
        setApp((current) => (current && result.apps.includes(current) ? current : result.apps[0] ?? null));
      })
      .catch((err: unknown) => {
        if (live) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      live = false;
    };
  }, [settings, revision]);

  const connect = useCallback(async () => {
    const digits = port.trim();
    if (!/^\d+$/.test(digits) || Number(digits) < 1 || Number(digits) > 65535) {
      setError("端口需要是 1-65535 之间的数字。");
      return;
    }
    const next = { address: `${host}:${digits}`, token };
    setConnecting(true);
    setError("");
    try {
      const result = await ccswitchHealth(next);
      if (!saveCcSwitchSettings(next)) {
        setError("无法保存到浏览器存储；本次连接仍可用，但刷新后会丢。");
      }
      setSettings(next);
      setHealth(result);
      setApp(result.apps[0] ?? null);
      setEditing(false);
      setRevision((value) => value + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setConnecting(false);
    }
  }, [host, port, token]);

  const disconnect = () => {
    saveCcSwitchSettings(null);
    setSettings(null);
    setHealth(null);
    setApp(null);
    setEditing(true);
    setError("");
  };

  const changed = () => setRevision((value) => value + 1);

  return (
    <div className="ccswitch-page">
      <header className="ccswitch-page__head">
        <button type="button" className="ghost" onClick={onBack} aria-label="返回" title="返回">
          <ArrowLeft size={16} aria-hidden="true" />
        </button>
        <span className="ccswitch__symbol" aria-hidden="true">
          <Plug size={16} />
        </span>
        <h2 className="ccswitch-page__title">cc-switch</h2>
        {settings && !editing ? (
          <>
            <span className="ccswitch__endpoint" title={`${settings.address} · cc-switch ${health?.version ?? ""}`}>
              {settings.address}
              {health ? ` · v${health.version}` : ""}
            </span>
            <button type="button" className="ghost" onClick={changed} aria-label="刷新" title="刷新">
              <RefreshCw size={15} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="ghost"
              onClick={() => setEditing(true)}
              aria-label="连接设置"
              title="连接设置"
            >
              <Settings2 size={15} aria-hidden="true" />
            </button>
          </>
        ) : null}
        <ThemeToggle />
      </header>

      {editing ? (
        <form
          className="ccswitch__setup"
          onSubmit={(event) => {
            event.preventDefault();
            void connect();
          }}
        >
          <p className="ccswitch__hint">
            地址取当前页面的服务器，端口默认 7861；令牌与端口只保存在本浏览器，请求由浏览器直接发往该地址（需要 cc-switch
            5.10.20+，并绑定到一个浏览器能访问的地址）。
          </p>
          <div className="ccswitch__pair">
            <label className="ccswitch__field">
              <span>地址（当前服务器）</span>
              <input
                value={host}
                readOnly
                title="跟随打开本页面的地址：cc-switch 与 herdr 网关在同一台机器上"
              />
            </label>
            <label className="ccswitch__field ccswitch__field--port">
              <span>端口</span>
              <input
                value={port}
                onChange={(event) => setPort(event.target.value)}
                placeholder="7861"
                inputMode="numeric"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
          </div>
          <label className="ccswitch__field">
            <span>令牌</span>
            <input
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder="cc-switch server token"
              autoComplete="off"
              spellCheck={false}
              type="password"
            />
          </label>
          {error ? (
            <p className="ccswitch__note error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="ccswitch__actions">
            <button type="button" className="ghost" onClick={() => (settings ? setEditing(false) : onBack())}>
              取消
            </button>
            <button type="submit" className="agent-primary-button" disabled={connecting || !port.trim()}>
              {connecting ? "连接中…" : "保存并连接"}
            </button>
          </div>
        </form>
      ) : (
        <div className="settings-panel__body ccswitch__body ccswitch-page__body">
          <nav className="settings-panel__nav" aria-label="应用与云同步">
            <button
              type="button"
              className={`settings-panel__nav-item ccswitch__nav-sync${view === "sync" ? " active" : ""}`}
              aria-current={view === "sync" ? "page" : undefined}
              onClick={() => setView("sync")}
            >
              <CloudCog size={13} aria-hidden="true" /> 云同步
            </button>
            <button
              type="button"
              className={`settings-panel__nav-item ccswitch__nav-sync${
                view === "common" ? " active" : ""
              }`}
              aria-current={view === "common" ? "page" : undefined}
              onClick={() => setView("common")}
            >
              <BookText size={13} aria-hidden="true" /> 公共提示词
            </button>
            <div className="ccswitch__nav-sep" aria-hidden="true" />
            {health?.apps.map((id) => (
              <button
                key={id}
                type="button"
                className={`settings-panel__nav-item${view === "app" && id === app ? " active" : ""}`}
                aria-current={view === "app" && id === app ? "page" : undefined}
                onClick={() => {
                  setApp(id);
                  setView("app");
                }}
              >
                {appLabel(id)}
              </button>
            ))}
            {!health && !error ? <p className="ccswitch__note">正在连接…</p> : null}
          </nav>

          <div className="settings-panel__content">
            {error ? (
              <p className="ccswitch__note error" role="alert">
                {error}
                <button type="button" className="ghost" onClick={disconnect}>
                  改连接设置
                </button>
              </p>
            ) : null}
            {settings && view === "common" ? (
              <CcSwitchCommon settings={settings} revision={revision} />
            ) : settings && view === "sync" ? (
              <CcSwitchSync settings={settings} onChanged={changed} />
            ) : app && settings ? (
              <>
                <div className="ccswitch__tabs" role="tablist">
                  {(
                    [
                      ["providers", "供应商"],
                      ["prompts", "提示词"],
                    ] as const
                  ).map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      role="tab"
                      aria-selected={section === id}
                      className={`ccswitch__tab${section === id ? " active" : ""}`}
                      onClick={() => setSection(id)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {section === "providers" ? (
                  <CcSwitchProviders settings={settings} app={app} revision={revision} onChanged={changed} />
                ) : (
                  <CcSwitchPrompts settings={settings} app={app} revision={revision} onChanged={changed} />
                )}
              </>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

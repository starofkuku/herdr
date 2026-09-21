import { useCallback, useEffect, useState } from "react";
import type { GatewayClient } from "./gateway";

/**
 * The notification settings, read from and written to the server.
 *
 * Only the settings the server's `config.notification.get` reports are shown, and
 * only those `config.notification.set` accepts: keys like `web.static_dir` decide
 * where files land and are deliberately not reachable from a page.
 *
 * The signing secret is the one field that cannot be read back. The server reports
 * whether one is set and the field starts empty; it is only sent when the reader
 * types a new one, so saving another setting cannot clear a key that is there.
 */
export interface NotificationSettings {
  toast_delivery: string;
  toast_delay_seconds: number;
  bell_enabled: boolean;
  sound_enabled: boolean;
  feishu_enabled: boolean;
  feishu_url: string;
  feishu_secret_set: boolean;
  feishu_delay_seconds: number;
}

/** What `config.notification.set` takes. Absent fields are left as they are. */
interface SettingsPatch {
  // The gateway takes a params record, so the type needs an index signature to
  // be passed through. The named fields below are what the server accepts; the
  // signature is only what makes the call type-check.
  [key: string]: string | number | boolean | undefined;
  toast_delivery?: string;
  toast_delay_seconds?: number;
  bell_enabled?: boolean;
  sound_enabled?: boolean;
  feishu_enabled?: boolean;
  feishu_url?: string;
  feishu_secret?: string;
  feishu_delay_seconds?: number;
}

const DELIVERY_MODES = ["off", "herdr", "terminal", "system"] as const;

export function NotificationPanel({
  client,
  onClose,
}: {
  client: GatewayClient;
  onClose: () => void;
}) {
  const [settings, setSettings] = useState<NotificationSettings | null>(null);
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await client.call<{ config: NotificationSettings }>(
        "config.notification.get",
      );
      setSettings(result.config);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  // Every change is written on its own rather than on a save button: each field
  // is independent, and a page-level save would need to decide what an untouched
  // field means. Only the touched key is sent, so the others keep their values.
  const patch = async (change: SettingsPatch) => {
    setBusy(true);
    try {
      await client.call("config.notification.set", change);
      // Reload rather than patch local state: the server is the one that knows
      // what a write actually produced.
      await load();
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="notification-panel" role="dialog" aria-label="Notifications">
      <div className="notification-panel__panel">
        <header className="notification-panel__head">
          <span className="notification-panel__title">通知设置</span>
          <button type="button" className="ghost" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <div className="notification-panel__body">
          {error ? <p className="error banner">{error}</p> : null}
          {!settings ? (
            <p className="hint">loading…</p>
          ) : (
            <>
              <section className="notification-group">
                <h3>屏幕提示</h3>
                <label className="notification-field">
                  <span>提示方式</span>
                  <select
                    value={settings.toast_delivery}
                    disabled={busy}
                    onChange={(event) => void patch({ toast_delivery: event.target.value })}
                  >
                    {DELIVERY_MODES.map((mode) => (
                      <option key={mode} value={mode}>
                        {mode}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="notification-field">
                  <span>延迟（秒）</span>
                  <input
                    type="number"
                    min={0}
                    max={3600}
                    defaultValue={settings.toast_delay_seconds}
                    disabled={busy}
                    onBlur={(event) =>
                      void patch({ toast_delay_seconds: Number(event.target.value) })
                    }
                  />
                </label>
                <label className="notification-field">
                  <span>终端响铃</span>
                  <input
                    type="checkbox"
                    checked={settings.bell_enabled}
                    disabled={busy}
                    onChange={(event) => void patch({ bell_enabled: event.target.checked })}
                  />
                </label>
                <label className="notification-field">
                  <span>声音</span>
                  <input
                    type="checkbox"
                    checked={settings.sound_enabled}
                    disabled={busy}
                    onChange={(event) => void patch({ sound_enabled: event.target.checked })}
                  />
                </label>
              </section>

              <section className="notification-group">
                <h3>飞书推送</h3>
                <label className="notification-field">
                  <span>启用</span>
                  <input
                    type="checkbox"
                    checked={settings.feishu_enabled}
                    disabled={busy}
                    onChange={(event) => void patch({ feishu_enabled: event.target.checked })}
                  />
                </label>
                <label className="notification-field">
                  <span>Webhook URL</span>
                  <input
                    type="text"
                    defaultValue={settings.feishu_url}
                    disabled={busy}
                    onBlur={(event) => void patch({ feishu_url: event.target.value })}
                  />
                </label>
                <label className="notification-field">
                  <span>延迟（秒）</span>
                  <input
                    type="number"
                    min={0}
                    defaultValue={settings.feishu_delay_seconds}
                    disabled={busy}
                    onBlur={(event) =>
                      void patch({ feishu_delay_seconds: Number(event.target.value) })
                    }
                  />
                </label>
                <label className="notification-field">
                  <span>签名密钥</span>
                  <input
                    type="password"
                    value={secret}
                    // Empty means "leave the stored key alone", so the placeholder
                    // reports whether one exists without revealing it.
                    placeholder={settings.feishu_secret_set ? "已设置（留空则不修改）" : "未设置"}
                    disabled={busy}
                    onChange={(event) => setSecret(event.target.value)}
                  />
                </label>
                <button
                  type="button"
                  className="ghost"
                  disabled={busy || secret === ""}
                  onClick={() => {
                    void patch({ feishu_secret: secret }).then(() => setSecret(""));
                  }}
                >
                  保存密钥
                </button>
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

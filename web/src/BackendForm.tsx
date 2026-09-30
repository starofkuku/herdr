import { useState, type FormEvent } from "react";
import { nameFromUrl, newBackendId, type BackendProfile } from "./settings";

/** The fields a form reports back; the caller owns the stored profile. */
export interface BackendDraft {
  name: string;
  url: string;
  key: string;
  remember: boolean;
}

/**
 * Accepts a bare host, which is what a reader is most likely to type.
 *
 * The gateway speaks WebSocket, so an address without a scheme is assumed to be
 * one; `http://` and `https://` are translated rather than rejected, because
 * pasting a browser address is the other thing people do.
 */
export function normalizeGatewayUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith("ws://") || trimmed.startsWith("wss://")) return trimmed;
  if (trimmed.startsWith("http://")) return `ws://${trimmed.slice("http://".length)}`;
  if (trimmed.startsWith("https://")) return `wss://${trimmed.slice("https://".length)}`;
  return `ws://${trimmed}`;
}

/**
 * Adds a backend, or edits a saved one.
 *
 * The name is required and the address is required; a key is required because
 * the gateway does not listen without one, so a form that accepted an empty key
 * would be offering a connection that cannot work.
 *
 * The name fills itself from the address until the reader types their own, so
 * the field is required without being an extra step.
 */
export function BackendForm({
  initial,
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  /** The profile being edited, or undefined when adding. */
  initial?: BackendProfile;
  /** True while the connection is being made. */
  busy?: boolean;
  /** A failure to report — a refused key, an unreachable host. */
  error?: string;
  onSubmit: (draft: BackendDraft, id: string) => void;
  onCancel: () => void;
}) {
  const [url, setUrl] = useState(initial?.url ?? "");
  const [key, setKey] = useState(initial?.key ?? "");
  const [remember, setRemember] = useState(initial?.remember ?? true);
  const [name, setName] = useState(initial?.name ?? "");
  /** False until the reader edits the name themselves. */
  const [nameTouched, setNameTouched] = useState(Boolean(initial?.name));
  const [touched, setTouched] = useState(false);

  const normalizedUrl = normalizeGatewayUrl(url);
  const missingName = !name.trim();
  const missingUrl = !normalizedUrl;
  const missingKey = !key.trim();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (missingName || missingUrl || missingKey) return;
    onSubmit(
      { name: name.trim(), url: normalizedUrl, key: key.trim(), remember },
      initial?.id ?? newBackendId(),
    );
  };

  return (
    <form className="connect-form" onSubmit={submit}>
      <h1>{initial ? "编辑后端" : "新建后端"}</h1>
      <p className="subtitle">
        {initial ? "修改后会重新连接这个网关。" : "连接一个 herdr web 网关并保存下来。"}
      </p>

      <label>
        <span>名称</span>
        <input
          type="text"
          autoComplete="off"
          placeholder="例如：编译机"
          value={name}
          onChange={(event) => {
            setNameTouched(true);
            setName(event.target.value);
          }}
        />
        {touched && missingName ? <em className="field-error">请填写名称</em> : null}
      </label>

      <label>
        <span>地址</span>
        <input
          type="text"
          inputMode="url"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="ws://10.0.0.5:8787/"
          value={url}
          onChange={(event) => {
            const next = event.target.value;
            setUrl(next);
            // Until the reader names it themselves, the address names it: a
            // derived name is better than an empty required field.
            if (!nameTouched) setName(nameFromUrl(normalizeGatewayUrl(next)));
          }}
        />
        {touched && missingUrl ? <em className="field-error">请填写地址</em> : null}
      </label>

      <label>
        <span>密钥</span>
        <input
          type="password"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="gateway key"
          value={key}
          onChange={(event) => setKey(event.target.value)}
        />
        {touched && missingKey ? <em className="field-error">请填写密钥</em> : null}
      </label>

      <label className="checkbox">
        <input
          type="checkbox"
          checked={remember}
          onChange={(event) => setRemember(event.target.checked)}
        />
        <span>在这台设备上记住密钥</span>
      </label>

      <div className="form-actions">
        <button type="button" className="ghost" onClick={onCancel}>
          取消
        </button>
        <button type="submit" disabled={busy}>
          {busy ? "连接中…" : initial ? "保存并连接" : "创建并连接"}
        </button>
      </div>

      {error ? <p className="error">{error}</p> : null}
      <p className="hint">
        密钥由服务端的 <code>HERDR_WEB_KEY</code> 设置。没有密钥时网关根本不会监听。
      </p>
    </form>
  );
}

import { useState, type FormEvent } from "react";
import type { ConnectionState } from "./gateway";

interface ConnectFormProps {
  initialUrl: string;
  initialKey: string;
  remember: boolean;
  state: ConnectionState;
  detail?: string;
  onConnect: (url: string, key: string, remember: boolean) => void;
  onRememberChange: (remember: boolean) => void;
}

function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith("ws://") || trimmed.startsWith("wss://")) {
    return trimmed;
  }
  // Accept a bare host and assume the gateway's plain WebSocket scheme.
  if (trimmed.startsWith("http://")) return `ws://${trimmed.slice(7)}`;
  if (trimmed.startsWith("https://")) return `wss://${trimmed.slice(8)}`;
  return `ws://${trimmed}`;
}

export function ConnectForm({
  initialUrl,
  initialKey,
  remember,
  state,
  detail,
  onConnect,
  onRememberChange,
}: ConnectFormProps) {
  const [url, setUrl] = useState(initialUrl);
  const [key, setKey] = useState(initialKey);

  const busy = state === "connecting" || state === "authenticating";

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onConnect(normalizeUrl(url), key.trim(), remember);
  };

  return (
    <form className="connect-form" onSubmit={submit}>
      <h1>herdr web</h1>
      <p className="subtitle">Connect to a Herdr web gateway.</p>

      <label>
        <span>Server address</span>
        <input
          type="text"
          inputMode="url"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="ws://10.0.0.5:8787/"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />
      </label>

      <label>
        <span>Key</span>
        <input
          type="password"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="gateway key"
          value={key}
          onChange={(event) => setKey(event.target.value)}
        />
      </label>

      <label className="checkbox">
        <input
          type="checkbox"
          checked={remember}
          onChange={(event) => onRememberChange(event.target.checked)}
        />
        <span>Remember this key on this device</span>
      </label>

      <button type="submit" disabled={busy || !url.trim() || !key.trim()}>
        {busy ? "connecting…" : "connect"}
      </button>

      {detail ? <p className="error">{detail}</p> : null}
      <p className="hint">
        The key is set on the server with <code>HERDR_WEB_KEY</code>. Without a key the gateway does
        not listen at all.
      </p>
    </form>
  );
}

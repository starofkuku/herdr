// Local, browser-only settings. Nothing here leaves the device except the
// values the user explicitly submits.

const STORAGE_KEY = "herdr-web-settings";

export interface StoredSettings {
  /** Gateway WebSocket URL, for example ws://10.0.0.5:8787. */
  url: string;
  /** Whether to persist the key in localStorage. */
  remember: boolean;
  /** Stored key, only present when `remember` is true. */
  key?: string;
}

/** Best guess for the gateway URL when the page is served by the gateway. */
export function defaultUrl(): string {
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  const host = window.location.host || "127.0.0.1:8787";
  return `${scheme}//${host}/`;
}

const FALLBACK: StoredSettings = { url: "", remember: false };

export function loadSettings(): StoredSettings {
  let stored: Partial<StoredSettings> = {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      stored = JSON.parse(raw) as Partial<StoredSettings>;
    }
  } catch {
    // Corrupt or unavailable storage is not fatal; fall back to defaults.
  }

  return {
    url: typeof stored.url === "string" && stored.url ? stored.url : defaultUrl(),
    remember: stored.remember === true,
    key: typeof stored.key === "string" ? stored.key : undefined,
  };
}

export function saveSettings(settings: StoredSettings): void {
  try {
    const toStore: StoredSettings = {
      url: settings.url,
      remember: settings.remember,
      // Never persist the key unless the user opted in.
      key: settings.remember ? settings.key : undefined,
    };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(toStore));
  } catch {
    // Ignore storage failures (private mode, quota).
  }
}

export { FALLBACK };

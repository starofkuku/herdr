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
  /**
   * Last opened session, restored on the next load.
   *
   * Cleared when the user deliberately leaves the terminal, so returning to
   * the picker is not undone by a refresh.
   */
  session?: string;
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
    // Sessions are not secrets, so remember the name whenever it is present.
    session: typeof stored.session === "string" && stored.session ? stored.session : undefined,
  };
}

export function saveSettings(settings: StoredSettings): void {
  try {
    const toStore: StoredSettings = {
      url: settings.url,
      remember: settings.remember,
      // Never persist the key unless the user opted in.
      key: settings.remember ? settings.key : undefined,
      session: settings.session,
    };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(toStore));
  } catch {
    // Ignore storage failures (private mode, quota).
  }
}

/**
 * Session to restore on load, or null when restoring is not possible.
 *
 * Restoring needs a stored key: without one the user has to authenticate
 * again anyway, and landing on the picker afterwards is expected.
 */
export function restoreTarget(settings: StoredSettings): string | null {
  if (!settings.remember || !settings.key) {
    return null;
  }
  return settings.session ?? null;
}

export { FALLBACK };

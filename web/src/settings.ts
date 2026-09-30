// Local, browser-only settings. Nothing here leaves the device except the
// values the user explicitly submits.
//
// The unit is a *backend*: one herdr gateway, with its own address, key, and
// last-opened session. Two gateways can both have a session called `main` and
// they are different sessions, so nothing about a session is stored globally.

const STORAGE_KEY = "herdr-web-settings";

/** One saved herdr gateway. */
export interface BackendProfile {
  /**
   * Stable id, generated once.
   *
   * Keys the runtime in the hub and appears in the route, so it has to survive
   * edits: renaming a backend must not drop its connection or break a link.
   */
  id: string;
  /** Required display name: what the card and every header call this backend. */
  name: string;
  /** Gateway WebSocket URL, for example `ws://10.0.0.5:8787/`. */
  url: string;
  /** Whether to persist the key in localStorage. */
  remember: boolean;
  /** Stored key, only present when `remember` is true. */
  key?: string;
  /** Last session opened on this backend, offered as the default next time. */
  session?: string;
}

export interface StoredSettings {
  backends: BackendProfile[];
}

/** A fresh id for a backend being added. */
export function newBackendId(): string {
  return `b-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Best guess for the gateway URL when the page is served by the gateway. */
export function defaultUrl(): string {
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  const host = window.location.host || "127.0.0.1:8787";
  return `${scheme}//${host}/`;
}

/**
 * A readable default name for a gateway, from its address.
 *
 * The port is the part that tells two gateways on the same machine apart, so it
 * is kept; the scheme and path say nothing to a reader.
 */
export function nameFromUrl(url: string): string {
  const withoutScheme = url.replace(/^wss?:\/\//i, "");
  const hostPort = withoutScheme.split("/")[0] ?? withoutScheme;
  return hostPort || "gateway";
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Reads one stored profile, dropping anything without an address. */
function asProfile(raw: unknown): BackendProfile | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const url = asString(record.url);
  if (!url) return null;
  const remember = record.remember === true;
  const key = asString(record.key);
  return {
    id: asString(record.id) ?? newBackendId(),
    name: asString(record.name) ?? nameFromUrl(url),
    url,
    remember,
    // A key is only meaningful when the reader asked to keep it.
    key: remember ? key : undefined,
    session: asString(record.session),
  };
}

/**
 * Reads the single-backend format this file used before.
 *
 * One backend with one address was all there was, so the migration is one
 * profile; its name comes from the address, which is what the reader would have
 * typed.
 */
function fromLegacy(stored: Record<string, unknown>): BackendProfile[] {
  const url = asString(stored.url);
  if (!url) return [];
  const profile = asProfile({ ...stored, name: nameFromUrl(url) });
  return profile ? [profile] : [];
}

export function loadSettings(): StoredSettings {
  let stored: Record<string, unknown> = {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object") stored = parsed as Record<string, unknown>;
    }
  } catch {
    // Corrupt or unavailable storage is not fatal; fall back to empty.
  }

  const list = Array.isArray(stored.backends) ? stored.backends : null;
  if (list === null) {
    return { backends: fromLegacy(stored) };
  }
  const backends: BackendProfile[] = [];
  for (const entry of list) {
    const profile = asProfile(entry);
    if (profile) backends.push(profile);
  }
  return { backends };
}

export function saveSettings(settings: StoredSettings): void {
  try {
    // The key is dropped here rather than at each call site, so no path can
    // persist one the reader did not ask to keep.
    const backends = settings.backends.map((backend) =>
      backend.remember ? backend : { ...backend, key: undefined },
    );
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ backends }));
  } catch {
    // Ignore storage failures (private mode, quota).
  }
}

/** Adds a profile, or replaces the one with the same id. */
export function upsertBackend(
  settings: StoredSettings,
  profile: BackendProfile,
): StoredSettings {
  const exists = settings.backends.some((backend) => backend.id === profile.id);
  const backends = exists
    ? settings.backends.map((backend) => (backend.id === profile.id ? profile : backend))
    : [...settings.backends, profile];
  return { backends };
}

/** Removes a profile by id. */
export function removeBackend(settings: StoredSettings, id: string): StoredSettings {
  return { backends: settings.backends.filter((backend) => backend.id !== id) };
}

/** Records the session a backend was last left in. */
export function rememberSession(
  settings: StoredSettings,
  id: string,
  session: string,
): StoredSettings {
  const current = settings.backends.find((backend) => backend.id === id);
  if (!current || current.session === session) return settings;
  return upsertBackend(settings, { ...current, session });
}

/**
 * The backend a bare load should open, if the reader asked to be remembered.
 *
 * A backend without a stored key cannot reconnect on its own, so it is not a
 * candidate: the reader has to supply the key anyway.
 */
export function reconnectTarget(settings: StoredSettings): BackendProfile | null {
  return settings.backends.find((backend) => backend.remember && backend.key) ?? null;
}

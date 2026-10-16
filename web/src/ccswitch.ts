/*
 * cc-switch, the tool that keeps every CLI agent's provider configurations and
 * writes the chosen one into that agent's live config.
 *
 * Requests go straight to it from this browser, so the two things that make
 * that possible are the reader's to set: the address must be one the browser can
 * reach — not the loopback of some other machine — and cc-switch must answer
 * CORS, which it does from 5.10.20 on. Both the address and the token are kept
 * in this browser and sent with every request; nothing about them is configured
 * into herdr, because where cc-switch runs is not herdr's business.
 */

const STORAGE_KEY = "herdr-ccswitch";

/** The address and token of one cc-switch server. */
export interface CcSwitchSettings {
  /** `host:port`, or a full URL when the server sits behind a proxy. */
  address: string;
  token: string;
}

/** The address as a URL: a bare `host:port` is http, which is what it serves. */
export function ccswitchBase(address: string): string {
  const trimmed = address.trim().replace(/\/+$/, "");
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

/** What `GET /api/health` reports, and the only route needing no token. */
export interface CcSwitchHealth {
  name: string;
  version: string;
  /** App ids this server manages, for example `pi`, `codex`. */
  apps: string[];
}

/** One provider configuration, as the list shows it. */
export interface CcSwitchProvider {
  id: string;
  name: string;
  current: boolean;
  notes?: string | null;
  website_url?: string | null;
  sortIndex?: number | null;
}

/** A provider with its settings, secrets masked by the server as `***`. */
export interface CcSwitchProviderDetail extends CcSwitchProvider {
  settingsConfig?: unknown;
}

/** One prompt preset. */
export interface CcSwitchPrompt {
  id: string;
  name: string;
  description?: string | null;
  content?: string;
  enabled?: boolean;
}

export function loadCcSwitchSettings(): CcSwitchSettings | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    const address = typeof record.address === "string" ? record.address.trim() : "";
    const token = typeof record.token === "string" ? record.token : "";
    if (!address) return null;
    return { address, token };
  } catch {
    return null;
  }
}

/** Stores the settings, or clears them when given null. */
export function saveCcSwitchSettings(settings: CcSwitchSettings | null): boolean {
  try {
    if (!settings || !settings.address.trim()) {
      window.localStorage.removeItem(STORAGE_KEY);
      return true;
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    return true;
  } catch {
    return false;
  }
}

/** Coarse label for an app id; the server reports ids, not display names. */
export function appLabel(app: string): string {
  const known: Record<string, string> = {
    claude: "Claude Code",
    codex: "Codex",
    gemini: "Gemini",
    opencode: "OpenCode",
    hermes: "Hermes",
    openclaw: "OpenClaw",
    pi: "Pi",
    grokbuild: "Grok Build",
    zcode: "ZCode",
  };
  return known[app] ?? app;
}

function errorText(body: unknown, status: number): string {
  if (typeof body === "object" && body !== null) {
    const message = (body as { error?: unknown }).error;
    if (typeof message === "string" && message) return message;
  }
  return `HTTP ${status}`;
}

/**
 * One request, straight to cc-switch.
 *
 * The body is sent as JSON and the answer is returned as parsed JSON; cc-switch
 * reports failures as `{"error": "…"}`, and that message is the one worth
 * showing — a bare status code says nothing about which provider id was wrong.
 *
 * A transport failure is reported as a cross-origin refusal until proven
 * otherwise, because that is what it almost always is: an address that the
 * browser cannot reach, or a server that answers no CORS headers. The browser
 * gives no more detail than "failed to fetch", so the hint is the only useful
 * thing that can be said about it.
 */
async function call<T>(
  settings: CcSwitchSettings,
  path: string,
  init?: { method?: string; body?: unknown; unreachableMessage?: string },
): Promise<T> {
  const method = init?.method ?? "GET";
  let response: Response;
  try {
    response = await fetch(`${ccswitchBase(settings.address)}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${settings.token}`,
        ...(init?.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  } catch {
    // The browser says only "failed to fetch"; the caller knows whether the
    // usual CORS hint is the right suspicion for this route or something else is.
    throw new Error(
      init?.unreachableMessage ??
        `无法访问 ${settings.address}：浏览器拿不到它的响应。请确认该地址能从这台浏览器直接打开，并且 cc-switch 已开启 CORS（5.10.20 起支持）。`,
    );
  }

  const text = await response.text();
  let parsed: unknown = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
  }
  if (!response.ok) throw new Error(errorText(parsed, response.status));
  return parsed as T;
}

/** Whether the address and token reach a cc-switch server, and which apps it has. */
export async function ccswitchHealth(settings: CcSwitchSettings): Promise<CcSwitchHealth> {
  return call<CcSwitchHealth>(settings, "/api/health");
}

/** Every provider of one app, with the id of the one in use. */
export async function ccswitchProviders(
  settings: CcSwitchSettings,
  app: string,
): Promise<{ current?: string; providers: CcSwitchProvider[] }> {
  const result = await call<{ current?: string; providers?: CcSwitchProvider[] }>(
    settings,
    `/api/apps/${encodeURIComponent(app)}/providers`,
  );
  return { current: result?.current, providers: result?.providers ?? [] };
}

/** One provider's settings, secrets masked. */
export async function ccswitchProvider(
  settings: CcSwitchSettings,
  app: string,
  id: string,
): Promise<CcSwitchProviderDetail> {
  return call<CcSwitchProviderDetail>(
    settings,
    `/api/apps/${encodeURIComponent(app)}/providers/${encodeURIComponent(id)}`,
  );
}

/**
 * Switches the app to this provider.
 *
 * This writes the app's live configuration, so it takes effect the next time that
 * agent starts — a running agent has already read its settings.
 */
export async function ccswitchSwitch(
  settings: CcSwitchSettings,
  app: string,
  id: string,
): Promise<void> {
  await call<unknown>(settings, `/api/apps/${encodeURIComponent(app)}/providers/${encodeURIComponent(id)}/switch`, {
    method: "POST",
  });
}

/** The shape of a create or update request, as the panel builds it. */
export interface CcSwitchProviderDraft {
  /** Required when creating on an app whose providers are additive. */
  id?: string;
  name: string;
  notes?: string;
  websiteUrl?: string;
  /**
   * The app-specific settings document.
   *
   * It arrives masked — every secret reads `***` — and this API writes back what
   * it is given, so a document that still contains `***` would replace the real
   * secret with that literal. Callers must send a real value or omit the field.
   */
  settingsConfig?: unknown;
}

/** Apps whose provider ids are the reader's to choose; the rest get a UUID. */
export const ADDITIVE_APPS = ["opencode", "hermes", "openclaw", "pi", "grokbuild", "zcode"];

/** True when creating a provider for this app needs an id. */
export function needsProviderId(app: string): boolean {
  return ADDITIVE_APPS.includes(app);
}

/** Creates one provider and returns the id the server settled on. */
export async function ccswitchCreateProvider(
  settings: CcSwitchSettings,
  app: string,
  draft: CcSwitchProviderDraft,
): Promise<string | null> {
  const response = await call<{ id?: string }>(settings, `/api/apps/${encodeURIComponent(app)}/providers`, {
    method: "POST",
    body: {
      name: draft.name,
      ...(draft.id ? { id: draft.id } : {}),
      ...(draft.notes ? { notes: draft.notes } : {}),
      ...(draft.websiteUrl ? { websiteUrl: draft.websiteUrl } : {}),
      ...(draft.settingsConfig === undefined ? {} : { settingsConfig: draft.settingsConfig }),
    },
  });
  return typeof response?.id === "string" ? response.id : null;
}

/**
 * Updates one provider.
 *
 * Every field is optional, and omitting `settingsConfig` leaves the stored
 * settings — including their secrets — exactly as they were. That is the safe
 * path for a rename, and the reason the field is only sent when it changed.
 */
export async function ccswitchUpdateProvider(
  settings: CcSwitchSettings,
  app: string,
  id: string,
  draft: CcSwitchProviderDraft,
): Promise<void> {
  await call<unknown>(
    settings,
    `/api/apps/${encodeURIComponent(app)}/providers/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      body: {
        ...(draft.name ? { name: draft.name } : {}),
        ...(draft.notes === undefined ? {} : { notes: draft.notes }),
        ...(draft.websiteUrl === undefined ? {} : { websiteUrl: draft.websiteUrl }),
        ...(draft.settingsConfig === undefined ? {} : { settingsConfig: draft.settingsConfig }),
      },
    },
  );
}

/** Deletes one provider. The server refuses while it is the one in use. */
export async function ccswitchDeleteProvider(
  settings: CcSwitchSettings,
  app: string,
  id: string,
): Promise<void> {
  await call<unknown>(
    settings,
    `/api/apps/${encodeURIComponent(app)}/providers/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
}

/** The app's prompt presets, and which of them are active. */
export async function ccswitchPrompts(
  settings: CcSwitchSettings,
  app: string,
): Promise<{ active: string[]; prompts: CcSwitchPrompt[] }> {
  const result = await call<{ active?: string[]; prompts?: CcSwitchPrompt[] }>(
    settings,
    `/api/apps/${encodeURIComponent(app)}/prompts`,
  );
  return { active: result?.active ?? [], prompts: result?.prompts ?? [] };
}

/** Writes this preset into the app's live prompt file. */
export async function ccswitchActivatePrompt(
  settings: CcSwitchSettings,
  app: string,
  id: string,
): Promise<void> {
  await call<unknown>(
    settings,
    `/api/apps/${encodeURIComponent(app)}/prompts/${encodeURIComponent(id)}/activate`,
    { method: "POST" },
  );
}

/** Creates one prompt preset; the id is derived from the name when omitted. */
export async function ccswitchCreatePrompt(
  settings: CcSwitchSettings,
  app: string,
  draft: { name: string; content: string; description?: string },
): Promise<string | null> {
  const response = await call<{ id?: string }>(settings, `/api/apps/${encodeURIComponent(app)}/prompts`, {
    method: "POST",
    body: {
      name: draft.name,
      content: draft.content,
      ...(draft.description === undefined ? {} : { description: draft.description }),
    },
  });
  return typeof response?.id === "string" ? response.id : null;
}

/**
 * Updates one preset's stored record.
 *
 * The live prompt file is untouched by this call: an enabled preset has to be
 * activated again for its new content to reach the file the agent actually
 * reads, which is why the editor re-activates after saving an enabled preset.
 */
export async function ccswitchUpdatePrompt(
  settings: CcSwitchSettings,
  app: string,
  id: string,
  draft: { name: string; content: string; description?: string },
): Promise<void> {
  await call<unknown>(
    settings,
    `/api/apps/${encodeURIComponent(app)}/prompts/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      body: {
        name: draft.name,
        content: draft.content,
        ...(draft.description === undefined ? {} : { description: draft.description }),
      },
    },
  );
}

/** Deletes one preset. The server refuses presets that are enabled. */
export async function ccswitchDeletePrompt(
  settings: CcSwitchSettings,
  app: string,
  id: string,
): Promise<void> {
  await call<unknown>(
    settings,
    `/api/apps/${encodeURIComponent(app)}/prompts/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
}

/*
 * The global prompt preamble: one preset of the library, and the state that
 * says which (if any) is rendered into every app's live prompt file.
 *
 * It is not per-app — a preset activated here rewrites the live files of every
 * agent cc-switch knows — so the panel treats activation as the wide-reaching
 * action it is.
 */
export interface CcSwitchCommonPreset {
  id: string;
  name: string;
  content: string;
}

export interface CcSwitchCommonState {
  presets: CcSwitchCommonPreset[];
  /** The preset currently rendered into every app, when one is. */
  activeId: string | null;
}

/** What a write to the preamble library reports. */
export interface CcSwitchCommonWrite {
  /** Files rewritten by this call — every app's live prompt file when active. */
  repainted?: number;
}

/** The preamble library and which preset is active. */
export async function ccswitchCommon(settings: CcSwitchSettings): Promise<CcSwitchCommonState> {
  const response = await call<{ presets?: unknown; active_id?: unknown }>(
    settings,
    "/api/prompts/common",
  );
  const presets: CcSwitchCommonPreset[] = [];
  if (Array.isArray(response?.presets)) {
    for (const entry of response.presets) {
      if (!entry || typeof entry !== "object") continue;
      const raw = entry as Record<string, unknown>;
      if (typeof raw.id !== "string" || !raw.id) continue;
      presets.push({
        id: raw.id,
        name: typeof raw.name === "string" && raw.name ? raw.name : raw.id,
        content: typeof raw.content === "string" ? raw.content : "",
      });
    }
  }
  return {
    presets,
    activeId: typeof response?.active_id === "string" ? response.active_id : null,
  };
}

/** Creates or replaces one preset (no file is touched unless it is active). */
export async function ccswitchCommonCreate(
  settings: CcSwitchSettings,
  draft: { id: string; name: string; content: string },
): Promise<{ id: string; updated: boolean }> {
  return call<{ id: string; updated: boolean }>(settings, "/api/prompts/common", {
    method: "POST",
    body: { id: draft.id, name: draft.name, content: draft.content },
  });
}

/** Updates one preset's name/content. Active presets are re-rendered. */
export async function ccswitchCommonUpdate(
  settings: CcSwitchSettings,
  id: string,
  draft: { name: string; content: string },
): Promise<{ active: boolean }> {
  return call<{ active: boolean }>(
    settings,
    `/api/prompts/common/${encodeURIComponent(id)}`,
    { method: "PATCH", body: { name: draft.name, content: draft.content } },
  );
}

/** Deletes one preset; the server deactivates it first when it is active. */
export async function ccswitchCommonDelete(settings: CcSwitchSettings, id: string): Promise<void> {
  await call<unknown>(settings, `/api/prompts/common/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

/** Activates one preset and repaints every app's live prompt file. */
export async function ccswitchCommonUse(
  settings: CcSwitchSettings,
  id: string,
): Promise<CcSwitchCommonWrite> {
  return call<CcSwitchCommonWrite>(
    settings,
    `/api/prompts/common/${encodeURIComponent(id)}/use`,
    { method: "POST" },
  );
}

/** Deactivates the preamble and strips its marker sections from every file. */
export async function ccswitchCommonOff(settings: CcSwitchSettings): Promise<CcSwitchCommonWrite> {
  return call<CcSwitchCommonWrite>(settings, "/api/prompts/common/off", { method: "POST" });
}

/** Re-renders the active preamble into every existing live prompt file. */
export async function ccswitchCommonReapply(
  settings: CcSwitchSettings,
): Promise<CcSwitchCommonWrite> {
  return call<CcSwitchCommonWrite>(settings, "/api/prompts/common/reapply", { method: "POST" });
}

/** What an import from the live config reports. */
export interface CcSwitchImportResult {
  added?: number;
  updated?: number;
  pruned?: number;
}

/**
 * Adopts what the live config holds into the database.
 *
 * `update` overwrites entries that exist on both sides, and `prune` also drops
 * managed entries the live config no longer has; cc-switch supports both only
 * for pi, and refuses them elsewhere rather than ignoring them.
 */
export async function ccswitchImportLive(
  settings: CcSwitchSettings,
  app: string,
  options: { update?: boolean; prune?: boolean } = {},
): Promise<CcSwitchImportResult> {
  return call<CcSwitchImportResult>(
    settings,
    `/api/apps/${encodeURIComponent(app)}/providers/import-live`,
    { method: "POST", body: { update: options.update === true, prune: options.prune === true } },
  );
}

/** What a sync trigger answers with: the outcome it chose, and one line on it. */
export interface CcSwitchSyncResult {
  /** `Upload` / `Download` / `V1MigrationNeeded`, as the server debug-prints it. */
  decision?: string;
  /** One line, currently English, e.g. "WebDAV upload completed". */
  message?: string;
}

/*
 * The wording for a sync call that dies at the network layer. These are also the
 * two routes whose older builds crash the whole server on the way in — the
 * process takes the connection down with it — so the crash is the first thing
 * to suspect, not CORS.
 */
const SYNC_UNREACHABLE =
  "连接在调用中途断开：cc-switch 可能在这次调用中崩溃（旧版本同步接口的已知缺陷），也可能是地址不可达。服务通常几秒内自动重启，稍后可重试。";

/**
 * Uploads one snapshot — the whole database plus the skills tree, so every
 * app's providers, prompts, MCP servers, skills and settings — to the
 * configured WebDAV remote.
 */
export async function ccswitchWebdavUpload(settings: CcSwitchSettings): Promise<CcSwitchSyncResult> {
  return call<CcSwitchSyncResult>(settings, "/api/sync/webdav/upload", {
    method: "POST",
    unreachableMessage: SYNC_UNREACHABLE,
  });
}

/**
 * Applies the remote snapshot here: the database is replaced and every current
 * provider is replayed into its live config. There is no preview — after this
 * call, this machine runs what the remote held.
 */
export async function ccswitchWebdavDownload(settings: CcSwitchSettings): Promise<CcSwitchSyncResult> {
  return call<CcSwitchSyncResult>(settings, "/api/sync/webdav/download", {
    method: "POST",
    unreachableMessage: SYNC_UNREACHABLE,
  });
}

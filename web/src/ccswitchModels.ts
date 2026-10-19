/*
 * The provider's model list, fetched from its endpoint and filled in from the
 * models.dev catalog — the flow the CLI performs at a terminal, brought onto
 * the tool page.
 *
 * The catalog is fetched live, each time, straight from models.dev: it answers
 * to any origin, and a live read means a brand-new model is matchable the
 * moment models.dev knows it, with no cache to remember to refresh. Nothing is
 * stored — 4.6 MB has no business in localStorage, and the reader's browser
 * should not be quietly keeping a second copy of a catalog the site owns.
 *
 * The matching itself is a port of cc-switch's own (services/models_dev.rs), so
 * the two agree on what counts as a match: normalization strips vendor
 * prefixes and dated release suffixes, a prefix-ratio score decides, and
 * anything under 800/1000 is left for a human to pick.
 */

/* ---- fetching the provider's model ids ---- */

/** Proxy-style path suffixes whose root also serves an OpenAI-compatible API. */
const KNOWN_COMPAT_SUFFIXES = [
  "/api/claudecode",
  "/api/anthropic",
  "/apps/anthropic",
  "/api/coding",
  "/claudecode",
  "/anthropic",
  "/step_plan",
  "/coding",
  "/claude",
];

function stripCompatSuffix(base: string): string | null {
  const lower = base.toLowerCase();
  for (const suffix of KNOWN_COMPAT_SUFFIXES) {
    if (lower.endsWith(suffix)) return base.slice(0, base.length - suffix.length);
  }
  return null;
}

/** Every endpoint a provider's model list could plausibly live at, best first. */
export function buildModelCandidateUrls(baseUrl: string): string[] {
  const base = baseUrl.trim().replace(/\/+$/, "");
  if (!base) return [];
  if (base.endsWith("/models")) return [base];

  const appendModels = `${base}/models`;
  const versioned = base.endsWith("/v1") || base.endsWith("/v1beta") ? null : `${base}/v1/models`;
  const urls: string[] = [];
  const stripped = stripCompatSuffix(base);
  if (stripped !== null) {
    urls.push(versioned ?? appendModels);
    const root = stripped.replace(/\/+$/, "");
    if (root.includes("://")) {
      urls.push(`${root}/v1/models`, `${root}/models`);
    }
  } else {
    urls.push(appendModels);
    if (versioned) urls.push(versioned);
  }
  return [...new Set(urls)];
}

/**
 * The model ids in a `/models` response, whichever of the three shapes it takes:
 * OpenAI's `{"data":[{"id":…}]}`, Gemini's `{"models":[{"name":"models/…"}]}`,
 * or a bare array of `{"id":…}`.
 */
export function parseModelIds(json: unknown): string[] {
  const ids: string[] = [];
  const push = (value: unknown) => {
    if (typeof value === "string" && value.trim()) ids.push(value.trim());
  };
  if (Array.isArray((json as { data?: unknown })?.data)) {
    for (const item of (json as { data: unknown[] }).data) {
      push((item as { id?: unknown })?.id);
    }
    if (ids.length > 0) return ids;
  }
  if (Array.isArray((json as { models?: unknown })?.models)) {
    for (const item of (json as { models: unknown[] }).models) {
      const name = (item as { name?: unknown })?.name;
      if (typeof name === "string") push(name.replace(/^models\//, ""));
    }
    if (ids.length > 0) return ids;
  }
  if (Array.isArray(json)) {
    for (const item of json) push((item as { id?: unknown })?.id);
  }
  return ids;
}

/**
 * The provider's model ids, straight from the browser.
 *
 * Both credential headers ride along — the OpenAI `Bearer` and the Anthropic
 * `x-api-key` — because a relay accepts one of them and asking which would be
 * a question the reader cannot answer. A candidate that fails is tried next;
 * only when every candidate fails is this an error.
 */
export async function fetchProviderModels(baseUrl: string, apiKey: string): Promise<string[]> {
  const candidates = buildModelCandidateUrls(baseUrl);
  if (candidates.length === 0) throw new Error("Base URL 是空的。");
  const headers: Record<string, string> = {};
  if (apiKey.trim()) {
    headers.Authorization = `Bearer ${apiKey.trim()}`;
    headers["x-api-key"] = apiKey.trim();
  }
  const failures: string[] = [];
  for (const url of candidates) {
    try {
      const response = await fetch(url, { headers });
      if (!response.ok) {
        failures.push(`${url} → HTTP ${response.status}`);
        continue;
      }
      const ids = parseModelIds(await response.json());
      if (ids.length > 0) return ids;
      failures.push(`${url} → 空`);
    } catch (err) {
      failures.push(`${url} → ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(`端点不可达（已依次尝试 ${candidates.length} 个候选地址）。浏览器直连要求该站点允许跨域；若被拦，请先把渠道保存，或在 JSON 里手填。\n  ${failures.join("\n  ")}`);
}

/* ---- the models.dev catalog ---- */

export const MODELS_DEV_URL = "https://models.dev/api.json";

/** One catalog model, carrying only the fields an entry gets filled from. */
export interface CatalogEntry {
  id: string;
  name?: string;
  reasoning?: boolean;
  toolCall?: boolean;
  attachment?: boolean;
  context?: number;
  inputLimit?: number;
  output?: number;
  inputModalities: string[];
}

interface RawLimit {
  context?: unknown;
  input?: unknown;
  output?: unknown;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/**
 * The whole catalog, live from models.dev, flattened to one entry per model.
 *
 * Flattening keeps the 4.6 MB answer from being walked more than once: every
 * later match runs against this flat list.
 */
export async function fetchModelsDevCatalog(): Promise<CatalogEntry[]> {
  const response = await fetch(MODELS_DEV_URL);
  if (!response.ok) throw new Error(`models.dev 返回 HTTP ${response.status}`);
  const root: unknown = await response.json();
  const out: CatalogEntry[] = [];
  if (typeof root !== "object" || root === null) return out;
  for (const provider of Object.values(root as Record<string, unknown>)) {
    const models = (provider as { models?: unknown })?.models;
    if (typeof models !== "object" || models === null) continue;
    for (const [key, raw] of Object.entries(models as Record<string, unknown>)) {
      const model = raw as {
        name?: unknown;
        reasoning?: unknown;
        tool_call?: unknown;
        attachment?: unknown;
        modalities?: { input?: unknown };
        limit?: RawLimit;
      };
      const modalities = Array.isArray(model?.modalities?.input)
        ? model.modalities.input.filter((m): m is string => typeof m === "string")
        : [];
      out.push({
        id: key,
        name: typeof model?.name === "string" ? model.name : undefined,
        reasoning: asBoolean(model?.reasoning),
        toolCall: asBoolean(model?.tool_call),
        attachment: asBoolean(model?.attachment),
        context: asNumber(model?.limit?.context),
        inputLimit: asNumber(model?.limit?.input),
        output: asNumber(model?.limit?.output),
        inputModalities: modalities,
      });
    }
  }
  return out;
}

/* ---- matching, as cc-switch's Rust does it ---- */

const VENDOR_SLASH_PREFIXES = [
  "openai/",
  "anthropic/",
  "google/",
  "meta/",
  "mistral/",
  "deepseek/",
  "xai/",
  "amazon-bedrock/",
  "bedrock/",
];
const VENDOR_DOT_PREFIXES = ["openai.", "anthropic.", "google."];

/** Lower-cased and stripped of the vendor prefixes catalogs are filed under. */
export function normalizeModelId(id: string): string {
  let s = id.trim().toLowerCase();
  for (const prefix of VENDOR_SLASH_PREFIXES) {
    if (s.startsWith(prefix)) {
      s = s.slice(prefix.length);
      break;
    }
  }
  for (const prefix of VENDOR_DOT_PREFIXES) {
    if (s.startsWith(prefix)) {
      s = s.slice(prefix.length);
      break;
    }
  }
  return s;
}

/** `YYYYMMDD` or `YYYY-MM-DD`. */
function isDateLike(value: string): boolean {
  if (/^\d{8}$/.test(value)) return true;
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/**
 * Trailing release markers — `-2026-01-15`, `-20260115`, `@2026-01-15`,
 * `:latest` — come off, so the dated snapshot and the model it snapshots
 * compare equal.
 */
export function stripReleaseSuffix(id: string): string {
  let s = id.trim();
  if (s.endsWith(":latest")) s = s.slice(0, -":latest".length);
  for (let index = 0; index < s.length; index += 1) {
    if (s[index] !== "-" && s[index] !== "@") continue;
    const head = s.slice(0, index);
    const tail = s.slice(index + 1);
    if (!head) continue;
    if (isDateLike(tail.replace(/^[-@]+/, ""))) {
      s = head;
      break;
    }
  }
  return s;
}

function fuzzyKey(id: string): string {
  return stripReleaseSuffix(normalizeModelId(id));
}

/**
 * Similarity in `0..=1000`: an exact key wins outright, otherwise a shared
 * prefix ratio carries the score with containment as a weak bonus — enough for
 * `gpt5.4` to prefer `gpt-5.4` over `gpt-5.4-mini`, not enough to confuse
 * unrelated families.
 */
export function similarityScore(query: string, candidate: string): number {
  if (query === candidate) return 1000;
  if (!query || !candidate) return 0;
  const a = [...query];
  const b = [...candidate];
  let shared = 0;
  while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared += 1;
  const prefixRatio = Math.floor((shared * 2 * 1000) / (a.length + b.length));
  const contains = candidate.includes(query) || query.includes(candidate) ? 200 : 0;
  return prefixRatio + contains;
}

/** Preferred context window: the catalog's `context`, else its input limit. */
export function contextLimit(entry: CatalogEntry): number | undefined {
  return entry.context ?? entry.inputLimit;
}

export interface RankedEntry {
  entry: CatalogEntry;
  score: number;
}

/** Every catalog entry against one upstream id, best first. */
export function rankCatalogEntries(catalog: readonly CatalogEntry[], upstreamId: string): RankedEntry[] {
  const needle = fuzzyKey(upstreamId);
  if (!needle) return [];
  const scored = catalog
    .map((entry) => ({
      entry,
      score: Math.max(
        similarityScore(needle, fuzzyKey(entry.id)),
        entry.name ? similarityScore(needle, fuzzyKey(entry.name)) : 0,
      ),
    }))
    .filter((item) => item.score > 0);
  scored.sort((x, y) =>
    y.score - x.score
    || (contextLimit(y.entry) ?? 0) - (contextLimit(x.entry) ?? 0)
    || (x.entry.id < y.entry.id ? -1 : x.entry.id > y.entry.id ? 1 : 0),
  );
  return scored;
}

/** Confidence at or above which a fuzzy hit is applied without asking. */
export const AUTO_MATCH_MIN_SCORE = 800;

/** The catalog fields an entry is filled from, in the shape the config takes. */
export function enrichedFields(entry: CatalogEntry): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (entry.name?.trim()) out.name = entry.name.trim();
  const context = contextLimit(entry);
  if (context !== undefined) out.contextWindow = context;
  if (entry.output !== undefined) out.maxTokens = entry.output;
  if (entry.reasoning !== undefined) out.reasoning = entry.reasoning;
  if (entry.toolCall !== undefined) out.toolCall = entry.toolCall;
  if (entry.attachment !== undefined) out.attachment = entry.attachment;
  /* Only text/image survive: the config's schema rejects pdf/audio/video. */
  const input = [...new Set(entry.inputModalities.filter((m) => m === "text" || m === "image"))];
  if (input.length > 0) out.input = input;
  return out;
}

/** How one upstream id was resolved against the catalog. */
export interface EnrichResult {
  id: string;
  matched: boolean;
  entry: Record<string, unknown>;
  /** Ranked catalog neighbours, offered for a manual pick when nothing matched. */
  candidates: CatalogEntry[];
}

/** Resolve one upstream id: auto-filled on a confident hit, id-only otherwise. */
export function enrichModelId(id: string, catalog: readonly CatalogEntry[]): EnrichResult {
  const trimmed = id.trim();
  const ranked = rankCatalogEntries(catalog, trimmed);
  const best = ranked[0];
  if (best && best.score >= AUTO_MATCH_MIN_SCORE) {
    return { id: trimmed, matched: true, entry: { id: trimmed, ...enrichedFields(best.entry) }, candidates: [] };
  }
  return {
    id: trimmed,
    matched: false,
    entry: { id: trimmed },
    candidates: ranked.slice(0, 20).map((item) => item.entry),
  };
}

/**
 * One enriched entry onto the models a config already holds.
 *
 * The id decides the row; catalog-known keys are overwritten and anything the
 * reader had added by hand survives — the same rule the CLI applies, so a
 * document this page writes and one the CLI writes stay interchangeable.
 */
export function mergeModelEntry(existing: unknown[], result: EnrichResult): unknown[] {
  const index = existing.findIndex(
    (item) => (item as { id?: unknown })?.id === result.id,
  );
  if (index === -1) return [...existing, result.entry];
  const previous = existing[index];
  const merged =
    typeof previous === "object" && previous !== null
      ? { ...(previous as Record<string, unknown>), ...result.entry }
      : result.entry;
  return [...existing.slice(0, index), merged, ...existing.slice(index + 1)];
}

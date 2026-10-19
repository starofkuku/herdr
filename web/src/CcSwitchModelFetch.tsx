/*
 * "Fetch the models this provider serves, and fill them in from models.dev."
 *
 * The button half of the CLI's shortcut, on the provider form: read the base
 * URL and key out of the settings document, list what the endpoint serves,
 * let the reader check off what they want, then enrich each chosen id against
 * a live models.dev read and merge the filled entries back into the document —
 * into the JSON editor, so a hand-edit is still possible before saving.
 *
 * Ids nothing matched are not dropped: they land as `{"id": …}` with their
 * nearest catalog neighbours one click away, because a relay's own naming can
 * be new before models.dev knows it.
 */

import { useMemo, useState } from "react";
import { CloudDownload, Loader2, Wand2 } from "lucide-react";
import { ccswitchFetchModels, type CcSwitchSettings } from "./ccswitch";
import {
  enrichedFields,
  enrichModelId,
  fetchModelsDevCatalog,
  fetchProviderModels,
  mergeModelEntry,
  type CatalogEntry,
} from "./ccswitchModels";

/** Where the connection facts live in a settings document, by common shape. */
function readEndpoint(settings: Record<string, unknown>): { baseUrl: string; apiKey: string } {
  const baseUrl = [settings.baseUrl, settings.base_url].find((v) => typeof v === "string") ?? "";
  const apiKey = [settings.apiKey, settings.api_key, settings.authToken].find((v) => typeof v === "string") ?? "";
  return { baseUrl: String(baseUrl), apiKey: String(apiKey) };
}

function summaryLine(auto: number, manual: number, unmatched: number): string {
  const parts = [`${auto} 个自动填充`];
  if (manual > 0) parts.push(`${manual} 个手动匹配`);
  parts.push(`${unmatched} 个未匹配（保留 id）`);
  return `已合并：${parts.join("，")}。`;
}

export function CcSwitchModelFetch({
  settings,
  onMerged,
  app,
  providerId,
  connection,
}: {
  /** The settings document as the JSON editor holds it. */
  settings: string;
  /** Receives the document with the merged models array, pretty-printed. */
  onMerged: (nextSettings: string) => void;
  /** The app whose providers these are. */
  app: string;
  /** The stored provider's id; null while creating one that does not exist yet. */
  providerId: string | null;
  /** How to reach cc-switch, for the server-side fetch. */
  connection: CcSwitchSettings | null;
}) {
  const [phase, setPhase] = useState<"idle" | "fetching" | "picking" | "merging">("idle");
  const [remoteIds, setRemoteIds] = useState<string[]>([]);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [note, setNote] = useState("");
  const [summary, setSummary] = useState<{ auto: number; manual: number; miss: number } | null>(null);
  const [unmatched, setUnmatched] = useState<Array<{ id: string; candidates: CatalogEntry[] }>>([]);

  let parsed: Record<string, unknown> | null = null;
  try {
    const value: unknown = JSON.parse(settings);
    parsed = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    parsed = null;
  }
  const endpoint = parsed ? readEndpoint(endpointSafe(parsed)) : { baseUrl: "", apiKey: "" };
  const masked = Object.values(parsed ?? {}).some((v) => v === "***") || settings.includes('"***"');

  /* The models the document already lists: what starts checked, and what the
   * list marks, so a reader can tell their own entries from the endpoint's
   * unfamiliar ones at a glance. */
  const existingIds = useMemo(() => {
    const models = parsed && Array.isArray(parsed.models) ? parsed.models : [];
    return new Set(
      models
        .map((item) => (item as { id?: unknown })?.id)
        .filter((id): id is string => typeof id === "string"),
    );
  }, [settings]);

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return needle ? remoteIds.filter((id) => id.toLowerCase().includes(needle)) : remoteIds;
  }, [remoteIds, filter]);

  const start = async () => {
    if (!parsed) {
      setNote("配置不是合法 JSON，无法读取 Base URL。");
      return;
    }
    if (!endpoint.baseUrl.trim()) {
      setNote("配置里没有 baseUrl，无法拉取。");
      return;
    }
    if (masked && !providerId) {
      setNote("配置里的密钥还是 *** 掩码：请先填入真实密钥再拉取。");
      return;
    }
    setPhase("fetching");
    setNote("");
    try {
      /*
       * A stored provider is asked for through cc-switch: the server holds its
       * key, so a masked document is no obstacle and no cross-origin rule
       * applies. One being created is not there yet, so its own endpoint is
       * called directly from the page — which the provider must allow.
       */
      const ids =
        providerId && connection
          ? await ccswitchFetchModels(connection, app, providerId)
          : await fetchProviderModels(endpoint.baseUrl, endpoint.apiKey);
      setRemoteIds(ids);
      /* Only what the document already lists starts checked: a fetch must not
       * quietly turn nine advertised models into nine configured ones. */
      setChecked(new Set(ids.filter((id) => existingIds.has(id))));
      setFilter("");
      setPhase("picking");
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
      setPhase("idle");
    }
  };

  const merge = async () => {
    if (!parsed) return;
    setPhase("merging");
    setNote("");
    try {
      const catalog = await fetchModelsDevCatalog();
      const chosen = remoteIds.filter((id) => checked.has(id));
      /* The list grows as entries merge — reading it fresh each time is the
       * difference between merging ten models and keeping only the last. */
      let models = Array.isArray(parsed.models) ? parsed.models : [];
      let auto = 0;
      let miss = 0;
      const misses: Array<{ id: string; candidates: CatalogEntry[] }> = [];
      for (const id of chosen) {
        const result = enrichModelId(id, catalog);
        if (result.matched) auto += 1;
        else {
          miss += 1;
          if (result.candidates.length > 0) misses.push({ id, candidates: result.candidates });
        }
        models = mergeModelEntry(models, result);
      }
      parsed.models = models;
      onMerged(JSON.stringify(parsed, null, 2));
      setSummary({ auto, manual: 0, miss });
      setUnmatched(misses);
      setPhase("idle");
      setRemoteIds([]);
      setChecked(new Set());
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
      setPhase("idle");
    }
  };

  const pickManual = (id: string, entry: CatalogEntry) => {
    if (!parsed) return;
    const models = Array.isArray(parsed.models) ? parsed.models : [];
    parsed.models = mergeModelEntry(models, {
      id,
      matched: true,
      entry: { id, ...enrichedFields(entry) },
      candidates: [],
    });
    onMerged(JSON.stringify(parsed, null, 2));
    setUnmatched((current) => current.filter((item) => item.id !== id));
    setSummary((current) => (current ? { ...current, manual: current.manual + 1, miss: current.miss - 1 } : current));
  };

  if (!parsed || !endpoint.baseUrl) return null;

  const busy = phase === "fetching" || phase === "merging";
  return (
    <div className="ccswitch-modelfetch">
      <div className="ccswitch-modelfetch__row">
        <button type="button" className="ghost" onClick={() => void start()} disabled={busy}>
          {phase === "fetching" ? <Loader2 size={14} className="spin" aria-hidden="true" /> : <CloudDownload size={14} aria-hidden="true" />}
          {phase === "fetching" ? "拉取中…" : "从端点获取模型"}
        </button>
        <span className="ccswitch-modelfetch__hint">
          {providerId && connection
            ? "经 cc-switch 服务端拉取（密钥用库里已存的，无需重填）→ 勾选 → 按 models.dev 填充并合并"
            : "浏览器直连该端点拉取（需站点允许跨域）→ 勾选 → 按 models.dev 填充并合并"}
        </span>
      </div>

      {phase === "picking" || phase === "merging" ? (
        <div className="ccswitch-modelfetch__picker">
          <p className="ccswitch-modelfetch__rule">
            默认只勾上配置里已有的（标「已有」）；勾中的会按目录重写参数，未勾中的不动。
          </p>
          <div className="ccswitch-modelfetch__bar">
            <input
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="过滤模型 id…"
              spellCheck={false}
            />
            <span className="ccswitch-modelfetch__count">
              已选 {checked.size}/{remoteIds.length} · 已有 {existingIds.size}
            </span>
            <button type="button" className="ghost" onClick={() => setChecked(new Set(remoteIds))}>
              全选
            </button>
            <button
              type="button"
              className="ghost"
              title="只勾上配置里还没有的，用来补新模型"
              onClick={() => setChecked(new Set(remoteIds.filter((id) => !existingIds.has(id))))}
            >
              选中新增
            </button>
            <button type="button" className="ghost" onClick={() => setChecked(new Set())}>
              清空
            </button>
          </div>
          <ul className="ccswitch-modelfetch__list">
            {shown.map((id) => (
              <li key={id}>
                <label>
                  <input
                    type="checkbox"
                    checked={checked.has(id)}
                    onChange={(event) => {
                      const next = new Set(checked);
                      if (event.target.checked) next.add(id);
                      else next.delete(id);
                      setChecked(next);
                    }}
                  />
                  <span>{id}</span>
                  {existingIds.has(id) ? (
                    <span className="ccswitch-modelfetch__tag">已有</span>
                  ) : null}
                </label>
              </li>
            ))}
          </ul>
          <div className="ccswitch-modelfetch__actions">
            <button type="button" className="ghost" onClick={() => setPhase("idle")}>
              取消
            </button>
            <button
              type="button"
              className="agent-primary-button"
              disabled={checked.size === 0 || phase === "merging"}
              onClick={() => void merge()}
            >
              {phase === "merging" ? "填充中…" : `合并 ${checked.size} 个模型`}
            </button>
          </div>
        </div>
      ) : null}

      {summary ? (
        <p className="ccswitch-modelfetch__note" role="status">
          {summaryLine(summary.auto, summary.manual, summary.miss)}
        </p>
      ) : null}

      {note ? (
        <p className="ccswitch-modelfetch__note error" role="alert">
          {note}
        </p>
      ) : null}

      {unmatched.length > 0 ? (
        <div className="ccswitch-modelfetch__unmatched">
          <p className="ccswitch-modelfetch__unmatched-head">
            <Wand2 size={13} aria-hidden="true" /> 未匹配的模型（可手选目录条目，或保持 id-only）
          </p>
          {unmatched.map((item) => (
            <div className="ccswitch-modelfetch__pickrow" key={item.id}>
              <span className="ccswitch-modelfetch__pickid">{item.id}</span>
              <select
                value=""
                onChange={(event) => {
                  const found = item.candidates.find((entry) => entry.id === event.target.value);
                  if (found) pickManual(item.id, found);
                }}
                aria-label={`为 ${item.id} 手动选择目录条目`}
              >
                <option value="">选择匹配…</option>
                {item.candidates.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.id}
                    {entry.name ? ` · ${entry.name}` : ""}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* The settings may carry the endpoint nested; read it shallowly and safely. */
function endpointSafe(parsed: Record<string, unknown>): Record<string, unknown> {
  for (const key of ["auth", "config", "settings"]) {
    const nested = parsed[key];
    if (typeof nested === "object" && nested !== null && !Array.isArray(nested)) {
      const merged = { ...parsed, ...(nested as Record<string, unknown>) };
      return merged;
    }
  }
  return parsed;
}


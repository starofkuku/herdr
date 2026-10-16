/*
 * The few fields of a provider's settings worth showing above the rest.
 *
 * Each app keeps provider settings its own way — pi has `baseUrl`/`apiKey`,
 * Codex has `auth`/`config`, Claude has an `env` of `ANTHROPIC_*` variables — so
 * the labels come from the key names rather than from a per-app schema, and the
 * whole document is shown beside them for the rest. Secrets arrive masked as
 * `***`; nothing here can unmask them.
 */

import type { CcSwitchProviderDetail } from "./ccswitch";

export function settingsSummary(detail: CcSwitchProviderDetail): [string, string][] {
  const config = detail.settingsConfig;
  if (typeof config !== "object" || config === null) return [];
  const record = config as Record<string, unknown>;
  const rows: [string, string][] = [];
  const seen = new Set<string>();

  const add = (label: string, value: string) => {
    if (!value || seen.has(label)) return;
    seen.add(label);
    rows.push([label, value]);
  };

  const walk = (value: unknown, depth: number) => {
    if (depth > 2 || typeof value !== "object" || value === null) return;
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const name = key.toLowerCase();
      if (typeof entry === "string") {
        if (/base_?url$|_base_?url$|^url$/.test(name)) add("地址", entry);
        else if (/token$|api_?key$|auth_?token$|key$/.test(name) && !/^model/.test(name)) {
          add("密钥", entry);
        } else if (/(^|_)model$/.test(name)) add("模型", entry);
      } else if (Array.isArray(entry)) {
        if (name === "models") add("模型数", String(entry.length));
      } else if (typeof entry === "object" && entry !== null) {
        walk(entry, depth + 1);
      }
    }
  };
  walk(record, 0);
  if (record.auth !== undefined && rows.length === 0) add("认证", "已配置");
  return rows;
}

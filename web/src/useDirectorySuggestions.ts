import { useEffect, useMemo, useState } from "react";
import type { GatewayClient } from "./gateway";
import { managementError, type DirectoryPage } from "./agentManagement";

type CachedDirectory = { expires: number; result: Promise<DirectoryPage> };
const cache = new WeakMap<GatewayClient, Map<string, CachedDirectory>>();

function readDirectory(client: GatewayClient, path: string) {
  let entries = cache.get(client);
  if (!entries) { entries = new Map(); cache.set(client, entries); }
  const existing = entries.get(path);
  if (existing && existing.expires > Date.now()) return existing.result;
  const result = client.call<DirectoryPage>("directories.list", { path });
  entries.set(path, { expires: Date.now() + 30_000, result });
  if (entries.size > 20) entries.delete(entries.keys().next().value!);
  void result.catch(() => { if (entries.get(path)?.result === result) entries.delete(path); });
  return result;
}

function directoryQuery(value: string) {
  if (value === "~") return { parent: "~", prefix: "" };
  if (!/^(\/|~\/|[a-z]:[\\/]|\\\\)/i.test(value)) return null;
  const end = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
  if (end < 0) return null;
  return { parent: value.slice(0, end + 1), prefix: value.slice(end + 1).toLocaleLowerCase() };
}

export function useDirectorySuggestions(client: GatewayClient, value: string, active: boolean) {
  const query = directoryQuery(value);
  const parent = query?.parent;
  const [result, setResult] = useState<{
    client: GatewayClient; parent: string; page?: DirectoryPage; error?: string;
  }>();
  useEffect(() => {
    if (!active || !parent) return;
    let current = true;
    const timer = window.setTimeout(() => {
      void readDirectory(client, parent).then(page => {
        if (current) setResult({ client, parent, page });
      }).catch(error => { if (current) setResult({ client, parent, error: managementError(error) }); });
    }, 120);
    return () => { current = false; window.clearTimeout(timer); };
  }, [client, parent, active]);
  const current = active && result?.client === client && result.parent === parent ? result : undefined;
  const prefix = query?.prefix || "";
  const matches = useMemo(() => (current?.page?.directories || []).filter(directory =>
    directory.name.toLocaleLowerCase().startsWith(prefix)), [current?.page, prefix]);
  return { supported: !!query, loading: !!parent && !current, error: current?.error,
    matches: matches.slice(0, 50), truncated: matches.length > 50 };
}

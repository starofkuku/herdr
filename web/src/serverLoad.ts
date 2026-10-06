// The server's own cost, as reported by `server.load`.
//
// herdr's server answers this on the path that does not enter its main loop, so
// reading it never adds to the load it describes. The bar is supplementary: a
// server that cannot report, or a request that fails, hides the numbers rather
// than turning the conversation into an error.

/** One reading of the server process. */
export interface ServerLoad {
  pid: number;
  uptime_sec: number;
  /**
   * CPU as a percentage of one core, or null before two samples exist.
   *
   * Null is not zero: the server needs two readings spaced in time to give a
   * rate, so the first call after it starts cannot answer this.
   */
  cpu_percent: number | null;
  rss_bytes: number;
  threads: number;
  open_fds: number;
  subscriptions: number;
  api_connections: number;
  client_connections: number;
  api_queue: number;
  max_api_queue: number;
  client_queue: number;
  loops_per_sec: number;
  phase: string;
  phase_ms: number;
  slowest_api: string;
  slowest_api_ms: number;
}

/** The slice of the gateway client this module needs. */
interface LoadClient {
  call: <T>(method: string, params?: Record<string, unknown>) => Promise<T>;
}

/** How often the bar re-asks. Two seconds is enough for a cost display. */
export const SERVER_LOAD_POLL_MS = 2000;

/**
 * Reads the server's load.
 *
 * A failure rejects: unlike the todo panel, a bar that silently kept showing a
 * stale number would be worse than one that says it is unavailable.
 */
export async function loadServerLoad(client: LoadClient): Promise<ServerLoad> {
  const response = await client.call<unknown>("server.load", {});
  const parsed = parseServerLoad(response);
  if (!parsed) throw new Error("server.load returned an unusable reading");
  return parsed;
}

function number(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Keeps a reading only when it has the fields the bar draws.
 *
 * The server sends this shape itself, so a mismatch means an older server that
 * does not implement the method. Rejecting is what makes that visible.
 */
export function parseServerLoad(value: unknown): ServerLoad | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.pid !== "number") return null;
  return {
    pid: raw.pid,
    uptime_sec: number(raw.uptime_sec, 0),
    cpu_percent: optionalNumber(raw.cpu_percent),
    rss_bytes: number(raw.rss_bytes, 0),
    threads: number(raw.threads, 0),
    open_fds: number(raw.open_fds, 0),
    subscriptions: number(raw.subscriptions, 0),
    api_connections: number(raw.api_connections, 0),
    client_connections: number(raw.client_connections, 0),
    api_queue: number(raw.api_queue, 0),
    max_api_queue: number(raw.max_api_queue, 0),
    client_queue: number(raw.client_queue, 0),
    loops_per_sec: number(raw.loops_per_sec, 0),
    phase: typeof raw.phase === "string" ? raw.phase : "unknown",
    phase_ms: number(raw.phase_ms, 0),
    slowest_api: typeof raw.slowest_api === "string" ? raw.slowest_api : "-",
    slowest_api_ms: number(raw.slowest_api_ms, 0),
  };
}

/** Bytes as a short human figure. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** An uptime as a short figure, coarsening as it grows. */
export function formatUptime(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return minutes ? `${hours}h${minutes}m` : `${hours}h`;
  }
  return `${Math.floor(seconds / 86400)}d`;
}

/** CPU as a short figure, keeping null distinct from idle. */
export function formatCpu(percent: number | null): string {
  if (percent === null) return "—";
  return percent < 10 ? `${percent.toFixed(1)}%` : `${Math.round(percent)}%`;
}

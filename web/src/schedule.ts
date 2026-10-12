/*
 * Prompts the server sends to a pane at a wall-clock time.
 *
 * The schedule is the server's to keep: it has to outlive the pane it talks to
 * and the browser that made it. Everything here is a thin layer over the
 * `schedule.*` API — the times arrive already resolved and formatted, because
 * the server is the one clock that matters.
 */

interface ScheduleClient {
  call: <T>(method: string, params?: Record<string, unknown>) => Promise<T>;
}

export type ScheduleStatus = "pending" | "fired" | "missed" | "cancelled";

/** One scheduled prompt, as the list shows it. */
export interface ScheduleEntry {
  id: string;
  /** The pane's public id as it was when the schedule was made. */
  paneId: string;
  agent: string | null;
  /** Local time, `YYYY-MM-DD HH:MM:SS`, already resolved by the server. */
  due: string;
  message: string;
  status: ScheduleStatus;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function asEntry(value: unknown): ScheduleEntry | null {
  const record = asRecord(value);
  if (!record) return null;
  const id = typeof record.id === "string" ? record.id : null;
  const paneId = typeof record.pane_id === "string" ? record.pane_id : null;
  const due = typeof record.due === "string" ? record.due : null;
  const message = typeof record.message === "string" ? record.message : null;
  const status = record.status;
  if (!id || !paneId || !due || !message) return null;
  if (status !== "pending" && status !== "fired" && status !== "missed" && status !== "cancelled") {
    return null;
  }
  return {
    id,
    paneId,
    agent: typeof record.agent === "string" ? record.agent : null,
    due,
    message,
    status,
  };
}

/** Every schedule, soonest first — the server orders the list. */
export async function listSchedules(client: ScheduleClient): Promise<ScheduleEntry[]> {
  const response = await client.call<{ schedules?: unknown }>("schedule.list");
  const schedules = Array.isArray(response?.schedules) ? response.schedules : [];
  return schedules.map(asEntry).filter((entry): entry is ScheduleEntry => entry !== null);
}

/**
 * Makes a schedule: at `at`, the server sends `message` to the pane.
 *
 * The server resolves the time (a full date, or a clock time for the next
 * occurrence) and the resolved moment comes back — the one worth showing.
 */
export async function createSchedule(
  client: ScheduleClient,
  paneId: string,
  at: string,
  message: string,
): Promise<ScheduleEntry | null> {
  const response = await client.call<{ schedule?: unknown }>("schedule.create", {
    pane_id: paneId,
    at,
    message,
  });
  return asEntry(response?.schedule);
}

/** Takes a pending schedule back. */
export async function cancelSchedule(
  client: ScheduleClient,
  id: string,
): Promise<ScheduleEntry | null> {
  const response = await client.call<{ schedule?: unknown }>("schedule.cancel", {
    schedule_id: id,
  });
  return asEntry(response?.schedule);
}

/** `HH:mm`/`HH:mm:ss` for the next occurrence, or a full date-time; the server parses either. */
export function scheduleTimeValue(input: string): string {
  return input.trim();
}

/** The status pill's word. */
export const STATUS_LABELS: Record<ScheduleStatus, string> = {
  pending: "等待中",
  fired: "已发送",
  missed: "已错过",
  cancelled: "已取消",
};

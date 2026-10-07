// The models a pane's agent can be switched to.
//
// herdr reads the list from the agent's own configuration rather than asking a
// running process, so what the menu offers is the same catalog the agent would
// accept. Not every agent keeps one: the response then carries an empty list and
// a reason, which is shown as a note rather than as a failure.

/** One model an agent can run. */
export interface AgentModel {
  /** The agent's own identifier, as its configuration spells it. */
  id: string;
  /**
   * The provider serving it.
   *
   * A model id is only unique within its provider — the same name appears under
   * several — so the two together are what identifies a choice.
   */
  provider: string;
  /** Human label, when the configuration carries one that says more than the id. */
  label?: string;
  /** Whether this is the model the pane is running now. */
  current: boolean;
  /**
   * The reasoning efforts this model accepts, in the agent's own order.
   *
   * Empty when the model does not reason — the effort control is simply not
   * offered for it, which is an answer rather than a failure.
   */
  efforts: string[];
}

/** The slice of the gateway client this module needs. */
interface ModelClient {
  call: <T>(method: string, params?: Record<string, unknown>) => Promise<T>;
}

/** The catalog for one pane, or the reason there is none. */
export interface AgentModelCatalog {
  models: AgentModel[];
  /** Why the list is empty, when the agent publishes no catalog herdr can read. */
  detail?: string;
  /** The reasoning effort in force, when the pane's record names one. */
  effort?: string;
}

/**
 * Reads the pane's model catalog.
 *
 * A transport failure rejects; a missing catalog resolves with a reason. The
 * second is an ordinary state for most agents and should not read as an error,
 * while the first means the question was never answered.
 */
export async function loadAgentModels(
  client: ModelClient,
  paneId: string,
): Promise<AgentModelCatalog> {
  const response = await client.call<{
    models?: { models?: unknown; detail?: unknown; effort?: unknown };
  }>("pane.models", { pane_id: paneId });
  const payload = response?.models;
  return {
    models: parseModels(payload?.models),
    detail: typeof payload?.detail === "string" ? payload.detail : undefined,
    effort: typeof payload?.effort === "string" ? payload.effort : undefined,
  };
}

/**
 * Keeps only entries usable as a choice.
 *
 * An `id` is what a choice is applied by, so a row without one is unusable. A
 * provider is not required: pi partitions its catalog by provider and Codex's has
 * no such axis, so the field is empty for Codex and its rows still have to be
 * offered.
 */
export function parseModels(value: unknown): AgentModel[] {
  if (!Array.isArray(value)) return [];
  const models: AgentModel[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const raw = entry as Record<string, unknown>;
    if (typeof raw.id !== "string" || !raw.id) continue;
    models.push({
      id: raw.id,
      provider: typeof raw.provider === "string" ? raw.provider : "",
      label: typeof raw.label === "string" && raw.label ? raw.label : undefined,
      current: raw.current === true,
      efforts: Array.isArray(raw.efforts)
        ? raw.efforts.filter((e): e is string => typeof e === "string" && !!e)
        : [],
    });
  }
  return models;
}

/**
 * Groups models by the provider serving them.
 *
 * A menu listing every model flat is hard to scan: the same id recurs under
 * several providers (`deepseek-flash` here is served by three), so every row
 * repeats its provider and nothing stands out. Grouping answers the question the
 * reader actually has — "which of the local providers has this model" — and lets
 * each row carry only the name once the heading has said whose it is.
 *
 * Provider order is the order the models arrive in, which the API already sorts.
 */
export function groupByProvider(models: AgentModel[]): ModelGroup[] {
  const groups: ModelGroup[] = [];
  const index = new Map<string, ModelGroup>();
  for (const model of models) {
    let group = index.get(model.provider);
    if (!group) {
      group = { provider: model.provider, models: [] };
      index.set(model.provider, group);
      groups.push(group);
    }
    group.models.push(model);
  }
  return groups;
}

/** One provider's models, under the heading that names it. */
export interface ModelGroup {
  provider: string;
  models: AgentModel[];
}

/**
 * How a model is named inside its provider's group.
 *
 * The group heading already names the provider, so a name only has to be unique
 * among its siblings. Two models under one provider can still share a name —
 * `deepseek-flash` and `deepseek-flash-cline` are both called "DeepSeek Flash" —
 * and there the identifier is what tells them apart.
 */
export function modelLabel(model: AgentModel, siblings: AgentModel[]): string {
  const name = model.label ?? model.id;
  const shared = siblings.some(
    (other) => modelKey(other) !== modelKey(model) && (other.label ?? other.id) === name,
  );
  return shared ? model.id : name;
}

/** The value that identifies one choice in a list. */
export function modelKey(model: AgentModel): string {
  return `${model.provider}/${model.id}`;
}

/**
 * How an effort level is named in the menu.
 *
 * Both agents spell their levels in English ids; the reader scanning the
 * composer reads Chinese, and ZCode — the reference for this control — names
 * them in Chinese too (低/中/高/最高). An id with no settled translation is
 * shown as-is: a wrong guess would be worse than the English word.
 */
export function effortLabel(effort: string | undefined): string {
  if (!effort) return "思考强度";
  const labels: Record<string, string> = {
    off: "关闭",
    none: "关闭",
    minimal: "极低",
    low: "低",
    medium: "中",
    high: "高",
    xhigh: "超高",
    max: "最高",
    ultra: "极高",
    persistent: "持续",
  };
  return labels[effort] ?? effort;
}

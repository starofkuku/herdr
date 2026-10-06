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
  const response = await client.call<{ models?: { models?: unknown; detail?: unknown } }>(
    "pane.models",
    { pane_id: paneId },
  );
  const payload = response?.models;
  return {
    models: parseModels(payload?.models),
    detail: typeof payload?.detail === "string" ? payload.detail : undefined,
  };
}

/**
 * Keeps only entries usable as a choice.
 *
 * Both `id` and `provider` are required because a choice is identified by the
 * pair; an entry missing either could not be applied.
 */
export function parseModels(value: unknown): AgentModel[] {
  if (!Array.isArray(value)) return [];
  const models: AgentModel[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const raw = entry as Record<string, unknown>;
    if (typeof raw.id !== "string" || !raw.id) continue;
    if (typeof raw.provider !== "string" || !raw.provider) continue;
    models.push({
      id: raw.id,
      provider: raw.provider,
      label: typeof raw.label === "string" && raw.label ? raw.label : undefined,
      current: raw.current === true,
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

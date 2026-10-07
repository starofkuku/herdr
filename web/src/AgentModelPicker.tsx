import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, ChevronRight } from "lucide-react";
import {
  effortLabel,
  groupByProvider,
  loadAgentModels,
  modelKey,
  modelLabel,
  type AgentModel,
  type AgentModelCatalog,
} from "./agentModels";

/** The slice of the gateway client this component needs. */
interface ModelClient {
  call: <T>(method: string, params?: Record<string, unknown>) => Promise<T>;
}

/**
 * Which agents offer a model picker.
 *
 * Both keep a catalog herdr can read and accept a switch from herdr. An agent
 * absent from this set is not offered the control at all rather than offered
 * one that would be refused.
 */
const SWITCHABLE_AGENTS = new Set(["pi", "codex"]);

/**
 * Picks the model a pane's agent runs.
 *
 * The list is the agent's own — pi's from its configuration, Codex's asked of its
 * app-server — so what the menu offers is what the agent would accept. Choosing
 * one sends the agent's own command rather than restarting the pane: the
 * conversation keeps its context, and both agents switch in place.
 *
 * The menu has two levels where the agent partitions its catalog by provider (pi
 * does; Codex does not): the provider is the first, its models the second. The
 * provider holding the running model is already expanded — the common switch is
 * between that provider's models, one tap away — while every other provider opens
 * its own list. On a pointer that can hover the second level opens beside the
 * first; on a touch screen it replaces it, with a way back. A catalog with no
 * provider axis is a single flat list.
 */
export function AgentModelPicker({
  client,
  paneId,
  agent,
  hasConversation,
  onSwitched,
}: {
  client: ModelClient;
  paneId: string;
  /** Which agent the pane runs; only pi and codex are offered the picker today. */
  agent: string | undefined;
  /**
   * Whether the pane's conversation is readable yet.
   *
   * Codex has no thread to retarget until it has been sent something, so its
   * switch is offered only once there is one: the alternative — a command typed
   * into a pane that cannot take it — is exactly what must not happen.
   */
  hasConversation: boolean;
  /** Called after a switch is sent, so the caller can refresh what it shows. */
  onSwitched?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [catalog, setCatalog] = useState<AgentModelCatalog | null>(null);
  const [openProvider, setOpenProvider] = useState<string | null>(null);
  const [effortOpen, setEffortOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  // Only agents with a catalog herdr can read are offered the control. Codex
  // additionally needs a session to exist — there is no thread to retarget
  // before its first message — while pi's switch is its own command in the pane,
  // which is available the moment the pane is.
  const supported =
    agent !== undefined &&
    SWITCHABLE_AGENTS.has(agent) &&
    paneId !== "" &&
    (agent !== "codex" || hasConversation);

  useEffect(() => {
    if (!supported) return;
    let cancelled = false;
    setCatalog(null);
    setError(null);
    void loadAgentModels(client, paneId)
      .then((result) => {
        if (!cancelled) setCatalog(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [client, paneId, supported]);

  /*
   * Opening the menu asks again. A Codex catalog is fetched on a background
   * thread and cached, so the very first answer — before any fetch has finished
   * — is a note rather than a list, and a menu that keeps showing that note
   * until the page is reopened reads as broken. Asking on open is cheap: the
   * answer is cached, and the fetch it starts is the one the menu is waiting for.
   */
  useEffect(() => {
    if (!open || !supported) return;
    let cancelled = false;
    void loadAgentModels(client, paneId)
      .then((result) => {
        if (!cancelled) {
          setCatalog(result);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [open, client, paneId, supported]);

  // A menu that outlives the press that dismissed it reads as broken. Escape
  // unwinds one level at a time: the effort menu, then the open provider's
  // list, then the model menu.
  useEffect(() => {
    if (!open && !effortOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) {
        setOpen(false);
        setOpenProvider(null);
        setEffortOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (effortOpen) setEffortOpen(false);
      else if (openProvider) setOpenProvider(null);
      else setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, openProvider, effortOpen]);

  if (!supported) return null;

  const models = catalog?.models ?? [];
  const groups = groupByProvider(models);
  const current = models.find((model) => model.current);
  // The provider whose models are worth showing without a second tap: it holds
  // the running model, so switching within it is the common case.
  const currentGroup = groups.find((group) =>
    group.models.some((model) => model.current),
  );
  const otherGroups = groups.filter((group) => group !== currentGroup);
  // An agent that does not partition its catalog by provider (Codex) arrives as
  // one nameless group. There is nothing to head or to open, so its models are
  // listed directly rather than under a blank title and a blank submenu row.
  const partitioned = !(groups.length === 1 && groups[0].provider === "");
  const submenuGroup = groups.find((group) => group.provider === openProvider);
  // Named the same way the menu names it, so the button and the ticked row never
  // disagree: within a provider whose models collide, that is the identifier.
  const currentName = current
    ? modelLabel(current, currentGroup?.models ?? models)
    : undefined;

  // Submenus follow the pointer on devices that have one; on touch, a tap that
  // hovered would immediately toggle back off, so there the row only opens.
  const canHover =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(hover: hover)").matches;

  const choose = async (model: AgentModel, effort?: string) => {
    if (busy) return;
    if (model.current && (effort === undefined || effort === catalog?.effort)) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // The switch is asked of the agent, not typed into its pane: pi takes its
      // own command, while Codex's picker opens a dialog that takes no argument,
      // so herdr tells its app-server directly. Either way the conversation keeps
      // its context, which restarting the pane would not.
      await client.call("pane.model.set", {
        pane_id: paneId,
        model: model.id,
        provider: model.provider,
        effort,
      });
      setCatalog((previous) =>
        previous
          ? {
              ...previous,
              models: previous.models.map((entry) => ({
                ...entry,
                current: entry === model,
              })),
              effort: effort ?? previous.effort,
            }
          : previous,
      );
      setOpen(false);
      setOpenProvider(null);
      setEffortOpen(false);
      onSwitched?.();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  /** One model row, shared by the expanded group and the flyout list. */
  const modelRow = (model: AgentModel, siblings: AgentModel[]) => (
    <button
      type="button"
      key={modelKey(model)}
      role="menuitemradio"
      aria-checked={model.current}
      className={`model-picker__item${model.current ? " is-current" : ""}`}
      disabled={busy}
      onClick={() => void choose(model)}
    >
      <span className="model-picker__name">{modelLabel(model, siblings)}</span>
      {model.current ? (
        <Check size={15} aria-hidden="true" className="model-picker__check" />
      ) : null}
    </button>
  );

  // The levels the running model accepts, and the one in force. Both come
  // from the catalog as it stands; pi re-derives levels per model, codex gates
  // them per model, so the menu follows the model the pane is on.
  const effortLevels = current?.efforts ?? [];
  const currentEffort = catalog?.effort;

  return (
    <div
      className="model-picker"
      data-open-provider={openProvider ?? undefined}
      ref={root}
    >
      <button
        type="button"
        className="model-picker__trigger"
        aria-label="选择模型"
        aria-expanded={open}
        title={current ? `当前模型 ${modelKey(current)}` : "选择模型"}
        onClick={() => {
          setOpenProvider(null);
          setEffortOpen(false);
          setOpen((value) => !value);
        }}
      >
        {currentName ? (
          <span className="model-picker__current">{currentName}</span>
        ) : null}
        <ChevronDown size={13} aria-hidden="true" className="model-picker__chevron" />
      </button>

      {effortLevels.length > 0 ? (
        <button
          type="button"
          className="model-picker__trigger"
          aria-label="选择思考强度"
          aria-expanded={effortOpen}
          title={
            currentEffort
              ? `当前思考强度 ${currentEffort}`
              : "选择思考强度（跟随所选模型）"
          }
          onClick={() => {
            setOpen(false);
            setOpenProvider(null);
            setEffortOpen((value) => !value);
          }}
        >
          <span className="model-picker__current">
            {effortLabel(currentEffort)}
          </span>
          <ChevronDown size={13} aria-hidden="true" className="model-picker__chevron" />
        </button>
      ) : null}

      {effortOpen ? (
        <div className="model-picker__menu model-picker__menu--effort" role="menu" aria-label="选择思考强度">
          {effortLevels.map((level) => (
            <button
              type="button"
              key={level}
              role="menuitemradio"
              aria-checked={level === currentEffort}
              className={`model-picker__item${level === currentEffort ? " is-current" : ""}`}
              disabled={busy}
              onClick={() => current && void choose(current, level)}
            >
              <span className="model-picker__name">{effortLabel(level)}</span>
              {level === currentEffort ? (
                <Check size={15} aria-hidden="true" className="model-picker__check" />
              ) : null}
            </button>
          ))}
        </div>
      ) : null}

      {open ? (
        <div className="model-picker__menu" role="menu" aria-label="选择模型">
          <div className="model-picker__list">
            {error ? <p className="model-picker__note">{error}</p> : null}
            {!catalog && !error ? <p className="model-picker__note">读取中…</p> : null}
            {catalog && models.length === 0 ? (
              <p className="model-picker__note">{catalog.detail ?? "没有可用的模型"}</p>
            ) : null}

            {!partitioned ? (
              <div className="model-picker__group" role="group">
                {models.map((model) => modelRow(model, models))}
              </div>
            ) : null}

            {partitioned && currentGroup ? (
              <div className="model-picker__group" role="group">
                <p className="model-picker__group-title">
                  <span className="model-picker__group-name">{currentGroup.provider}</span>
                  <span className="model-picker__badge">当前</span>
                </p>
                {currentGroup.models.map((model) => modelRow(model, currentGroup.models))}
              </div>
            ) : null}

            {partitioned && otherGroups.length > 0 ? (
              <div className="model-picker__providers" role="group">
                {otherGroups.map((group) => (
                  <button
                    type="button"
                    key={group.provider}
                    role="menuitem"
                    aria-haspopup="menu"
                    aria-expanded={openProvider === group.provider}
                    className={`model-picker__item model-picker__provider-row${
                      openProvider === group.provider ? " is-open" : ""
                    }`}
                    onMouseEnter={canHover ? () => setOpenProvider(group.provider) : undefined}
                    onClick={() => setOpenProvider(group.provider)}
                  >
                    <span className="model-picker__name">{group.provider}</span>
                    <ChevronRight size={14} aria-hidden="true" className="model-picker__chevron" />
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          {submenuGroup ? (
            <div
              className="model-picker__submenu"
              role="menu"
              aria-label={submenuGroup.provider}
            >
              {/* Touch screens have no hover, so the flyout is a page there and
               * this row is its way back. A pointer never shows it. */}
              <button
                type="button"
                className="model-picker__back"
                onClick={() => setOpenProvider(null)}
              >
                ‹ {submenuGroup.provider}
              </button>
              <p className="model-picker__group-title">
                <span className="model-picker__group-name">{submenuGroup.provider}</span>
              </p>
              {submenuGroup.models.map((model) =>
                modelRow(model, submenuGroup.models),
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

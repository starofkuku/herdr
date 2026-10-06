import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, ChevronRight } from "lucide-react";
import {
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
 * Picks the model a pane's agent runs.
 *
 * The list comes from the agent's own configuration, so it names the models that
 * agent would accept. Choosing one sends it as the agent's own command rather
 * than restarting the pane: the conversation keeps its context, and agents that
 * support switching do it in place.
 *
 * The menu has two levels: the provider is the first, its models the second.
 * The provider holding the running model is already expanded — the common switch
 * is between that provider's models, one tap away — while every other provider
 * opens its own list. On a pointer that can hover the second level opens beside
 * the first; on a touch screen it replaces it, with a way back.
 */
export function AgentModelPicker({
  client,
  paneId,
  agent,
  onSwitched,
}: {
  client: ModelClient;
  paneId: string;
  /** Which agent the pane runs; only pi is offered the picker today. */
  agent: string | undefined;
  /** Called after a switch is sent, so the caller can refresh what it shows. */
  onSwitched?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [catalog, setCatalog] = useState<AgentModelCatalog | null>(null);
  const [openProvider, setOpenProvider] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  // Only pi keeps a catalog herdr reads; the control is not offered for the rest
  // rather than offered and then refused.
  const supported = agent === "pi" && paneId !== "";

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

  // A menu that outlives the press that dismissed it reads as broken. Escape
  // unwinds one level at a time: the open provider's list first, then the menu.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) {
        setOpen(false);
        setOpenProvider(null);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (openProvider) setOpenProvider(null);
      else setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, openProvider]);

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

  const choose = async (model: AgentModel) => {
    if (busy || model.current) return;
    setBusy(true);
    setError(null);
    try {
      // The agent's own command, sent as text: it switches in place and keeps the
      // conversation, which restarting the pane would not.
      await client.call("pane.send_input", {
        pane_id: paneId,
        text: `/model ${model.provider}/${model.id}`,
        keys: ["Enter"],
      });
      setCatalog((previous) =>
        previous
          ? {
              ...previous,
              models: previous.models.map((entry) => ({
                ...entry,
                current: entry === model,
              })),
            }
          : previous,
      );
      setOpen(false);
      setOpenProvider(null);
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
          setOpen((value) => !value);
        }}
      >
        {currentName ? (
          <span className="model-picker__current">{currentName}</span>
        ) : null}
        <ChevronDown size={13} aria-hidden="true" className="model-picker__chevron" />
      </button>

      {open ? (
        <div className="model-picker__menu" role="menu" aria-label="选择模型">
          <div className="model-picker__list">
            {error ? <p className="model-picker__note">{error}</p> : null}
            {!catalog && !error ? <p className="model-picker__note">读取中…</p> : null}
            {catalog && models.length === 0 ? (
              <p className="model-picker__note">{catalog.detail ?? "没有可用的模型"}</p>
            ) : null}

            {currentGroup ? (
              <div className="model-picker__group" role="group">
                <p className="model-picker__group-title">
                <span className="model-picker__group-name">{currentGroup.provider}</span>
                <span className="model-picker__badge">当前</span>
              </p>
                {currentGroup.models.map((model) => modelRow(model, currentGroup.models))}
              </div>
            ) : null}

            {otherGroups.length > 0 ? (
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

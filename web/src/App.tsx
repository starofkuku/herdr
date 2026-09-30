import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentView } from "./api";
import { AgentDetail } from "./AgentDetail";
import { AgentList } from "./AgentList";
import { BackendHub } from "./backends";
import { CommandPalette } from "./CommandPalette";
import { HomeScreen } from "./HomeScreen";
import type { BackendDraft } from "./BackendForm";
import { SessionActivity } from "./SessionActivity";
import { SessionPicker } from "./SessionPicker";
import {
  loadSettings,
  rememberSession,
  removeBackend,
  saveSettings,
  upsertBackend,
  type BackendProfile,
  type StoredSettings,
} from "./settings";
import { currentRoute, navigate, type Route } from "./route";

/**
 * Which screen is shown, and for which backend.
 *
 * The route is the source of truth — it survives a reload, and it names the
 * backend so a link to a conversation says which gateway it is on. The phases
 * below it are transitions *within* a backend (binding a session, opening an
 * agent), which the route also carries.
 */
type Phase = "home" | "sessions" | "agents" | "detail";

export default function App() {
  const [route, setRoute] = useState<Route>(() => currentRoute());
  const [settings, setSettings] = useState<StoredSettings>(() => loadSettings());
  const [paletteOpen, setPaletteOpen] = useState(false);
  /** Bumped by the hub whenever something a screen draws has moved. */
  const [revision, setRevision] = useState(0);
  /** The agent list of the session each backend has bound, for the screens. */
  const backendsRef = useRef<BackendHub | null>(null);
  if (!backendsRef.current) {
    backendsRef.current = new BackendHub(() => setRevision((value) => value + 1));
  }
  const hub = backendsRef.current;
  const backends = useMemo(() => hub.list(), [hub, revision]);

  // Every saved backend gets a connection, and a change to the list is applied
  // to those connections rather than to a single active one.
  useEffect(() => {
    hub.sync(settings.backends);
  }, [hub, settings.backends]);

  useEffect(() => () => hub.dispose(), [hub]);

  /** Persists a settings change and hands it to the connections. */
  const commit = useCallback((next: StoredSettings) => {
    setSettings(next);
    saveSettings(next);
  }, []);

  const addOrEditBackend = useCallback(
    (draft: BackendDraft, id: string) => {
      const profile: BackendProfile = {
        id,
        name: draft.name,
        url: draft.url,
        remember: draft.remember,
        key: draft.remember ? draft.key : draft.key,
      };
      commit(upsertBackend(settings, profile));
    },
    [commit, settings],
  );

  const deleteBackend = useCallback(
    (id: string) => {
      commit(removeBackend(settings, id));
      // Anything showing that backend is now showing nothing.
      if (route.view !== "home" && route.backendId === id) {
        navigate({ view: "home" }, { replace: true });
        setRoute({ view: "home" });
      }
    },
    [commit, settings, route],
  );

  /** Opens a backend's session list. */
  const openBackend = useCallback((backendId: string) => {
    const target = { view: "sessions" as const, backendId };
    navigate(target);
    setRoute(target);
  }, []);

  /** Binds a session on a backend and shows its agents. */
  const openSession = useCallback(
    async (backendId: string, session: string) => {
      const target = { view: "agents" as const, backendId, session };
      navigate(target);
      setRoute(target);
      await hub.openSession(backendId, session);
      // Remembered per backend: two gateways can both have `main`, and which
      // one was open last is a fact about each of them.
      commit(rememberSession(settings, backendId, session));
    },
    [hub, commit, settings],
  );

  // Follow the browser's Back and Forward buttons by rebuilding the view from
  // the URL rather than keeping a second copy of the location in memory.
  useEffect(() => {
    const onPopState = () => setRoute(currentRoute());
    window.addEventListener("popstate", onPopState);
    window.addEventListener("hashchange", onPopState);
    return () => {
      window.removeEventListener("popstate", onPopState);
      window.removeEventListener("hashchange", onPopState);
    };
  }, []);

  /*
   * A route naming a session names something only the reader can start: the
   * gateway begins a session's server on demand. So a deep link binds the
   * session when the screen is reached, and the binding is what fills the list.
   */
  useEffect(() => {
    if (route.view !== "agents" && route.view !== "detail") return;
    const runtime = hub.get(route.backendId);
    if (!runtime) return;
    if (runtime.agentsSession === route.session) return;
    void hub.openSession(route.backendId, route.session);
  }, [hub, route, revision]);

  // Ctrl/Cmd+K opens the jump palette from any screen.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "k" && event.key !== "K") return;
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      setPaletteOpen((value) => !value);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const phase: Phase =
    route.view === "home"
      ? "home"
      : route.view === "sessions"
        ? "sessions"
        : route.view === "agents"
          ? "agents"
          : "detail";

  /** The runtime the route points at, when it points at one that exists. */
  const runtime = route.view === "home" ? undefined : hub.get(route.backendId);

  /*
   * A route can outlive its backend — the profile was deleted, or the link came
   * from another browser. Landing on the home screen is better than an empty
   * shell, and it is reported rather than silent.
   */
  useEffect(() => {
    if (route.view === "home") return;
    if (hub.get(route.backendId)) return;
    navigate({ view: "home" }, { replace: true });
    setRoute({ view: "home" });
  }, [hub, route, revision]);

  /** The agents of the session this screen shows, or an empty list. */
  const agents: AgentView[] = runtime?.agents ?? [];

  /**
   * Every agent on every backend, each stamped with where it lives.
   *
   * The rail, the palette, and the switcher all list across backends — that is
   * the point of having several saved — so they share one list and one rule for
   * what it means to be the agent on screen: the same pane *and* the same
   * backend, since two gateways can hold panes with the same id.
   */
  const allAgents: AgentView[] = useMemo(
    () =>
      backends.flatMap((entry) =>
        entry.agents.map((agent) => ({
          ...agent,
          backendId: entry.profile.id,
          backendName: entry.profile.name,
        })),
      ),
    [backends],
  );

  /** Where an agent on `backendId` lives, or null when it cannot be opened. */
  const targetFor = useCallback(
    (paneId: string, backendId: string | undefined) => {
      const id = backendId ?? (route.view === "home" ? null : route.backendId);
      if (!id) return null;
      const entry = hub.get(id);
      // An agent is only listed once its session is bound, and that session is
      // what the route needs: without one the route would parse as a different
      // screen. Nothing is opened rather than a wrong link.
      const session = entry?.agentsSession;
      if (!session) return null;
      return { view: "detail" as const, backendId: id, session, paneId };
    },
    [hub, route],
  );

  const withActivity = (screen: JSX.Element) => (
    <>
      {paletteOpen ? (
        <CommandPalette
          agents={allAgents}
          currentPaneId={route.view === "detail" ? route.paneId : null}
          currentBackendId={route.view === "home" ? null : route.backendId}
          onOpen={(paneId, backendId) => {
            const target = targetFor(paneId, backendId);
            if (!target) return;
            navigate(target);
            setRoute(target);
          }}
          onClose={() => setPaletteOpen(false)}
        />
      ) : null}
      {route.view !== "home" ? (
        <SessionActivity
          agents={allAgents}
          currentPaneId={route.view === "detail" ? route.paneId : null}
          onOpen={(paneId, backendId) => {
            const target = targetFor(paneId, backendId);
            if (!target) return;
            navigate(target);
            setRoute(target);
          }}
        />
      ) : null}
      {screen}
    </>
  );

  if (phase === "home") {
    return withActivity(
      <HomeScreen
        backends={backends}
        onOpen={openBackend}
        onRetry={(id) => hub.retry(id)}
        onSubmit={addOrEditBackend}
        onDelete={deleteBackend}
      />,
    );
  }

  if (!runtime) return null;

  if (phase === "sessions") {
    return withActivity(
      <SessionPicker
        backend={runtime.profile}
        sessions={runtime.sessions}
        connected={runtime.state === "ready"}
        detail={runtime.detail}
        client={runtime.client}
        onSelect={(name) => void openSession(runtime.profile.id, name)}
        onRefresh={() => runtime.client.listSessions()}
        onBack={() => {
          navigate({ view: "home" }, { replace: true });
          setRoute({ view: "home" });
        }}
      />,
    );
  }

  if (phase === "detail" && route.view === "detail") {
    const agent = agents.find((item) => item.paneId === route.paneId) ?? null;
    return withActivity(
      <AgentDetail
        key={`${route.backendId}:${route.paneId}`}
        client={runtime.client}
        agent={agent}
        agents={agents}
        backend={runtime.profile}
        connection={runtime.state}
        onRetry={() => hub.retry(runtime.profile.id)}
        onBack={() => {
          const target = {
            view: "agents" as const,
            backendId: runtime.profile.id,
            session: route.session,
          };
          navigate(target);
          setRoute(target);
        }}
        onSelectAgent={(paneId, backendId) => {
          const target = targetFor(paneId, backendId);
          if (!target) return;
          navigate(target);
          setRoute(target);
        }}
        allAgents={allAgents}
        onChanged={() => void hub.refreshAgents(runtime.profile.id)}
      />,
    );
  }

  const session = route.view === "agents" || route.view === "detail" ? route.session : "";
  return withActivity(
    <AgentList
      backend={runtime.profile}
      session={session}
      agents={agents}
      detail={runtime.detail}
      connection={runtime.state}
      onRetry={() => hub.retry(runtime.profile.id)}
      onOpen={(paneId) => {
        const target = { view: "detail" as const, backendId: runtime.profile.id, session, paneId };
        navigate(target);
        setRoute(target);
      }}
      onRefresh={() => void hub.refreshAgents(runtime.profile.id)}
      onLeave={() => {
        const target = { view: "sessions" as const, backendId: runtime.profile.id };
        navigate(target);
        setRoute(target);
      }}
    />,
  );
}

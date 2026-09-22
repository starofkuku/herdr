import { useCallback, useEffect, useRef, useState } from "react";
import {
  GatewayClient,
  ApiError,
  type ConnectionState,
  type SessionSummary,
  type Subscription,
} from "./gateway";
import { agentsFromSnapshot, compareAgents, type AgentView } from "./api";
import { ConnectForm } from "./ConnectForm";
import { SessionPicker } from "./SessionPicker";
import { AgentList } from "./AgentList";
import { SessionActivity } from "./SessionActivity";
import { AgentDetail } from "./AgentDetail";
import { loadSettings, saveSettings, restoreTarget, type StoredSettings } from "./settings";
import { currentRoute, navigate, type Route } from "./route";

/** Re-read the transcript when output settles, not on every single event. */
const REFRESH_DEBOUNCE_MS = 350;

/**
 * The screen implied by a route plus the connection state.
 *
 * Until the socket is up the address bar may already name a conversation, but
 * the connect form has to be shown regardless, so the connection wins for the
 * entry screens.
 */
type Phase = "connect" | "pick" | "agents" | "detail";

export default function App() {
  /**
   * The route is the source of truth for which view is shown.
   *
   * Holding it here rather than in component state is what makes a refresh land
   * back on the same conversation: the hash survives the reload, so the view is
   * rebuilt from it instead of starting over at the connect screen.
   */
  const [route, setRoute] = useState<Route>(() => currentRoute());
  const [state, setState] = useState<ConnectionState>("closed");
  const [detail, setDetail] = useState<string | undefined>();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [session, setSession] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentView[]>([]);
  const [settings, setSettings] = useState<StoredSettings>(() => loadSettings());
  const phase: Phase =
    state !== "ready" && route.view === "root"
      ? "connect"
      : route.view === "root"
        ? "pick"
        : route.view === "detail"
          ? "detail"
          : "agents";

  const clientRef = useRef<GatewayClient | null>(null);
  /** The route a reconnect should restore, and where the effect reads it from. */
  const routeRef = useRef<Route>(route);
  routeRef.current = route;
  const sessionRef = useRef<string | null>(null);
  sessionRef.current = session;
  const subscriptionRef = useRef<Subscription | null>(null);
  /**
   * Pane-scoped status subscriptions, one per pane currently listed.
   *
   * `pane.agent_status_changed` requires a `pane_id`, so it cannot be part of
   * the session-wide subscription below. The agent list has to stay correct
   * without the detail view mounted, so each listed pane gets its own.
   */
  const statusSubsRef = useRef<Map<string, Subscription>>(new Map());
  const refreshTimer = useRef<number | null>(null);
  /**
   * The last known agent list per session, so switching back is instant.
   *
   * A snapshot request is a round trip through the server, and the list is the
   * whole point of the session screen: clearing it on every switch shows an empty
   * list for as long as that takes, on every switch. The cached list is shown
   * immediately and then replaced by the fresh one, so the only thing that can be
   * stale is a status, and it is stale for one round trip.
   *
   * In memory only. It is a view of a server that owns the truth, and persisting
   * it would outlive the processes it describes.
   */
  const agentCache = useRef<Map<string, AgentView[]>>(new Map());

  if (!clientRef.current) {
    clientRef.current = new GatewayClient({
      onState: (next, message) => {
        setState(next);
        setDetail(message);
      },
      onSessions: (items) => {
        setSessions(items);
      },
    });
  }

  const client = clientRef.current;

  /**
   * Reloads the agent list for the bound session.
   *
   * The result is cached under the session that was bound when the request was
   * sent, not the one bound when it arrives: a switch during the round trip must
   * not file one session's panes under another's name.
   */
  const refreshAgents = useCallback(async () => {
    // Read before the await: the session this request is *for*. Filing the result
    // under whatever is bound when it lands would mix two sessions' panes.
    const target = sessionRef.current;
    try {
      const snapshot = await client.call<{
        snapshot?: { agents?: unknown; workspaces?: unknown };
      }>("session.snapshot");
      const list = agentsFromSnapshot(snapshot.snapshot?.agents, snapshot.snapshot?.workspaces);
      if (target) agentCache.current.set(target, list);
      // Dropped if the reader moved on while this was in flight.
      if (sessionRef.current === target) setAgents(list.sort(compareAgents));
    } catch (err) {
      if (err instanceof ApiError) setDetail(err.message);
    }
  }, [client]);

  /** Schedules a debounced agent-list refresh. */
  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current !== null) {
      window.clearTimeout(refreshTimer.current);
    }
    refreshTimer.current = window.setTimeout(() => {
      refreshTimer.current = null;
      void refreshAgents();
    }, REFRESH_DEBOUNCE_MS);
  }, [refreshAgents]);

  /** Binds to a session and starts streaming agent state. */
  const openSession = useCallback(
    async (name: string) => {
      try {
        await client.useSession(name);
      } catch (err) {
        setDetail(err instanceof Error ? err.message : String(err));
        return;
      }
      setSession(name);
      // Assigned here as well as during render: `refreshAgents` reads this ref a
      // few lines below, before React has re-rendered, and would otherwise file
      // the new session's panes under the previous session's name.
      sessionRef.current = name;
      // Paint the session from cache before awaiting anything, so the list is on
      // screen for the first frame rather than after a round trip.
      setAgents(agentCache.current.get(name) ?? []);
      setSettings((current) => {
        const next = { ...current, session: name };
        saveSettings(next);
        return next;
      });
      // Not awaited: the subscriptions below matter more than the snapshot, and
      // the fresh list arrives when it arrives.
      void refreshAgents();

      subscriptionRef.current?.close();
      // The kinds that are subscribable: agent detection, pane lifecycle, and
      // pane updates. A status change reaches `pane.updated` only on servers
      // that emit it there; older ones send `pane.agent_status_changed` alone,
      // which `syncStatusSubscriptions` covers per pane.
      subscriptionRef.current = client.subscribe(
        [
          "pane.updated",
          "pane.agent_detected",
          "pane.created",
          "pane.closed",
          "workspace.updated",
        ],
        () => scheduleRefresh(),
      );

      statusSubsRef.current.forEach((sub) => sub.close());
      statusSubsRef.current.clear();
    },
    [client, refreshAgents, scheduleRefresh],
  );

  // Keep one status subscription per listed pane, so the agent list reflects a
  // status change on a server that reports it only as
  // `pane.agent_status_changed`. Panes that disappear are unsubscribed, and a
  // subscription is reused while its pane stays listed.
  useEffect(() => {
    const wanted = new Set(
      agents.map((agent) => agent.paneId).filter((paneId): paneId is string => !!paneId),
    );

    for (const [paneId, subscription] of statusSubsRef.current) {
      if (!wanted.has(paneId)) {
        subscription.close();
        statusSubsRef.current.delete(paneId);
      }
    }

    for (const paneId of wanted) {
      if (statusSubsRef.current.has(paneId)) continue;
      statusSubsRef.current.set(
        paneId,
        client.subscribe([{ type: "pane.agent_status_changed", pane_id: paneId }], () =>
          scheduleRefresh(),
        ),
      );
    }
  }, [agents, client, scheduleRefresh]);

  // Drop every status subscription when the session is left, so a later session
  // does not inherit subscriptions to panes that no longer exist.
  useEffect(
    () => () => {
      statusSubsRef.current.forEach((sub) => sub.close());
      statusSubsRef.current.clear();
    },
    [],
  );

  const connect = useCallback(
    (url: string, key: string, remember: boolean) => {
      const next: StoredSettings = {
        url,
        remember,
        key: remember ? key : undefined,
        session: undefined,
      };
      setSettings(next);
      saveSettings(next);
      client.connect(url, key);
    },
    [client],
  );

  /**
   * Reconnects, or returns to the form when there is nothing to reconnect with.
   *
   * `retryNow` can only reuse stored credentials. Without a remembered key there
   * is nothing to retry, so the reader is sent back to the form instead of
   * tapping a button that cannot work.
   */
  const retry = useCallback(() => {
    if (restoreTarget(settings)) {
      client.retryNow();
      return;
    }
    client.close();
    navigate({ view: "root" }, { replace: true });
    setRoute({ view: "root" });
  }, [client, settings]);

  useEffect(() => {
    if (state === "ready") client.listSessions();
  }, [state, client]);

  /**
   * Reconnects on load when the connection was remembered.
   *
   * Without this a refresh always lands on the connect form, even though the
   * route still names the conversation the reader was in and the key is stored.
   * Runs once: after this the socket owns its own reconnection.
   */
  const autoConnectedRef = useRef(false);
  useEffect(() => {
    if (autoConnectedRef.current) return;
    autoConnectedRef.current = true;
    if (restoreTarget(settings) && settings.url) {
      client.connect(settings.url, settings.key ?? "");
    }
    // Only the initial settings matter; later edits go through `connect`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Follow the browser's Back and Forward buttons, and any hand-edited hash, by
  // rebuilding the view from the URL rather than keeping a second copy of the
  // location in memory.
  useEffect(() => {
    const onPopState = () => setRoute(currentRoute());
    window.addEventListener("popstate", onPopState);
    window.addEventListener("hashchange", onPopState);
    return () => {
      window.removeEventListener("popstate", onPopState);
      window.removeEventListener("hashchange", onPopState);
    };
  }, []);

  /**
   * Binds the session named by the current route.
   *
   * Runs whenever the socket becomes ready. On a refresh the route already names
   * a session, so this is what turns a deep link back into a live view instead
   * of leaving the reader on the picker. A route naming a session the server no
   * longer has falls back to the root rather than pointing at nothing.
   */
  const restoringRef = useRef(false);
  useEffect(() => {
    if (state !== "ready") return;
    const wanted = routeRef.current;
    if (wanted.view === "root") return;
    if (restoringRef.current) return;
    // Already bound to the right session; only a pane change is left to apply.
    if (sessionRef.current === wanted.session) return;
    restoringRef.current = true;
    void (async () => {
      try {
        await client.useSession(wanted.session);
        setSession(wanted.session);
        // Same reason as `openSession`: this ref is what `refreshAgents` caches
        // under, and render has not run yet.
        sessionRef.current = wanted.session;
        setAgents(agentCache.current.get(wanted.session) ?? []);
        await refreshAgents();
      } catch {
        // Unknown session (deleted, or a link from another machine): fall back
        // to the picker instead of showing an empty conversation.
        setSession(null);
        sessionRef.current = null;
        setAgents([]);
        navigate({ view: "root" }, { replace: true });
        setRoute({ view: "root" });
      } finally {
        restoringRef.current = false;
      }
    })();
  }, [state, client, refreshAgents]);

  useEffect(
    () => () => {
      subscriptionRef.current?.close();
      if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
      clientRef.current?.close();
    },
    [],
  );

  /**
   * Wraps a screen with the session activity panel.
   *
   * The panel is pinned rather than placed inside a screen because it is about
   * the panes that are *not* on screen: it has to survive moving between the
   * list and a conversation, which is exactly when it is worth a glance.
   */
  const withActivity = (screen: JSX.Element) => (
    <>
      <SessionActivity
        agents={agents}
        currentPaneId={route.view === "detail" ? route.paneId : null}
        onOpen={(paneId) => {
          const target = { view: "detail" as const, session: session ?? "", paneId };
          navigate(target);
          setRoute(target);
        }}
      />
      {screen}
    </>
  );

  if (phase === "connect") {
    return withActivity(
      <ConnectForm
        initialUrl={settings.url}
        initialKey={settings.remember ? settings.key ?? "" : ""}
        remember={settings.remember}
        state={state}
        detail={detail}
        onConnect={connect}
        onRememberChange={(remember) => {
          const next = { ...settings, remember, key: remember ? settings.key : undefined };
          setSettings(next);
          saveSettings(next);
        }}
      />
    );
  }

  if (phase === "pick") {
    return withActivity(
      <SessionPicker
        sessions={sessions}
        connected={state === "ready"}
        detail={detail}
        client={client}
        onSelect={(name) => {
          navigate({ view: "agents", session: name });
          setRoute({ view: "agents", session: name });
          void openSession(name);
        }}
        onRefresh={() => client.listSessions()}
        onDisconnect={() => {
          client.close();
          navigate({ view: "root" }, { replace: true });
          setRoute({ view: "root" });
        }}
      />
    );
  }

  if (phase === "detail" && route.view === "detail") {
    const agent = agents.find((item) => item.paneId === route.paneId) ?? null;
    return withActivity(
      <AgentDetail
        client={client}
        agent={agent}
        agents={agents}
        connection={state}
        onRetry={retry}
        onBack={() => {
          const target = { view: "agents" as const, session: session ?? "" };
          navigate(target);
          setRoute(target);
        }}
        onSelectAgent={(paneId) => {
          const target = { view: "detail" as const, session: session ?? "", paneId };
          navigate(target);
          setRoute(target);
        }}
        onChanged={() => scheduleRefresh()}
      />
    );
  }

  return withActivity(
    <AgentList
      session={session ?? ""}
      agents={agents}
      detail={detail}
      connection={state}
      onRetry={retry}
      onOpen={(paneId) => {
        const target = { view: "detail" as const, session: session ?? "", paneId };
        navigate(target);
        setRoute(target);
      }}
      onRefresh={() => void refreshAgents()}
      onLeave={() => {
        subscriptionRef.current?.close();
        subscriptionRef.current = null;
        statusSubsRef.current.forEach((sub) => sub.close());
        statusSubsRef.current.clear();
        setSession(null);
        sessionRef.current = null;
        // The cache is kept; only the live list is cleared, so returning to this
        // session is still instant.
        setAgents([]);
        setSettings((current) => {
          const next = { ...current, session: undefined };
          saveSettings(next);
          return next;
        });
        navigate({ view: "root" }, { replace: true });
        setRoute({ view: "root" });
      }}
    />
  );
}

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
import { AgentDetail } from "./AgentDetail";
import { loadSettings, saveSettings, type StoredSettings } from "./settings";

type Phase = "connect" | "pick" | "agents" | "detail";

/** Re-read the transcript when output settles, not on every single event. */
const REFRESH_DEBOUNCE_MS = 350;

export default function App() {
  const [phase, setPhase] = useState<Phase>("connect");
  const [state, setState] = useState<ConnectionState>("closed");
  const [detail, setDetail] = useState<string | undefined>();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [session, setSession] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentView[]>([]);
  const [activePane, setActivePane] = useState<string | null>(null);
  const [settings, setSettings] = useState<StoredSettings>(() => loadSettings());

  const clientRef = useRef<GatewayClient | null>(null);
  const phaseRef = useRef<Phase>("connect");
  phaseRef.current = phase;
  const sessionRef = useRef<string | null>(null);
  sessionRef.current = session;
  const subscriptionRef = useRef<Subscription | null>(null);
  const refreshTimer = useRef<number | null>(null);

  if (!clientRef.current) {
    clientRef.current = new GatewayClient({
      onState: (next, message) => {
        setState(next);
        setDetail(message);
      },
      onSessions: (items) => {
        setSessions(items);
        if (phaseRef.current === "connect") setPhase("pick");
      },
    });
  }

  const client = clientRef.current;

  /** Reloads the agent list for the bound session. */
  const refreshAgents = useCallback(async () => {
    try {
      const snapshot = await client.call<{
        snapshot?: { agents?: unknown; workspaces?: unknown };
      }>("session.snapshot");
      const list = agentsFromSnapshot(snapshot.snapshot?.agents, snapshot.snapshot?.workspaces);
      setAgents(list.sort(compareAgents));
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
      setSettings((current) => {
        const next = { ...current, session: name };
        saveSettings(next);
        return next;
      });
      await refreshAgents();
      setPhase("agents");

      subscriptionRef.current?.close();
      // The kinds that are subscribable: agent detection, pane lifecycle, and
      // pane updates. A status change reaches `pane.updated` only on servers
      // that emit it there, so `AgentDetail` also subscribes to
      // `pane.agent_status_changed` for the pane it is showing.
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
    },
    [client, refreshAgents, scheduleRefresh],
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

  useEffect(() => {
    if (state === "ready") client.listSessions();
  }, [state, client]);

  useEffect(
    () => () => {
      subscriptionRef.current?.close();
      if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
      clientRef.current?.close();
    },
    [],
  );

  if (phase === "connect") {
    return (
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
    return (
      <SessionPicker
        sessions={sessions}
        connected={state === "ready"}
        detail={detail}
        onSelect={(name) => void openSession(name)}
        onRefresh={() => client.listSessions()}
        onDisconnect={() => {
          client.close();
          setPhase("connect");
        }}
      />
    );
  }

  if (phase === "detail" && activePane) {
    const agent = agents.find((item) => item.paneId === activePane) ?? null;
    return (
      <AgentDetail
        client={client}
        agent={agent}
        onBack={() => setPhase("agents")}
        onChanged={() => scheduleRefresh()}
      />
    );
  }

  return (
    <AgentList
      session={session ?? ""}
      agents={agents}
      detail={detail}
      onOpen={(paneId) => {
        setActivePane(paneId);
        setPhase("detail");
      }}
      onRefresh={() => void refreshAgents()}
      onLeave={() => {
        subscriptionRef.current?.close();
        subscriptionRef.current = null;
        setSession(null);
        setSettings((current) => {
          const next = { ...current, session: undefined };
          saveSettings(next);
          return next;
        });
        setPhase("pick");
      }}
    />
  );
}

// The live connection to every saved gateway.
//
// One `GatewayClient` per backend, kept open for as long as the backend is
// saved: the home screen shows all of them side by side, and a card can only
// report what is happening on a gateway whose socket is up. This module owns
// those connections and the per-backend view state; it renders nothing and
// calls `onChange` when something a screen would draw has moved.
//
// Everything is keyed by backend id. Session names are not unique across
// gateways — two of them can both have `main` — so nothing here may be filed
// under a session name alone.

import { agentsFromSnapshot, compareAgents, type AgentView } from "./api";
import {
  ApiError,
  GatewayClient,
  type ConnectionState,
  type SessionSummary,
  type Subscription,
} from "./gateway";
import type { BackendProfile } from "./settings";

/** How long to wait after an event before re-reading an agent list. */
const REFRESH_DEBOUNCE_MS = 350;

/**
 * How long to wait before re-opening a backend whose event stream closed.
 *
 * The usual cause is the session server restarting, which may still be coming
 * up when the close arrives; a beat of delay keeps the retry from racing it.
 */
const REOPEN_DELAY_MS = 1000;

/**
 * How often the agent lists are re-read as a backstop to the event stream.
 * Slow enough to be idle work, fast enough that a frozen status cannot sit
 * for minutes the way a dead stream otherwise lets it.
 */
const POLL_BACKSTOP_MS = 10_000;

/**
 * The kinds that can move an agent list.
 *
 * `pane.updated` carries status changes on servers that fold them in; the
 * per-pane subscription below covers the ones that report status on its own
 * channel, which is why both exist.
 */
const SESSION_KINDS = [
  "pane.updated",
  "pane.agent_detected",
  "pane.created",
  "pane.closed",
  "workspace.updated",
];

/** One backend, as the screens see it. */
export interface BackendRuntime {
  profile: BackendProfile;
  client: GatewayClient;
  state: ConnectionState;
  /** The connection state's own message, when it has one. */
  detail?: string;
  sessions: SessionSummary[];
  /** Agents of the session bound on this connection; empty until one is. */
  agents: AgentView[];
  /** The session `agents` describes, or null when nothing is bound. */
  agentsSession: string | null;
}

/** A runtime plus the subscriptions that keep it current. */
interface Live extends BackendRuntime {
  /** Session-wide events, one subscription for the whole session. */
  sessionSubscription: Subscription | null;
  /** One per listed pane, for servers that report status separately. */
  statusSubs: Map<string, Subscription>;
  refreshTimer: number | null;
}

/**
 * The session to bind on connect, or null when nothing may be bound.
 *
 * Only a session that is already running is a candidate: binding one that is
 * not would start its server, and a page load must not spawn processes. The
 * reader's own last session wins so returning to a gateway lands where they
 * left it; otherwise the first running session is as good as any, since all
 * that is being asked of it is that this backend reports its agents at all.
 */
export function pickBindableSession(
  sessions: SessionSummary[],
  preferred: string | undefined,
): string | null {
  const running = sessions.filter((session) => session.running);
  const chosen = running.find((session) => session.name === preferred) ?? running[0];
  return chosen?.name ?? null;
}

export class BackendHub {
  private live = new Map<string, Live>();
  private notify: () => void;
  private pollTimer: number | null = null;

  constructor(notify: () => void) {
    this.notify = notify;
    // The event stream is the primary sync, but it can die silently: a session
    // server that stops cleanly ends the gateway's subscription with an EOF
    // nothing reports to this side, and every request still succeeds on its
    // own connection, so nothing else says the list has gone stale. A slow
    // poll bounds how long a frozen status can live — at most one interval.
    this.pollTimer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      for (const runtime of this.live.values()) {
        if (runtime.agentsSession) void this.refreshAgents(runtime.profile.id);
      }
    }, POLL_BACKSTOP_MS);
  }

  /** Every saved backend, in the order they were saved. */
  list(): BackendRuntime[] {
    return [...this.live.values()];
  }

  get(id: string): BackendRuntime | undefined {
    return this.live.get(id);
  }

  /**
   * Brings the connections in step with the saved profiles.
   *
   * A new backend connects, a removed one is closed, and an edited one is
   * rebuilt — its socket belongs to the address and key it was opened with, so a
   * change to either is a different connection.
   */
  sync(profiles: BackendProfile[]): void {
    for (const profile of profiles) {
      const existing = this.live.get(profile.id);
      if (!existing) {
        this.open(profile);
        continue;
      }
      const changed =
        existing.profile.url !== profile.url || existing.profile.key !== profile.key;
      if (changed) {
        this.close(profile.id);
        this.open(profile);
      } else {
        existing.profile = profile;
      }
    }
    for (const id of [...this.live.keys()]) {
      if (!profiles.some((profile) => profile.id === id)) this.close(id);
    }
    this.notify();
  }

  /** Reconnects a backend that has given up. */
  retry(id: string): void {
    const runtime = this.live.get(id);
    runtime?.client.retryNow();
  }

  /** Closes every connection. */
  dispose(): void {
    if (this.pollTimer !== null) window.clearInterval(this.pollTimer);
    this.pollTimer = null;
    for (const id of [...this.live.keys()]) this.close(id);
  }

  /**
   * Binds a session on one backend and follows it.
   *
   * Binding is what makes agents readable at all: the gateway serves one
   * session per connection, and a backend with nothing bound can offer only its
   * session list. It is what the reader's own choice does, and it is also what
   * `bindRunningSession` does on connect — but only ever to a session that is
   * already running: the gateway starts a session's server on demand, and
   * opening a page must not spawn processes nobody asked for.
   */
  async openSession(id: string, session: string): Promise<void> {
    const runtime = this.live.get(id);
    if (!runtime) return;
    const client = runtime.client;
    try {
      await client.useSession(session);
    } catch (err) {
      runtime.detail = err instanceof Error ? err.message : String(err);
      this.notify();
      return;
    }
    // A second call while the first was in flight leaves the later one winning.
    runtime.agentsSession = session;
    this.subscribeSession(runtime);
    await this.refreshAgents(id);
  }

  /**
   * Re-reads the bound session's agents.
   *
   * `agent.list` rather than the session snapshot: it returns every agent in
   * the session straight away, where the snapshot's list is the same data
   * wrapped in a document this only reads two fields from. Both need a bound
   * session; neither starts one.
   *
   * The workspace list comes along because an agent carries its workspace's id
   * and the UI shows the label — two small reads against one, and the label is
   * what a reader recognizes.
   */
  async refreshAgents(id: string): Promise<void> {
    const runtime = this.live.get(id);
    if (!runtime) return;
    const session = runtime.agentsSession;
    if (!session) return;
    try {
      const [agents, workspaces] = await Promise.all([
        runtime.client.call<{ agents?: unknown }>("agent.list"),
        runtime.client.call<{ workspaces?: unknown }>("workspace.list"),
      ]);
      // Dropped when the reader moved on while this was in flight, so one
      // session's panes cannot be filed under another's name.
      if (runtime.agentsSession !== session) return;
      const list = agentsFromSnapshot(agents.agents, workspaces.workspaces);
      runtime.agents = list.sort(compareAgents);
      this.syncStatusSubscriptions(runtime);
      this.notify();
    } catch (err) {
      if (err instanceof ApiError) {
        runtime.detail = err.message;
        this.notify();
      }
    }
  }

  /**
   * Binds a session that is already running, so the backend reports its agents.
   *
   * A backend with nothing bound shows only its session list, which leaves the
   * palette and the switcher empty for every gateway the reader has not opened
   * in this page. Binding a *running* session fixes that without starting
   * anything: `use_session` would spawn a session's server if it were not
   * already up, and opening a page must not do that for every gateway saved.
   *
   * The reader's own last session wins, then the first running one. A backend
   * with nothing running stays unbound — it has no agents to report, and the
   * card says so.
   */
  private bindRunningSession(runtime: Live): boolean {
    if (runtime.agentsSession) return false;
    const chosen = pickBindableSession(runtime.sessions, runtime.profile.session);
    if (!chosen) return false;
    void this.openSession(runtime.profile.id, chosen);
    return true;
  }

  /** Schedules a coalesced agent-list refresh for one backend. */
  private scheduleRefresh(runtime: Live): void {
    if (runtime.refreshTimer !== null) return;
    runtime.refreshTimer = window.setTimeout(() => {
      runtime.refreshTimer = null;
      void this.refreshAgents(runtime.profile.id);
    }, REFRESH_DEBOUNCE_MS);
  }

  /** Creates the runtime for a profile and connects it. */
  private open(profile: BackendProfile): void {
    const runtime: Live = {
      profile,
      state: "closed",
      sessions: [],
      agents: [],
      agentsSession: null,
      sessionSubscription: null,
      statusSubs: new Map(),
      refreshTimer: null,
      client: undefined as unknown as GatewayClient,
    };
    runtime.client = new GatewayClient({
      onState: (state, detail) => {
        runtime.state = state;
        runtime.detail = detail;
        if (state === "ready") {
          // The listing is per connection, so it is re-read whenever one opens —
          // including after a reconnect, which lands here a second time.
          runtime.client.listSessions();
          if (runtime.agentsSession) {
            // The gateway forgets the binding when the socket drops, so it is
            // re-established and the list re-read. The list also re-arrives,
            // which is what re-binds a backend that had nothing bound.
            void this.openSession(profile.id, runtime.agentsSession);
          }
        }
        this.notify();
      },
      onSessions: (items) => {
        runtime.sessions = items;
        // The list is what says which sessions are running, so binding waits
        // for it rather than guessing.
        this.bindRunningSession(runtime);
        this.notify();
      },
    });
    this.live.set(profile.id, runtime);
    // A backend whose key was not kept has nothing to authenticate with: it
    // stays closed until the reader supplies one, which is what the card shows.
    if (profile.key) runtime.client.connect(profile.url, profile.key);
  }

  /** Tears down one runtime and everything it holds open. */
  private close(id: string): void {
    const runtime = this.live.get(id);
    if (!runtime) return;
    runtime.sessionSubscription?.close();
    for (const subscription of runtime.statusSubs.values()) subscription.close();
    if (runtime.refreshTimer !== null) window.clearTimeout(runtime.refreshTimer);
    runtime.client.close();
    this.live.delete(id);
  }

  /** Subscribes to the bound session's events, replacing any earlier stream. */
  private subscribeSession(runtime: Live): void {
    runtime.sessionSubscription?.close();
    runtime.sessionSubscription = runtime.client.subscribe(
      SESSION_KINDS,
      () => this.scheduleRefresh(runtime),
      () => this.reopenSession(runtime),
    );
  }

  /**
   * Keeps one status subscription per listed pane.
   *
   * `pane.agent_status_changed` requires a `pane_id`, so it cannot be part of
   * the session-wide stream; on a server that reports status only there, this is
   * what keeps the list current.
   */
  private syncStatusSubscriptions(runtime: Live): void {
    const wanted = new Set(runtime.agents.map((agent) => agent.paneId).filter(Boolean));
    for (const [paneId, subscription] of runtime.statusSubs) {
      if (!wanted.has(paneId)) {
        subscription.close();
        runtime.statusSubs.delete(paneId);
      }
    }
    for (const paneId of wanted) {
      if (runtime.statusSubs.has(paneId)) continue;
      runtime.statusSubs.set(
        paneId,
        runtime.client.subscribe(
          [{ type: "pane.agent_status_changed", pane_id: paneId }],
          () => this.scheduleRefresh(runtime),
          () => this.reopenSession(runtime),
        ),
      );
    }
  }

  /**
   * Re-opens a backend whose event stream the gateway closed underneath it.
   *
   * The usual cause is the session server restarting. Without this the agent
   * list sits frozen on its last snapshot — everything else keeps working,
   * because requests travel their own connection — until the page is reloaded
   * by hand. The rebind is forced rather than `openSession`'s idempotent one:
   * the gateway must hear `use_session` again, because that is what brings a
   * dead server back and re-points the gateway at it.
   */
  private reopenSession(runtime: Live): void {
    const id = runtime.profile.id;
    const session = runtime.agentsSession;
    if (!session) return;
    window.setTimeout(() => {
      // The backend may have been removed, or the reader moved to another
      // session, while the delay waited.
      const current = this.live.get(id);
      if (!current || current.agentsSession !== session) return;
      void current.client
        .useSession(session, { force: true })
        .then(() => {
          const live = this.live.get(id);
          if (!live || live.agentsSession !== session) return;
          this.subscribeSession(live);
          return this.refreshAgents(id);
        })
        .catch(() => {
          // A server that will not come back reports itself through the
          // request the poll backstop keeps making; nothing to add here.
        });
    }, REOPEN_DELAY_MS);
  }
}

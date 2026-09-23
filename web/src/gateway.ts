// Browser client for the herdr web gateway.
//
// The gateway is a thin proxy over the public herdr JSON API. This module owns
// the WebSocket, authentication, session binding, request/response correlation,
// and subscription fan-out, so components work with plain promises.

export const PROTOCOL_VERSION = 2;

/**
 * Reconnect backoff.
 *
 * The first retry is quick so a brief drop is invisible; later attempts spread
 * out so a server that is down is not hammered, and the wait is capped so a
 * reader coming back to a long-suspended tab does not wait minutes.
 */
export const RECONNECT_BASE_DELAY_MS = 500;
export const RECONNECT_MAX_DELAY_MS = 8000;

export interface SessionSummary {
  name: string;
  default: boolean;
  running: boolean;
}

export type ConnectionState = "connecting" | "authenticating" | "ready" | "reconnecting" | "closed" | "error";

interface ServerMessage {
  type: string;
  authenticated?: boolean;
  protocol?: number;
  items?: SessionSummary[];
  name?: string;
  id?: string;
  result?: unknown;
  payload?: unknown;
  reason?: string;
  message?: string;
}

/** One API response envelope from the gateway. */
export interface ApiEnvelope {
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
}

export interface GatewayHandlers {
  onState: (state: ConnectionState, detail?: string) => void;
  onSessions: (items: SessionSummary[]) => void;
}

/** A live subscription. Call `close()` to stop it. */
export interface Subscription {
  close: () => void;
}

/** Thrown when an API call returns an error envelope. */
export class ApiError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
  }
}

function randomId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export class GatewayClient {
  private socket: WebSocket | null = null;
  private handlers: GatewayHandlers;
  private sessionName: string | null = null;
  /** Credentials of the live connection, kept so it can be rebuilt. */
  private credentials: { url: string; key: string } | null = null;
  /** Subscriptions to re-establish after a reconnect. */
  private subscriptions = new Map<
    string,
    { kinds: (string | Record<string, unknown>)[]; onEvent: (payload: unknown) => void }
  >();
  private reconnectTimer: number | null = null;
  private reconnectAttempts = 0;
  /** Set when the user closes the connection, so it is not reopened. */
  private closedByUser = false;
  /** True while a reconnect is re-binding the session, before ready is announced. */
  private rebinding = false;
  /**
   * Last state reported to the host.
   *
   * A transient gateway error restates this unchanged, so an error message
   * cannot move the connection out of its retry state machine.
   */
  private lastState: ConnectionState = "closed";

  /**
   * Reconnects as soon as the page is visible again.
   *
   * A backgrounded tab has its timers frozen, so the reconnect backoff cannot
   * run until the page is visible — which is exactly when the connection is
   * wanted. Without this the page comes back to a dead socket and shows whatever
   * it last knew: an agent that finished in the meantime still looks like it is
   * working, so the stop control stays on screen after there is nothing to stop.
   */
  private readonly onVisibilityChange = () => {
    if (document.hidden) return;
    if (this.credentials && !this.closedByUser) this.retryNow();
  };

  private pending = new Map<
    string,
    { resolve: (value: ApiEnvelope) => void; reject: (err: Error) => void }
  >();
  private eventHandlers = new Map<string, (payload: unknown) => void>();
  private sessionWaiters: { resolve: () => void; reject: (err: Error) => void }[] = [];

  constructor(handlers: GatewayHandlers) {
    this.handlers = handlers;
    document.addEventListener("visibilitychange", this.onVisibilityChange);
  }

  connect(url: string, key: string): void {
    this.credentials = { url, key };
    this.closedByUser = false;
    this.reconnectAttempts = 0;
    this.open();
  }

  /**
   * Reconnects after a drop, backing off so a server that stays down is not
   * hammered.
   *
   * A phone browser suspends a backgrounded tab and the socket dies; coming back
   * to the page finds a dead connection and a frozen view, which is what this
   * recovers from. The delay grows with each attempt and is capped, and the
   * attempt counter resets once a connection succeeds.
   */
  private scheduleReconnect(): void {
    if (this.closedByUser || !this.credentials) return;
    if (this.reconnectTimer !== null) return;
    const delay = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** this.reconnectAttempts);
    this.reconnectAttempts += 1;
    this.setState("reconnecting", `retrying in ${Math.round(delay / 1000)}s`);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closedByUser || !this.credentials) return;
      this.open();
    }, delay);
  }

  /** Reconnects immediately, for the manual retry control. */
  retryNow(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempts = 0;
    if (this.credentials && !this.closedByUser) this.open();
  }

  /**
   * Opens the socket and wires it up.
   *
   * On success any session binding and subscriptions are re-established, because
   * the server treats a reconnect as a new client with no state.
   */
  private open(): void {
    if (!this.credentials) return;
    this.rebinding = false;
    this.resetConnection();
    this.setState("connecting");

    const { url, key } = this.credentials;
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (err) {
      this.setState("error", `invalid server address: ${String(err)}`);
      // A bad address is not worth retrying on a timer; the reader has to fix it.
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      this.setState("authenticating");
      // A fresh socket knows nothing about the previous session binding, so it
      // is restored before the subscriptions that depend on it.
      this.send({ type: "auth", key, protocol: PROTOCOL_VERSION });
    };
    socket.onmessage = (event) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }
      this.dispatch(message);
    };
    socket.onerror = () => {
      // `onclose` always follows, which is where reconnection is handled; a
      // message here would be replaced immediately.
    };
    socket.onclose = () => {
      if (this.socket !== socket) return; // A superseded socket.
      // Fail anything still waiting so callers do not hang forever.
      const error = new Error("connection closed");
      for (const { reject } of this.pending.values()) reject(error);
      this.pending.clear();
      for (const waiter of this.sessionWaiters) waiter.reject(error);
      this.sessionWaiters = [];
      this.socket = null;
      if (this.closedByUser) {
        this.setState("closed");
        return;
      }
      this.scheduleReconnect();
    };
  }

  /**
   * Re-establishes the session binding and subscriptions after a reconnect.
   *
   * Called once the server reports the connection is authenticated. Ready is not
   * announced here when a session is bound: the gateway holds no session on a
   * fresh socket, and a request or subscription sent in that window is rejected
   * with a transient "no session selected". Announcing ready early made every
   * view race the binding, so an ordinary reconnect surfaced as an error.
   */
  private restore(): void {
    this.reconnectAttempts = 0;
    const name = this.sessionName;
    if (name) {
      this.rebinding = true;
      this.send({ type: "use_session", name });
      // `session_ready` completes the handshake and announces ready.
      return;
    }
    this.announceReady();
  }

  /** Announces readiness, then re-establishes subscriptions. */
  private announceReady(): void {
    this.setState("ready");
    this.resendSubscriptions();
  }

  /**
   * Reports a state, remembering it.
   *
   * `lastState` is what a transient gateway error restates, so such an error
   * cannot move the connection out of its retry state machine.
   */
  private setState(state: ConnectionState, detail?: string): void {
    this.lastState = state;
    this.handlers.onState(state, detail);
  }

  /** Re-subscribes every live subscription on the current socket. */
  private resendSubscriptions(): void {
    for (const [id, entry] of this.subscriptions) {
      this.send({
        type: "subscribe",
        id,
        subscriptions: entry.kinds.map((kind) =>
          typeof kind === "string" ? { type: kind } : kind,
        ),
      });
    }
  }

  private dispatch(message: ServerMessage): void {
    switch (message.type) {
      case "hello":
        if (message.authenticated) {
          // Ready is announced by `restore` once any session is re-bound. A
          // fresh socket holds no session, so announcing it here would let the
          // views issue requests the gateway rejects with a transient "no
          // session selected".
          this.restore();
        } else {
          this.setState("authenticating");
        }
        break;

      case "sessions":
        this.handlers.onSessions(message.items ?? []);
        break;

      case "session_ready":
        this.sessionName = message.name ?? null;
        for (const waiter of this.sessionWaiters) waiter.resolve();
        this.sessionWaiters = [];
        // A rebind started by `restore` is what completes a reconnect, so ready
        // is announced here rather than when the socket merely authenticated.
        if (this.rebinding) {
          this.rebinding = false;
          this.announceReady();
        }
        break;

      case "api_result": {
        const id = message.id ?? "";
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        pending.resolve((message.result ?? {}) as ApiEnvelope);
        break;
      }

      case "event": {
        const handler = this.eventHandlers.get(message.id ?? "");
        handler?.(message.payload);
        break;
      }

      case "event_closed": {
        const id = message.id ?? "";
        const handler = this.eventHandlers.get(id);
        if (handler) {
          this.eventHandlers.delete(id);
          this.send({ type: "unsubscribe", id });
        }
        break;
      }

      case "error":
        // Gateway errors are transient, not fatal. The usual cause is a request
        // that arrived while the session binding was still being established;
        // treating that as a terminal state would strand the client after an
        // ordinary reconnect. The message is surfaced as detail, and the current
        // state is restated unchanged so the retry state machine keeps running.
        this.setState(this.lastState, message.message);
        break;
    }
  }

  private send(payload: unknown): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(payload));
    }
  }

  /** Lists known sessions. */
  listSessions(): void {
    this.send({ type: "sessions_list" });
  }

  /** Binds the connection to a session, starting its server if needed. */
  useSession(name: string): Promise<void> {
    if (this.sessionName === name) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      this.sessionWaiters.push({ resolve, reject });
      this.send({ type: "use_session", name });
    });
  }

  /** Sends one API request and resolves with its response envelope. */
  api(method: string, params: Record<string, unknown> = {}): Promise<ApiEnvelope> {
    const id = randomId("api");
    return new Promise<ApiEnvelope>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ type: "api", id, method, params });
    });
  }

  /** Sends one API request, throwing when the API returns an error envelope. */
  async call<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    const envelope = await this.api(method, params);
    if (envelope.error) {
      throw new ApiError(envelope.error.code, envelope.error.message);
    }
    return (envelope.result ?? {}) as T;
  }

  /**
   * Starts a subscription; `onEvent` receives each streamed payload.
   *
   * A kind is either a bare name or a full subscription object, which some
   * kinds require: `pane.agent_status_changed` is scoped to one pane and the
   * server rejects it without a `pane_id`.
   */
  subscribe(
    kinds: (string | Record<string, unknown>)[],
    onEvent: (payload: unknown) => void,
    onClosed?: (reason: string) => void,
  ): Subscription {
    const id = randomId("sub");
    this.eventHandlers.set(id, (payload) => {
      const record = payload as { event?: { kind?: string }; result?: unknown } | null;
      // The first line is the subscribe acknowledgment, not an event.
      if (record && typeof record === "object" && "result" in record) {
        return;
      }
      onEvent(payload);
    });
    if (onClosed) {
      this.eventHandlers.set(`${id}:closed`, () => onClosed("closed"));
    }
    // Kept so the subscription can be re-sent on a reconnect, when the server
    // has no memory of it.
    if (this.subscriptions) this.subscriptions.set(id, { kinds, onEvent });
    this.send({
      type: "subscribe",
      id,
      // The API expects an internally tagged object per subscription, so a bare
      // name is expanded to `{ type: name }` here rather than at each call site.
      subscriptions: kinds.map((kind) =>
        typeof kind === "string" ? { type: kind } : kind,
      ),
    });

    return {
      close: () => {
        this.eventHandlers.delete(id);
        this.eventHandlers.delete(`${id}:closed`);
        this.subscriptions?.delete(id);
        this.send({ type: "unsubscribe", id });
      },
    };
  }

  /**
   * Closes the connection for good.
   *
   * A disconnect the user asked for must not be undone by the reconnect timer,
   * so this is separated from the internal socket teardown.
   */
  close(): void {
    this.closedByUser = true;
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.resetConnection();
    if (this.socket) {
      this.socket.onclose = null;
      this.socket.close();
      this.socket = null;
    }
    this.credentials = null;
    this.setState("closed");
  }

  /**
   * Drops the current socket's state without touching the credentials.
   *
   * Called before every attempt, so a reconnect starts from a clean slate
   * instead of inheriting a dead socket's pending requests.
   */
  private resetConnection(): void {
    const error = new Error("connection reset");
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
    for (const waiter of this.sessionWaiters) waiter.reject(error);
    this.sessionWaiters = [];
    this.eventHandlers.clear();
    // `sessionName` is deliberately kept: it is what the reconnect re-binds to.
    this.socket = null;
  }
}

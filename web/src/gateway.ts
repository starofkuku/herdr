// Browser client for the herdr web gateway.
//
// The gateway is a thin proxy over the public herdr JSON API. This module owns
// the WebSocket, authentication, session binding, request/response correlation,
// and subscription fan-out, so components work with plain promises.

export const PROTOCOL_VERSION = 2;

export interface SessionSummary {
  name: string;
  default: boolean;
  running: boolean;
}

export type ConnectionState = "connecting" | "authenticating" | "ready" | "closed" | "error";

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

  private pending = new Map<
    string,
    { resolve: (value: ApiEnvelope) => void; reject: (err: Error) => void }
  >();
  private eventHandlers = new Map<string, (payload: unknown) => void>();
  private sessionWaiters: { resolve: () => void; reject: (err: Error) => void }[] = [];

  constructor(handlers: GatewayHandlers) {
    this.handlers = handlers;
  }

  connect(url: string, key: string): void {
    this.reset();
    this.handlers.onState("connecting");

    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (err) {
      this.handlers.onState("error", `invalid server address: ${String(err)}`);
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      this.handlers.onState("authenticating");
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
    socket.onerror = () => this.handlers.onState("error", "connection failed");
    socket.onclose = () => {
      // Fail anything still waiting so callers do not hang forever.
      const error = new Error("connection closed");
      for (const { reject } of this.pending.values()) reject(error);
      this.pending.clear();
      for (const waiter of this.sessionWaiters) waiter.reject(error);
      this.sessionWaiters = [];
      this.socket = null;
      this.handlers.onState("closed");
    };
  }

  private dispatch(message: ServerMessage): void {
    switch (message.type) {
      case "hello":
        this.handlers.onState(message.authenticated ? "ready" : "authenticating");
        break;

      case "sessions":
        this.handlers.onSessions(message.items ?? []);
        break;

      case "session_ready":
        this.sessionName = message.name ?? null;
        for (const waiter of this.sessionWaiters) waiter.resolve();
        this.sessionWaiters = [];
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
        this.handlers.onState("error", message.message);
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

  /** Starts a subscription; `onEvent` receives each streamed payload. */
  subscribe(
    kinds: string[],
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
    this.send({
      type: "subscribe",
      id,
      subscriptions: kinds.map((kind) => ({ type: kind })),
    });

    return {
      close: () => {
        this.eventHandlers.delete(id);
        this.eventHandlers.delete(`${id}:closed`);
        this.send({ type: "unsubscribe", id });
      },
    };
  }

  close(): void {
    this.reset();
    if (this.socket) {
      this.socket.onclose = null;
      this.socket.close();
      this.socket = null;
    }
  }

  private reset(): void {
    const error = new Error("connection reset");
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
    for (const waiter of this.sessionWaiters) waiter.reject(error);
    this.sessionWaiters = [];
    this.eventHandlers.clear();
    this.sessionName = null;
  }
}

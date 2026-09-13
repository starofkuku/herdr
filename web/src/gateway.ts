// Browser-facing protocol client for the herdr web gateway.
//
// This mirrors src/web/protocol.rs. Keep PROTOCOL_VERSION in sync: the gateway
// rejects a mismatch rather than misbehaving.

export const PROTOCOL_VERSION = 1;

export interface SessionSummary {
  name: string;
  default: boolean;
  running: boolean;
}

export type ServerMessage =
  | { type: "hello"; protocol: number; authenticated: boolean }
  | { type: "sessions"; items: SessionSummary[] }
  | { type: "opened"; name: string }
  | { type: "frame"; seq: number; cols: number; rows: number; full: boolean; data: string }
  | { type: "closed"; reason: string | null }
  | { type: "mouse_mode"; enabled: boolean }
  | { type: "error"; message: string };

export type ConnectionState = "connecting" | "authenticating" | "ready" | "closed" | "error";

/** One rendered terminal frame from the gateway. */
export interface FramePayload {
  seq: number;
  cols: number;
  rows: number;
  full: boolean;
  bytes: Uint8Array;
}

export interface GatewayHandlers {
  onState: (state: ConnectionState, detail?: string) => void;
  onSessions: (items: SessionSummary[]) => void;
  onOpened: (name: string) => void;
  onFrame: (frame: FramePayload) => void;
  onClosed: (reason: string | null) => void;
  /** The server wants host mouse reporting enabled or disabled. */
  onMouseMode: (enabled: boolean) => void;
}

function base64ToBytes(input: string): Uint8Array {
  const binary = atob(input);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * One WebSocket connection to the gateway.
 *
 * The socket stays open across session attaches, so switching sessions does
 * not require re-authenticating.
 */
export class GatewayClient {
  private socket: WebSocket | null = null;
  private handlers: GatewayHandlers;
  private frameListener: ((frame: FramePayload) => void) | null = null;
  private mouseListener: ((enabled: boolean) => void) | null = null;
  private mouseEnabled = false;

  constructor(handlers: GatewayHandlers) {
    this.handlers = handlers;
  }

  /**
   * Replaces the terminal frame sink.
   *
   * Frames are delivered through a settable listener rather than the handlers
   * object so the terminal component can attach and detach as it mounts.
   */
  setFrameListener(listener: ((frame: FramePayload) => void) | null): void {
    this.frameListener = listener;
  }

  /**
   * Replaces the host mouse-reporting sink.
   *
   * The current mode is replayed immediately: the server only announces
   * changes, and a full-redraw frame resets the terminal (which clears mouse
   * tracking), so a late listener must be able to resync.
   */
  setMouseListener(listener: ((enabled: boolean) => void) | null): void {
    this.mouseListener = listener;
    if (listener) {
      listener(this.mouseEnabled);
    }
  }

  /** Current host mouse-reporting mode. */
  get mouseReporting(): boolean {
    return this.mouseEnabled;
  }

  connect(url: string, key: string): void {
    this.close();
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

    socket.onerror = () => {
      this.handlers.onState("error", "connection failed");
    };

    socket.onclose = () => {
      this.socket = null;
      this.handlers.onState("closed");
    };
  }

  private dispatch(message: ServerMessage): void {
    switch (message.type) {
      case "hello":
        if (message.authenticated) {
          this.handlers.onState("ready");
        } else {
          // The gateway sends an unauthenticated hello first; wait for the
          // result of our auth frame.
          this.handlers.onState("authenticating");
        }
        break;
      case "sessions":
        this.handlers.onSessions(message.items);
        break;
      case "opened":
        this.handlers.onOpened(message.name);
        break;
      case "frame": {
        const payload: FramePayload = {
          seq: message.seq,
          cols: message.cols,
          rows: message.rows,
          full: message.full,
          bytes: base64ToBytes(message.data),
        };
        this.frameListener?.(payload);
        this.handlers.onFrame(payload);
        break;
      }
      case "closed":
        this.handlers.onClosed(message.reason);
        break;
      case "mouse_mode":
        this.mouseEnabled = message.enabled;
        this.mouseListener?.(message.enabled);
        this.handlers.onMouseMode(message.enabled);
        break;
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

  listSessions(): void {
    this.send({ type: "sessions_list" });
  }

  openSession(name: string, cols: number, rows: number): void {
    this.send({ type: "session_open", name, cols, rows });
  }

  input(bytes: Uint8Array): void {
    this.send({ type: "input", data: bytesToBase64(bytes) });
  }

  resize(cols: number, rows: number): void {
    this.send({ type: "resize", cols, rows });
  }

  closeSession(): void {
    this.send({ type: "session_close" });
  }

  close(): void {
    if (this.socket) {
      this.socket.onclose = null;
      this.socket.close();
      this.socket = null;
    }
  }
}

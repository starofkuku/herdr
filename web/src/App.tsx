import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import {
  GatewayClient,
  type ConnectionState,
  type FramePayload,
  type SessionSummary,
} from "./gateway";
import { ConnectForm } from "./ConnectForm";
import { SessionPicker } from "./SessionPicker";
import { loadSettings, restoreTarget, saveSettings, type StoredSettings } from "./settings";

/** Narrowest viewport worth rendering; mirrors the gateway's floor. */
const MIN_COLS = 20;
const MIN_ROWS = 5;

/**
 * Mouse reporting modes the Herdr TUI relies on, matching what
 * crossterm's EnableMouseCapture sends to a real terminal:
 * 1000 normal tracking, 1002 button-motion tracking, 1006 SGR coordinates.
 */
const MOUSE_REPORTING_ON = "\x1b[?1000h\x1b[?1002h\x1b[?1006h";
const MOUSE_REPORTING_OFF = "\x1b[?1006l\x1b[?1002l\x1b[?1000l";

/** Provisional size used only until the terminal reports its real geometry. */
const PROVISIONAL_COLS = 80;
const PROVISIONAL_ROWS = 24;

type Phase = "connect" | "pick" | "terminal";

interface TerminalViewProps {
  client: GatewayClient;
  session: string;
  onLeave: () => void;
}

function TerminalView({ client, session, onLeave }: TerminalViewProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily:
        'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      scrollback: 5000,
      theme: { background: "#11111b", foreground: "#cdd6f4" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);

    let mouseOn = false;

    // Route frames into this terminal only while it is mounted.
    client.setFrameListener((frame: FramePayload) => {
      if (frame.full) {
        term.reset();
        // reset() clears DEC private modes, including mouse reporting, so
        // restore it or the terminal silently stops sending clicks.
        if (mouseOn) {
          term.write(MOUSE_REPORTING_ON);
        }
      }
      term.write(frame.bytes);
    });

    // Herdr's TUI is mouse-first, so the server asks the host to report mouse
    // events. Without this the terminal only ever sees keys.
    client.setMouseListener((enabled: boolean) => {
      mouseOn = enabled;
      term.write(enabled ? MOUSE_REPORTING_ON : MOUSE_REPORTING_OFF);
    });

    const sync = () => {
      try {
        fit.fit();
      } catch {
        return;
      }
      client.resize(Math.max(MIN_COLS, term.cols), Math.max(MIN_ROWS, term.rows));
    };

    const dataSub = term.onData((data) => {
      client.input(new TextEncoder().encode(data));
    });

    // xterm reports some mouse events (large coordinates and non-UTF-8
    // reports) through onBinary instead of onData, so both must be wired or
    // those events are dropped.
    const binarySub = term.onBinary((data) => {
      const bytes = new Uint8Array(data.length);
      for (let i = 0; i < data.length; i += 1) {
        bytes[i] = data.charCodeAt(i) & 0xff;
      }
      client.input(bytes);
    });

    // Fit once laid out so the server renders the real geometry, then track
    // viewport changes (including mobile keyboard and orientation).
    requestAnimationFrame(sync);
    const observer = new ResizeObserver(() => sync());
    observer.observe(host);
    const onOrientation = () => window.setTimeout(sync, 200);
    window.addEventListener("orientationchange", onOrientation);

    return () => {
      client.setFrameListener(null);
      client.setMouseListener(null);
      dataSub.dispose();
      binarySub.dispose();
      observer.disconnect();
      window.removeEventListener("orientationchange", onOrientation);
      term.dispose();
    };
  }, [client, session]);

  return (
    <div className="terminal-screen">
      <header className="topbar">
        <button type="button" className="ghost" onClick={onLeave}>
          ‹ sessions
        </button>
        <span className="session-name">{session}</span>
        <span className="topbar-spacer" />
      </header>
      <div className="terminal-host" ref={hostRef} />
    </div>
  );
}

export default function App() {
  const [phase, setPhase] = useState<Phase>("connect");
  const [state, setState] = useState<ConnectionState>("closed");
  const [detail, setDetail] = useState<string | undefined>();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeSession, setActiveSession] = useState<string | null>(null);
  const [settings, setSettings] = useState<StoredSettings>(() => loadSettings());
  const [keyDraft, setKeyDraft] = useState<string>("");

  const clientRef = useRef<GatewayClient | null>(null);
  const phaseRef = useRef<Phase>("connect");
  phaseRef.current = phase;

  // Session to reopen after the stored connection authenticates. Captured once
  // because later settings updates must not restart the restore.
  const restoreOnReadyRef = useRef<string | null>(null);
  const initialisedRef = useRef(false);
  if (!initialisedRef.current) {
    initialisedRef.current = true;
    const target = restoreTarget(settings);
    if (target) {
      restoreOnReadyRef.current = target;
      setActiveSession(target);
    }
  }

  if (!clientRef.current) {
    clientRef.current = new GatewayClient({
      onState: (next, message) => {
        setState(next);
        setDetail(message);
      },
      onSessions: (items) => {
        setSessions(items);
        // Only auto-advance from the connect screen. Returning to the picker
        // after a detach must not be undone by a refresh.
        if (phaseRef.current === "connect") {
          setPhase("pick");
        }
      },
      onOpened: (name) => {
        setActiveSession(name);
        setPhase("terminal");
        // Remember the choice so a refresh returns here, not to the picker.
        setSettings((current) => {
          const next = { ...current, session: name };
          saveSettings(next);
          return next;
        });
      },
      onFrame: () => {
        // Rendering is owned by TerminalView via the frame listener.
      },
      onMouseMode: () => {
        // Applied by TerminalView via the mouse listener.
      },
      onClosed: (reason) => {
        setActiveSession(null);
        setPhase("pick");
        if (reason) setDetail(reason);
      },
    });
  }

  const client = clientRef.current;

  // Reconnect automatically once, when a session was restored from storage.
  useEffect(() => {
    if (!restoreOnReadyRef.current) {
      return;
    }
    const key = settings.key ?? "";
    setKeyDraft(key);
    client.connect(settings.url, key);
    // Intentionally keyed on the client only: the restore target is captured
    // in a ref and must not re-run when settings change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  const connect = useCallback(
    (url: string, key: string, remember: boolean) => {
      const next: StoredSettings = {
        url,
        remember,
        key: remember ? key : undefined,
        // Connecting by hand starts at the picker, not a remembered session.
        session: undefined,
      };
      setSettings(next);
      setKeyDraft(key);
      saveSettings(next);
      client.connect(url, key);
    },
    [client],
  );

  const openSession = useCallback(
    (name: string) => {
      // The terminal corrects this on first layout; opening immediately keeps
      // the transition responsive.
      client.openSession(name, PROVISIONAL_COLS, PROVISIONAL_ROWS);
    },
    [client],
  );

  useEffect(() => {
    if (state !== "ready") {
      return;
    }
    // On a restored load, reopen the remembered session. A failed open reports
    // an error and leaves the picker visible.
    const target = restoreOnReadyRef.current;
    if (target) {
      restoreOnReadyRef.current = null;
      client.openSession(target, PROVISIONAL_COLS, PROVISIONAL_ROWS);
      return;
    }
    client.listSessions();
  }, [state, client]);

  useEffect(() => () => clientRef.current?.close(), []);

  if (phase === "connect") {
    return (
      <ConnectForm
        initialUrl={settings.url}
        initialKey={keyDraft || (settings.remember ? settings.key ?? "" : "")}
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
        onSelect={openSession}
        onRefresh={() => client.listSessions()}
        onDisconnect={() => {
          client.close();
          setPhase("connect");
        }}
      />
    );
  }

  return (
    <TerminalView
      client={client}
      session={activeSession ?? ""}
      onLeave={() => {
        client.closeSession();
        setActiveSession(null);
        // Leaving on purpose should not be undone by a refresh.
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

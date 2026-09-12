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
import { loadSettings, saveSettings, type StoredSettings } from "./settings";

/** Narrowest viewport worth rendering; mirrors the gateway's floor. */
const MIN_COLS = 20;
const MIN_ROWS = 5;

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

    // Route frames into this terminal only while it is mounted.
    client.setFrameListener((frame: FramePayload) => {
      if (frame.full) {
        term.reset();
      }
      term.write(frame.bytes);
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

    // Fit once laid out so the server renders the real geometry, then track
    // viewport changes (including mobile keyboard and orientation).
    requestAnimationFrame(sync);
    const observer = new ResizeObserver(() => sync());
    observer.observe(host);
    const onOrientation = () => window.setTimeout(sync, 200);
    window.addEventListener("orientationchange", onOrientation);

    return () => {
      client.setFrameListener(null);
      dataSub.dispose();
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
      },
      onFrame: () => {
        // Rendering is owned by TerminalView via the frame listener.
      },
      onClosed: (reason) => {
        setActiveSession(null);
        setPhase("pick");
        if (reason) setDetail(reason);
      },
    });
  }

  const client = clientRef.current;

  const connect = useCallback(
    (url: string, key: string, remember: boolean) => {
      const next: StoredSettings = { url, remember, key: remember ? key : undefined };
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
    if (state === "ready") {
      client.listSessions();
    }
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
        setPhase("pick");
      }}
    />
  );
}

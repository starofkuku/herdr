/*
 * A pane, drawn the way a terminal draws it.
 *
 * This is not a picture of the pane's screen — it is a terminal emulator fed the
 * same bytes the process wrote, so vim, htop, `less`, colours, the cursor, and
 * every key chord behave the way they do in a terminal application. Input goes back
 * as bytes too (`pane.send_text` writes them to the PTY unchanged), which is what
 * makes this usable rather than readable.
 *
 * A stream is not a screen. The stream only carries what happens next, so the screen
 * is read once to catch up — and read again whenever the stream is not continuous:
 * a dropped chunk, or a stream that restarted (a reconnect, which the gateway
 * announces as `subscription_started`). Either way the screen on screen is patched
 * by reading it again, never by guessing what was missed.
 */

import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { loadGeometry, loadScreen, sendInput, type TerminalGeometry } from "./terminal";

interface TerminalClient {
  call: <T>(method: string, params?: Record<string, unknown>) => Promise<T>;
  subscribe: (
    kinds: (string | Record<string, unknown>)[],
    onEvent: (payload: unknown) => void,
    onClosed?: (reason: string) => void,
  ) => { close: () => void };
}

/** Enough history for a build log, without holding a session in the tab. */
const SCROLLBACK_ROWS = 5000;

function decodeBase64(value: string): Uint8Array {
  const binary = window.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** Where the cursor belongs, as the escape a terminal understands. */
function cursorPlacement(geometry: TerminalGeometry): string {
  return `\u001b[${geometry.cursorY + 1};${geometry.cursorX + 1}H`;
}

/** The conversation's palette, so the terminal is not a differently coloured box. */
function terminalTheme(): {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
} {
  const styles = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
  return {
    background: read("--surface", "#262626"),
    foreground: read("--text", "#e5e5e5"),
    cursor: read("--text", "#e5e5e5"),
    selectionBackground: read("--surface-2", "#2f2f2f"),
  };
}

function terminalFont(): string {
  const styles = getComputedStyle(document.documentElement);
  return styles.getPropertyValue("--font-mono").trim() || "ui-monospace, monospace";
}

/** The payload of a subscription event, or null when it is not one. */
function terminalPayload(payload: unknown): { dataBase64: string; lost: boolean } | null {
  const envelope = payload as { event?: unknown; data?: unknown } | null;
  if (envelope?.event !== "pane.terminal_output") return null;
  const data = envelope.data as { data_base64?: unknown; lost?: unknown } | null;
  return {
    dataBase64: typeof data?.data_base64 === "string" ? data.data_base64 : "",
    lost: data?.lost === true,
  };
}

/** True for the frame the gateway sends when a subscription (re)starts. */
function isSubscriptionStarted(payload: unknown): boolean {
  const envelope = payload as { result?: { type?: unknown } } | null;
  return envelope?.result?.type === "subscription_started";
}

export function TerminalView({
  client,
  paneId,
  onClose,
}: {
  client: TerminalClient;
  paneId: string;
  onClose?: () => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<string | null>("正在读取终端…");
  const [fontSize, setFontSize] = useState(13);
  const [closing, setClosing] = useState(false);

  /*
   * Closing a shell is closing the pane: the process ends with it, and there is
   * nothing in it to keep. Leaving the screen afterwards is the app's call — the
   * route names this pane, which is about to stop existing.
   */
  const requestClose = async () => {
    if (closing || !onClose) return;
    setClosing(true);
    try {
      await client.call("pane.close", { pane_id: paneId });
      onClose();
    } catch (err: unknown) {
      setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setClosing(false);
    }
  };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let subscription: { close: () => void } | null = null;

    const terminal = new Terminal({
      // The server's stream may end mid-character or mid-escape, and xterm keeps
      // what it cannot use yet — which is why the bytes are written as bytes.
      convertEol: false,
      scrollback: SCROLLBACK_ROWS,
      fontFamily: terminalFont(),
      fontSize,
      theme: terminalTheme(),
      cursorBlink: true,
      allowProposedApi: true,
    });
    terminal.open(host);

    /*
     * Bytes that arrive while the screen is being read.
     *
     * The read is a round trip and the stream does not pause for it, so anything
     * that lands in between is held and written after the screen is, rather than
     * being drawn first and then wiped by the read that started before it.
     */
    let syncing = false;
    let held: Uint8Array[] = [];

    const write = (bytes: Uint8Array) => {
      if (syncing) held.push(bytes);
      else terminal.write(bytes);
    };

    /** Reads the screen again, and continues the stream from there. */
    const syncScreen = async () => {
      syncing = true;
      try {
        const [geometry, screen] = await Promise.all([
          loadGeometry(client, paneId),
          loadScreen(client, paneId),
        ]);
        if (disposed) return;
        if (geometry) terminal.resize(geometry.cols, geometry.rows);
        // Reset first: the read is the whole screen, and drawing it over what is
        // there would leave anything that had scrolled out of view behind.
        terminal.reset();
        terminal.write(screen);
        if (geometry?.cursorVisible) terminal.write(cursorPlacement(geometry));
        setStatus(null);
      } finally {
        const pending = held;
        held = [];
        syncing = false;
        for (const bytes of pending) terminal.write(bytes);
      }
    };

    const start = async () => {
      await syncScreen();
      if (disposed) return;
      subscription = client.subscribe(
        [{ type: "pane.terminal_output", pane_id: paneId }],
        (payload) => {
          /*
           * The stream is (re)starting, so whatever this terminal has drawn is no
           * longer the screen: a reconnect replays output from its own moment, and
           * a first subscribe replays nothing at all. Read the screen instead.
           */
          if (isSubscriptionStarted(payload)) {
            void syncScreen();
            return;
          }
          const event = terminalPayload(payload);
          if (!event) return;
          // The gap was the server's, not this client's: the stream it continued
          // from is the one that has to be re-read, which the event says.
          if (event.lost) {
            setStatus("正在重新同步…");
            void syncScreen();
            return;
          }
          if (event.dataBase64.length === 0) return;
          write(decodeBase64(event.dataBase64));
          setStatus((current) => (current === null ? current : null));
        },
        // The stream ending is not the pane ending: say so rather than sitting on a
        // screen that will never change again.
        (reason) => setStatus(`终端流已断开：${reason ?? "已关闭"}`),
      );
      terminal.focus();
    };

    void start();

    const onData = terminal.onData((data) => {
      void sendInput(client, paneId, data).catch((err: unknown) => {
        setStatus(err instanceof Error ? err.message : String(err));
      });
    });

    return () => {
      disposed = true;
      subscription?.close();
      onData.dispose();
      terminal.dispose();
    };
    // `fontSize` is a dependency so a change rebuilds the terminal: xterm's cell
    // metrics are fixed when it opens, and a resize in place would leave the grid
    // disagreeing with the glyphs.
  }, [client, paneId, fontSize]);

  return (
    <div className="terminal-view">
      <div className="terminal-view__bar">
        <span className="terminal-view__title">{paneId}</span>
        <span className="terminal-view__status">{status ?? ""}</span>
        <button
          type="button"
          className="ghost"
          title="字体小一点"
          aria-label="字体小一点"
          onClick={() => setFontSize((size) => Math.max(9, size - 1))}
        >
          A−
        </button>
        <button
          type="button"
          className="ghost"
          title="字体大一点"
          aria-label="字体大一点"
          onClick={() => setFontSize((size) => Math.min(20, size + 1))}
        >
          A+
        </button>
        {onClose ? (
          <button
            type="button"
            className="ghost"
            aria-label="关闭"
            title="关闭 pane（结束其中的 shell）"
            disabled={closing}
            onClick={() => void requestClose()}
          >
            {closing ? "正在关闭…" : "关闭"}
          </button>
        ) : null}
      </div>
      <div className="terminal-view__host" ref={hostRef} />
    </div>
  );
}

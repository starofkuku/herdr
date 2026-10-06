import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import {
  SERVER_LOAD_POLL_MS,
  formatBytes,
  formatCpu,
  formatUptime,
  loadServerLoad,
  type ServerLoad,
} from "./serverLoad";

/** The slice of the gateway client this component needs. */
interface LoadClient {
  call: <T>(method: string, params?: Record<string, unknown>) => Promise<T>;
}

/** Whether the reader left the bar's details showing. */
const OPEN_KEY = "herdr-web-server-load-open";

function readStoredOpen(): boolean {
  try {
    // Absent means never asked: the bar starts expanded, which is what it did
    // before it could be collapsed.
    return window.localStorage.getItem(OPEN_KEY) !== "0";
  } catch {
    return true;
  }
}

function storeOpen(open: boolean): void {
  try {
    window.localStorage.setItem(OPEN_KEY, open ? "1" : "0");
  } catch {
    // A browser that refuses storage still gets a working toggle.
  }
}

/**
 * The server's cost, as a strip across the top of the conversation.
 *
 * It answers the question a stalled session raises — whether herdr itself is
 * busy — without needing a shell on the machine. Every figure is a read of the
 * process serving this page, so it can never describe a different runtime than
 * the one the reader is looking at.
 *
 * The poll stops when the tab is hidden: a background page cannot be read, and
 * asking anyway would add to the load being reported. Collapsing hides the
 * figures but keeps reading, so reopening shows the current state rather than
 * the last one from before it was closed.
 */
export function ServerLoadBar({ client }: { client: LoadClient }) {
  const [load, setLoad] = useState<ServerLoad | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(readStoredOpen);

  useEffect(() => {
    let cancelled = false;

    const read = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const reading = await loadServerLoad(client);
        if (cancelled) return;
        setLoad(reading);
        setFailed(false);
      } catch {
        if (cancelled) return;
        setFailed(true);
      }
    };

    void read();
    const timer = window.setInterval(() => void read(), SERVER_LOAD_POLL_MS);
    // A tab returning to view should not wait out the rest of its interval.
    document.addEventListener("visibilitychange", read);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", read);
    };
  }, [client]);

  const toggle = () => {
    setOpen((previous) => {
      storeOpen(!previous);
      return !previous;
    });
  };

  const busy = load !== null && (load.phase !== "wait" || load.api_queue > 0);

  // Collapsed is only the control: no label, no figures, just something to tap to
  // bring the strip back. Anything shown beside it would be the strip again.
  if (!open) {
    return (
      <div className="server-load server-load--collapsed">
        <button
          type="button"
          className="server-load__toggle"
          onClick={toggle}
          aria-expanded={false}
          aria-label="展开服务负载"
          title="展开服务负载"
        >
          <ChevronDown size={14} />
        </button>
      </div>
    );
  }

  return (
    <div
      className={`server-load${failed && !load ? " server-load--failed" : ""}`}
      aria-label="服务器负载"
    >
      <button
        type="button"
        className="server-load__toggle"
        onClick={toggle}
        aria-expanded
        title="收起服务负载"
      >
        <span className="server-load__label">服务负载</span>
      </button>

      {load === null ? (
        <span className="server-load__value">{failed ? "不可用" : "…"}</span>
      ) : (
        <>
          <span className={`server-load__value${busy ? " server-load__value--busy" : ""}`}>
            {formatCpu(load.cpu_percent)}
          </span>
          <span className="server-load__sep">·</span>
          <span className="server-load__value" title="常驻内存">
            {formatBytes(load.rss_bytes)}
          </span>
          <span className="server-load__sep">·</span>
          <span className="server-load__value" title="线程 / 文件描述符">
            {load.threads} 线程 / {load.open_fds} fd
          </span>
          <span className="server-load__sep">·</span>
          <span
            className="server-load__value"
            title={`API ${load.api_connections} · 订阅 ${load.subscriptions} · 客户端 ${load.client_connections}`}
          >
            {load.api_connections} 连接
          </span>
          <span className="server-load__sep">·</span>
          <span className="server-load__value" title="主循环每秒迭代次数">
            {Math.round(load.loops_per_sec)}/s
          </span>
          {load.api_queue > 0 || load.max_api_queue > 0 ? (
            <>
              <span className="server-load__sep">·</span>
              <span
                className="server-load__value server-load__value--queue"
                title={`API 队列 ${load.api_queue}（窗口峰值 ${load.max_api_queue}）`}
              >
                队列 {load.api_queue}
              </span>
            </>
          ) : null}
          <span className="server-load__sep">·</span>
          <span className="server-load__value" title="进程运行时长">
            {formatUptime(load.uptime_sec)}
          </span>
          <span className="server-load__phase" title={`主循环阶段 ${load.phase}`}>
            {load.phase}
          </span>
        </>
      )}

      {/*
        The collapse control sits at the far right, away from the label: the
        figures run left to right, and a control wedged among them would move
        with every change in their width.
      */}
      <button
        type="button"
        className="server-load__toggle server-load__toggle--trailing"
        onClick={toggle}
        aria-expanded
        aria-label="收起服务负载"
        title="收起服务负载"
      >
        <ChevronUp size={13} />
      </button>
    </div>
  );
}

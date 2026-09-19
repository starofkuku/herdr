import type { ConnectionState } from "./gateway";

/**
 * Connection status, with a manual retry when the link is down.
 *
 * A phone browser suspends a backgrounded tab, which drops the socket; coming
 * back to the page would otherwise show a frozen view with no sign that nothing
 * is arriving. The dot is always present so "live" and "not live" are
 * distinguishable at a glance, and it becomes a button once the automatic
 * retries are not getting anywhere.
 */
export function ConnectionBadge({
  state,
  onRetry,
}: {
  state: ConnectionState;
  onRetry: () => void;
}) {
  const connected = state === "ready";
  const working = state === "connecting" || state === "authenticating" || state === "reconnecting";

  // A retry only makes sense once the client has given up on its own schedule.
  if (state === "closed" || state === "error") {
    return (
      <button type="button" className="conn conn--retry" onClick={onRetry} title="Reconnect">
        <span className="conn__dot" aria-hidden="true" />
        reconnect
      </button>
    );
  }

  const label = connected ? "connected" : working ? "reconnecting" : "disconnected";
  return (
    <span
      className={`conn conn--${connected ? "ok" : working ? "working" : "down"}`}
      role="status"
      aria-label={label}
      title={label}
    >
      <span className="conn__dot" aria-hidden="true" />
    </span>
  );
}

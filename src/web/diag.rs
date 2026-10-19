/*
 * Periodic resource log for the web path.
 *
 * The gateway (and, through the headless spawns, the session server) can run
 * for days. When it eventually misbehaves — threads climbing, connections
 * piling up, HTTP hanging — the interesting evidence is what the numbers did
 * on the way there, and that only exists if something was writing it down
 * before the trouble started. This thread is that record: every minute it
 * snapshots the process and logs a line when the picture changed, plus a
 * heartbeat line every five minutes even when nothing moved, so a stretch of
 * silence in the log means stability rather than a dead logger.
 *
 * Read it with:  grep web_diag <session dir>/herdr-web.log (gateway)
 *                grep web_diag <session dir>/herdr-server.log (session server)
 */

use std::sync::atomic::Ordering;

use tracing::{info, warn};

/// The event key every line carries, so the history greps out as a table.
const EVENT: &str = "web_diag";
/// How often to look for change.
const INTERVAL: std::time::Duration = std::time::Duration::from_secs(60);
/// How often to log a line even when nothing changed.
const HEARTBEAT: std::time::Duration = std::time::Duration::from_secs(300);

/// What the process holds right now.
struct Snapshot {
    threads: usize,
    fds: usize,
    /// Browser WebSocket connections (gateway process; 0 elsewhere).
    ws_clients: usize,
    /// Subscription streams this process is reading (gateway side).
    web_subs: usize,
    /// Subscription streams this process is serving (session server side).
    server_subs: u64,
}

impl Snapshot {
    fn take() -> Self {
        Self {
            threads: count_threads(),
            fds: count_fds(),
            ws_clients: super::WEB_CLIENTS.load(Ordering::Relaxed),
            web_subs: super::WEB_SUBSCRIPTIONS.load(Ordering::Relaxed),
            server_subs: crate::api::subscription_diagnostics::active_server_subscriptions(),
        }
    }

    fn same_shape(&self, other: &Self) -> bool {
        self.threads == other.threads
            && self.fds == other.fds
            && self.ws_clients == other.ws_clients
            && self.web_subs == other.web_subs
            && self.server_subs == other.server_subs
    }

    fn summary(&self) -> String {
        format!(
            "threads={} fds={} ws_clients={} web_subs={} server_subs={}",
            self.threads, self.fds, self.ws_clients, self.web_subs, self.server_subs
        )
    }
}

fn count_threads() -> usize {
    std::fs::read_dir("/proc/self/task")
        .map(|entries| entries.count())
        .unwrap_or(0)
}

fn count_fds() -> usize {
    std::fs::read_dir("/proc/self/fd")
        .map(|entries| entries.count())
        .unwrap_or(0)
}

/// Starts the diagnostic loop. Safe to call more than once: the thread checks
/// it is the only one before entering the loop.
pub(crate) fn spawn_web_diag_task() {
    STARTED.call_once(|| {
        if let Err(err) = std::thread::Builder::new()
            .name("web-diag".into())
            .spawn(diag_loop)
        {
            warn!(err = %err, "could not start the web diagnostic thread");
        }
    });
}

static STARTED: std::sync::Once = std::sync::Once::new();

fn diag_loop() {
    let mut last = Snapshot::take();
    info!(event = EVENT, kind = "baseline", "{}", last.summary());
    let mut since_heartbeat = std::time::Duration::ZERO;
    loop {
        std::thread::sleep(INTERVAL);
        since_heartbeat += INTERVAL;
        let now = Snapshot::take();
        if !now.same_shape(&last) {
            info!(
                event = EVENT,
                kind = "change",
                d_threads = (now.threads as isize - last.threads as isize) as i64,
                d_fds = (now.fds as isize - last.fds as isize) as i64,
                d_ws_clients = (now.ws_clients as isize - last.ws_clients as isize) as i64,
                d_web_subs = (now.web_subs as isize - last.web_subs as isize) as i64,
                d_server_subs = (now.server_subs as i64 - last.server_subs as i64),
                "{}",
                now.summary()
            );
        } else if since_heartbeat >= HEARTBEAT {
            info!(event = EVENT, kind = "heartbeat", "{}", now.summary());
            since_heartbeat = std::time::Duration::ZERO;
        }
        last = now;
    }
}

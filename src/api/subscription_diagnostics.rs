//! Lifecycle diagnostics only; counters never control subscription behavior.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Instant;

static SERVER_ACTIVE: AtomicUsize = AtomicUsize::new(0);
static GATEWAY_ACTIVE: AtomicUsize = AtomicUsize::new(0);

/// Live subscriptions this server is serving, for a client that displays the
/// server's cost.
///
/// Read from anywhere a connection thread may run: this is the atomic the RAII
/// guards below already maintain, and reading it never perturbs a subscription's
/// lifetime. The gateway's own count is deliberately not exposed here — it lives
/// in the gateway process, so this one cannot report it.
pub(crate) fn active_server_subscriptions() -> u64 {
    SERVER_ACTIVE.load(Ordering::Relaxed) as u64
}

pub(crate) struct SubscriptionDiagnostics {
    side: &'static str,
    active: &'static AtomicUsize,
    started: Instant,
    reason: &'static str,
    forwarded: usize,
    request_id: Option<String>,
}

impl SubscriptionDiagnostics {
    pub(crate) fn server(request_id: &str) -> Self {
        let mut diagnostics = Self::new("server", &SERVER_ACTIVE);
        diagnostics.request_id = Some(request_id.to_owned());
        diagnostics
    }

    pub(crate) fn gateway() -> Self {
        Self::new("gateway", &GATEWAY_ACTIVE)
    }

    fn new(side: &'static str, active: &'static AtomicUsize) -> Self {
        let count = active.fetch_add(1, Ordering::Relaxed) + 1;
        // The counters run regardless of the switch: `server.load` reports the
        // active subscription count, and that must not depend on log settings.
        if crate::server::diagnostics::logging_enabled() {
            tracing::debug!(side, active_subscriptions = count, "subscription opened");
            if count.is_multiple_of(32) {
                tracing::info!(
                    side,
                    active_subscriptions = count,
                    "subscription concurrency increased"
                );
            }
        }
        Self {
            side,
            active,
            started: Instant::now(),
            reason: "unwinding",
            forwarded: 0,
            request_id: None,
        }
    }

    pub(crate) fn reason(&mut self, reason: &'static str) {
        self.reason = reason;
    }

    pub(crate) fn forwarded(&mut self) {
        self.forwarded += 1;
    }
}

impl Drop for SubscriptionDiagnostics {
    fn drop(&mut self) {
        let active = self.active.fetch_sub(1, Ordering::Relaxed) - 1;
        if !crate::server::diagnostics::logging_enabled() {
            return;
        }
        tracing::info!(
            side = self.side,
            request_id = self.request_id.as_deref().unwrap_or(""),
            end_reason = if std::thread::panicking() {
                "unwinding"
            } else {
                self.reason
            },
            lifetime_ms = self.started.elapsed().as_millis() as u64,
            active_subscriptions = active,
            forwarded_lines = self.forwarded,
            "subscription ended"
        );
    }
}

//! Answers `server.load` from the process's own accounting.
//!
//! Served on the API path that does not enter the main loop, so asking for the
//! server's load never adds to it. Everything here is a read: nothing schedules,
//! retries, or cancels.

use serde_json::{json, Value};

use crate::api::schema::ServerLoad;

/// A sampler that survives across requests, so the second call can report a CPU
/// rate rather than another `None`.
static CPU: std::sync::Mutex<Option<crate::api::process_metrics::CpuSampler>> =
    std::sync::Mutex::new(None);

/// Reads the current load. Errors are returned as text: a caller displaying this
/// has nowhere better to put them.
fn read() -> Result<Value, String> {
    let pid = std::process::id();
    let (reading, cpu_percent) = {
        let mut guard = CPU
            .lock()
            .map_err(|_| "cpu sampler is unavailable".to_string())?;
        let sampler = guard.get_or_insert_with(Default::default);
        crate::api::process_metrics::ProcessReading::read(pid, sampler)
            .ok_or_else(|| "cannot read this process's accounting from /proc".to_string())?
    };

    // The gateway's own count lives in the gateway process, so it is not this
    // process's to report: only the streams served here are meaningful.
    let subscriptions = crate::api::subscription_diagnostics::active_server_subscriptions();
    let diagnostics = crate::server::diagnostics::load_snapshot();

    // The process-wide descriptor count is one number; the socket paths below
    // are the families of connection worth telling apart within it.
    let api_connections =
        crate::api::process_metrics::unix_socket_count(&crate::api::socket_path()).unwrap_or(0);
    let client_connections = crate::api::process_metrics::unix_socket_count(
        &crate::server::socket_paths::client_socket_path(),
    )
    .unwrap_or(0);

    let load = ServerLoad {
        pid,
        uptime_sec: reading.uptime_sec,
        cpu_percent,
        rss_bytes: reading.rss_bytes,
        threads: reading.threads,
        open_fds: reading.open_fds,
        subscriptions,
        api_connections,
        client_connections,
        api_queue: diagnostics.as_ref().map_or(0, |d| d.api_queue),
        max_api_queue: diagnostics.as_ref().map_or(0, |d| d.max_api_queue),
        client_queue: diagnostics.as_ref().map_or(0, |d| d.client_queue),
        loops_per_sec: diagnostics.as_ref().map_or(0.0, |d| d.loops_per_sec),
        phase: diagnostics
            .as_ref()
            .map_or_else(|| "unknown".to_string(), |d| d.phase.clone()),
        phase_ms: diagnostics.as_ref().map_or(0, |d| d.phase_ms),
        slowest_api: diagnostics
            .as_ref()
            .map_or_else(|| "-".to_string(), |d| d.slowest_api.clone()),
        slowest_api_ms: diagnostics.as_ref().map_or(0, |d| d.slowest_api_ms),
    };
    serde_json::to_value(load).map_err(|err| err.to_string())
}

/// Renders the load as a response line.
pub(super) fn response(id: String) -> String {
    match read() {
        Ok(load) => json!({"id": id, "result": load}).to_string(),
        Err(message) => {
            json!({"id": id, "error": {"code": "load_unavailable", "message": message}}).to_string()
        }
    }
}

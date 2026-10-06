use serde::{Deserialize, Serialize};

/// A point-in-time reading of the server process's own cost.
///
/// Every field describes the process that answers this request, so a client
/// showing it reports the runtime it is actually talking to rather than a
/// process it guessed at. Counts are instantaneous; `cpu_percent` is the only
/// rate, and it is measured between this call and the previous one.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct ServerLoad {
    pub pid: u32,
    /// Seconds since this process started, from its own start time.
    pub uptime_sec: u64,
    /// CPU used since the previous reading, as a percentage of one core.
    ///
    /// `None` on the first call in a process: a rate needs two samples, and
    /// reporting zero would read as an idle server.
    pub cpu_percent: Option<f64>,
    /// Resident set size in bytes.
    pub rss_bytes: u64,
    /// Threads in the process.
    pub threads: u64,
    /// Open file descriptors, which is what the connections below are made of.
    pub open_fds: u64,
    /// Live `events.subscribe` streams this server is serving.
    ///
    /// This is the number that moves when browsers attach and detach, so it is
    /// the one to watch for connection churn.
    pub subscriptions: u64,
    /// Connections on the API socket, which is what clients talk to.
    pub api_connections: u64,
    /// Connections on the client protocol socket, which is the TUI.
    pub client_connections: u64,
    /// Requests waiting in the API queue, and the deepest seen in the window.
    pub api_queue: u64,
    pub max_api_queue: u64,
    /// Client events waiting to be handled.
    pub client_queue: u64,
    /// Main-loop iterations per second over the last reporting window.
    pub loops_per_sec: f64,
    /// Where the main loop is, and how long it has been there.
    pub phase: String,
    pub phase_ms: u64,
    /// Slowest API method in the last window, and how long it took.
    pub slowest_api: String,
    pub slowest_api_ms: u64,
}

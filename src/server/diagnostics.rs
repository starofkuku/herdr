//! Progress observation only: never cancels requests or changes scheduling.
use std::collections::BTreeMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, OnceLock,
};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

static PROGRESS: OnceLock<Mutex<Progress>> = OnceLock::new();

/// Whether the recurring records are written at all.
///
/// Off unless `[advanced] diagnostic_logging` is on: these records explain a
/// stalled server after the fact, which is worth the log volume only while
/// something is being investigated. Kept as a process-wide switch rather than a
/// value passed down, because the writers are spread across the loop and the
/// subscription threads.
static ENABLED: AtomicBool = AtomicBool::new(false);

/// Turns the recurring records on. Called once, at server startup.
pub(crate) fn set_enabled(enabled: bool) {
    ENABLED.store(enabled, Ordering::Relaxed);
}

/// Whether the recurring records are being written.
///
/// Shared with the subscription lifecycle records, which belong to the same
/// switch: they are the other half of what an investigation needs.
pub(crate) fn logging_enabled() -> bool {
    enabled()
}

fn enabled() -> bool {
    ENABLED.load(Ordering::Relaxed)
}

#[derive(Clone)]
struct Progress {
    phase: &'static str,
    phase_since: Instant,
    method: &'static str,
    loop_since: Instant,
    loops: u64,
    /// When `loops` started counting, so a rate can be reported between resets.
    loops_window_started: Instant,
    methods: BTreeMap<&'static str, u64>,
    client_events: u64,
    api_queue: usize,
    client_queue: usize,
    max_api_queue: usize,
    slowest_method: &'static str,
    slowest_ms: u128,
}

impl Progress {
    fn new() -> Self {
        Self {
            phase: "startup",
            phase_since: Instant::now(),
            method: "-",
            loop_since: Instant::now(),
            loops: 0,
            loops_window_started: Instant::now(),
            methods: BTreeMap::new(),
            client_events: 0,
            api_queue: 0,
            client_queue: 0,
            max_api_queue: 0,
            slowest_method: "-",
            slowest_ms: 0,
        }
    }
}

fn update(f: impl FnOnce(&mut Progress)) {
    if let Some(state) = PROGRESS.get() {
        if let Ok(mut state) = state.lock() {
            f(&mut state);
        }
    }
}

pub(super) struct Monitor {
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

impl Drop for Monitor {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(worker) = self.worker.take() {
            worker.thread().unpark();
            let _ = worker.join();
        }
    }
}

pub(super) fn start() -> Monitor {
    PROGRESS.get_or_init(|| Mutex::new(Progress::new()));
    let stop = Arc::new(AtomicBool::new(false));
    let stopped = stop.clone();
    let worker = std::thread::spawn(move || observe(stopped));
    Monitor {
        stop,
        worker: Some(worker),
    }
}

fn observe(stopped: Arc<AtomicBool>) {
    let mut summary = Instant::now();
    let mut warning = Instant::now();
    let mut was_stalled = false;
    while !stopped.load(Ordering::Relaxed) {
        std::thread::park_timeout(Duration::from_secs(2));
        if stopped.load(Ordering::Relaxed) {
            break;
        }
        let emit_summary = summary.elapsed() >= Duration::from_secs(30);
        let Some(p) = snapshot(emit_summary) else {
            continue;
        };
        // The snapshot above keeps the counters current for `server.load` even
        // when the records are off; only the writing below is skipped.
        if !enabled() {
            continue;
        }
        let stalled = p.phase != "wait" && p.loop_since.elapsed() >= Duration::from_secs(5);
        if stalled && (!was_stalled || warning.elapsed() >= Duration::from_secs(6)) {
            tracing::warn!(
                event = "runtime.progress.delayed",
                phase = p.phase,
                method = p.method,
                loop_ms = p.loop_since.elapsed().as_millis() as u64,
                phase_ms = p.phase_since.elapsed().as_millis() as u64,
                api_queue_observed = p.api_queue,
                cli_queue_observed = p.client_queue,
                "server loop has not completed; diagnostic only, no automatic restart"
            );
            warning = Instant::now();
        } else if !stalled && was_stalled {
            tracing::info!(
                event = "runtime.progress.resumed",
                "server loop progress resumed"
            );
        }
        was_stalled = stalled;
        if emit_summary {
            log_summary(&p, summary.elapsed());
            summary = Instant::now();
        }
    }
}

fn snapshot(reset: bool) -> Option<Progress> {
    let mut result = None;
    update(|p| {
        result = Some(p.clone());
        if reset {
            p.loops = 0;
            p.loops_window_started = Instant::now();
            p.methods.clear();
            p.client_events = 0;
            p.max_api_queue = p.api_queue;
            p.slowest_ms = 0;
            p.slowest_method = "-";
        }
    });
    result
}

fn log_summary(p: &Progress, window: Duration) {
    tracing::info!(event = "runtime.progress.summary", window_ms = window.as_millis() as u64,
        phase = p.phase, method = p.method, loops = p.loops, api_methods = ?p.methods,
        cli_events = p.client_events, api_queue_observed = p.api_queue,
        cli_queue_observed = p.client_queue, max_api_queue = p.max_api_queue,
        slowest_api = p.slowest_method, slowest_api_ms = p.slowest_ms as u64,
        "server progress counters");
}

pub(super) fn tick(api_queue: usize, client_queue: usize) {
    update(|p| {
        p.loops += 1;
        p.loop_since = Instant::now();
        p.api_queue = api_queue;
        p.client_queue = client_queue;
        p.max_api_queue = p.max_api_queue.max(api_queue);
    });
    stage("maintenance");
}

pub(super) fn stage(name: &'static str) {
    update(|p| {
        p.phase = name;
        p.phase_since = Instant::now();
    });
}

// Idle time in select! is not processing time and must not trigger a stall warning.
pub(super) fn wake() {
    update(|p| p.loop_since = Instant::now());
    stage("event_dispatch");
}

pub(super) struct Scope {
    previous: Option<(&'static str, Instant, &'static str)>,
    started: Instant,
    request: Option<&'static str>,
}

pub(super) fn scope(name: &'static str) -> Scope {
    let mut previous = None;
    update(|p| {
        previous = Some((p.phase, p.phase_since, p.method));
        p.phase = name;
        p.phase_since = Instant::now();
    });
    Scope {
        previous,
        started: Instant::now(),
        request: None,
    }
}

pub(super) fn request(method: &'static str, api_queue: usize, client_queue: usize) -> Scope {
    let mut guard = scope("api.request");
    guard.request = Some(method);
    update(|p| {
        *p.methods.entry(method).or_default() += 1;
        p.method = method;
        p.api_queue = api_queue;
        p.client_queue = client_queue;
        p.max_api_queue = p.max_api_queue.max(api_queue);
    });
    guard
}

pub(super) fn client_event() {
    update(|p| p.client_events += 1);
}

/// A read of the counters above for a client that wants to display them.
///
/// Deliberately a copy rather than a live handle: the observer's own reset is
/// what keeps these counters meaningful, and a reader must never perturb it.
pub(crate) struct LoadSnapshot {
    pub api_queue: u64,
    pub max_api_queue: u64,
    pub client_queue: u64,
    pub loops_per_sec: f64,
    pub phase: String,
    pub phase_ms: u64,
    pub slowest_api: String,
    pub slowest_api_ms: u64,
}

/// Reads the counters without resetting them.
///
/// `None` before the server loop has started, which is the honest answer: there
/// is no main loop to report on yet.
pub(crate) fn load_snapshot() -> Option<LoadSnapshot> {
    let mut result = None;
    update(|p| {
        let window = p.loops_window_started.elapsed().as_secs_f64();
        result = Some(LoadSnapshot {
            api_queue: p.api_queue as u64,
            max_api_queue: p.max_api_queue as u64,
            client_queue: p.client_queue as u64,
            loops_per_sec: if window > 0.0 {
                p.loops as f64 / window
            } else {
                0.0
            },
            phase: p.phase.to_string(),
            phase_ms: p.phase_since.elapsed().as_millis() as u64,
            slowest_api: p.slowest_method.to_string(),
            slowest_api_ms: p.slowest_ms as u64,
        });
    });
    result
}

impl Drop for Scope {
    fn drop(&mut self) {
        if let Some((phase, since, method)) = self.previous {
            update(|p| {
                let elapsed = self.started.elapsed().as_millis();
                if let Some(request) = self.request {
                    if elapsed >= p.slowest_ms {
                        p.slowest_ms = elapsed;
                        p.slowest_method = request;
                    }
                }
                p.phase = phase;
                p.phase_since = since;
                p.method = method;
            });
        }
    }
}

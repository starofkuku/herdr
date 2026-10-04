//! Publishes the current request through the public runtime API.
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::mpsc;

use super::mapping::Pending;

pub(super) struct Pane {
    pub visible: Arc<Mutex<Option<Pending>>>,
    pub answers: mpsc::UnboundedReceiver<(String, Value)>,
    pub session: Arc<Mutex<Option<String>>>,
    stop: Arc<std::sync::atomic::AtomicBool>,
    worker: Option<std::thread::JoinHandle<()>>,
}

impl Pane {
    pub fn start(pane_id: String) -> Self {
        let visible = Arc::new(Mutex::new(None));
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (sender, answers) = mpsc::unbounded_channel();
        let state = visible.clone();
        let stopped = stop.clone();
        let session = Arc::new(Mutex::new(None));
        let session_state = session.clone();
        let worker =
            std::thread::spawn(move || run(pane_id, state, stopped, sender, session_state));
        Self {
            visible,
            answers,
            session,
            stop,
            worker: Some(worker),
        }
    }

    pub fn show(&self, pending: Option<Pending>) {
        if let Ok(mut visible) = self.visible.lock() {
            *visible = pending;
        }
    }
}

impl Drop for Pane {
    fn drop(&mut self) {
        self.stop.store(true, std::sync::atomic::Ordering::Relaxed);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

fn call(method: &str, params: Value) -> Option<Value> {
    let request =
        serde_json::from_value(json!({"id":"codex-bridge","method":method,"params":params}))
            .ok()?;
    let response = crate::api::client::ApiClient::local()
        .request_value_with_timeout(&request, Duration::from_millis(500));
    match response {
        Ok(value) if value.get("error").is_none() => Some(value["result"].clone()),
        other => {
            tracing::warn!(?other, "Codex bridge runtime API unavailable");
            None
        }
    }
}

fn clear(pane: &str, pending: &Pending) {
    call(
        "pane.clear_interaction",
        json!({"pane_id":pane,
        "source":pending.request["source"],"request_id":pending.key}),
    );
}

fn run(
    pane: String,
    state: Arc<Mutex<Option<Pending>>>,
    stop: Arc<std::sync::atomic::AtomicBool>,
    sender: mpsc::UnboundedSender<(String, Value)>,
    session: Arc<Mutex<Option<String>>>,
) {
    let mut previous: Option<Pending> = None;
    let mut published = std::time::Instant::now();
    let mut collected: Option<String> = None;
    let mut reported_session = None;
    while !stop.load(std::sync::atomic::Ordering::Relaxed) {
        report_session(&pane, &session, &mut reported_session);
        let current = state.lock().ok().and_then(|state| state.clone());
        clear_replaced(&pane, &current, &mut previous, &mut collected);
        if let Some(pending) = current {
            let result = call(
                "pane.take_interaction_answer",
                json!({"pane_id":pane,
                "source":pending.request["source"],"request_id":pending.key}),
            );
            if let Some(answers) = result
                .as_ref()
                .and_then(|r| r["answers"].as_array())
                .filter(|answers| !answers.is_empty())
            {
                collected = Some(pending.key.clone());
                let _ = sender.send((pending.key.clone(), json!(answers)));
            }
            if collected.as_ref() != Some(&pending.key)
                && (previous.is_none()
                    || published.elapsed() > Duration::from_secs(10)
                    || result.as_ref().is_some_and(|r| r["pending"] == false))
            {
                let mut request = pending.request.clone();
                request["pane_id"] = json!(pane);
                request["ttl_ms"] = json!(30_000);
                if call("pane.report_interaction", request).is_some() {
                    published = std::time::Instant::now();
                }
            }
            previous = Some(pending);
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    if let Some(old) = previous {
        clear(&pane, &old);
    }
}

fn report_session(
    pane: &str,
    session: &Mutex<Option<String>>,
    reported_session: &mut Option<String>,
) {
    let current_session = session.lock().ok().and_then(|value| value.clone());
    if current_session.is_some() && current_session != *reported_session {
        let seq = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|time| time.as_nanos() as u64)
            .unwrap_or_default();
        if call(
            "pane.report_agent_session",
            json!({"pane_id":pane,"source":"herdr:codex",
                "agent":"codex","agent_session_id":current_session,"seq":seq}),
        )
        .is_some()
        {
            *reported_session = current_session;
        }
    }
}

fn clear_replaced(
    pane: &str,
    current: &Option<Pending>,
    previous: &mut Option<Pending>,
    collected: &mut Option<String>,
) {
    if current.as_ref().map(|p| (&p.key, p.revision))
        != previous.as_ref().map(|p| (&p.key, p.revision))
    {
        if let Some(old) = previous.take() {
            clear(pane, &old);
        }
        *collected = None;
    }
}

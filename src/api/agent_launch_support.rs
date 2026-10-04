use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::agent_launch::failure;
use super::schema::{AgentLaunchParams, Method, Request};
use super::ApiRequestSender;

pub(super) fn call(
    tx: &ApiRequestSender,
    method: &str,
    params: Value,
    stage: &str,
    pane: Option<&str>,
) -> Result<Value, Value> {
    let method: Method = serde_json::from_value(json!({"method": method, "params": params}))
        .map_err(|e| failure("internal_error", stage, e, pane))?;
    // Mutations must not time out while still queued: that would hide a created pane.
    let raw = super::server::dispatch_to_app_with_timeout(
        Request {
            id: "agent-launch".into(),
            method,
        },
        tx,
        None,
    );
    let envelope: Value =
        serde_json::from_str(&raw).map_err(|e| failure("internal_error", stage, e, pane))?;
    if let Some(error) = envelope.get("error") {
        return Err(failure(
            error["code"].as_str().unwrap_or("launch_failed"),
            stage,
            error["message"].as_str().unwrap_or("request failed"),
            pane,
        ));
    }
    envelope
        .get("result")
        .cloned()
        .ok_or_else(|| failure("internal_error", stage, "missing response result", pane))
}

pub(super) fn validate(params: &AgentLaunchParams) -> Result<Vec<String>, Value> {
    let invalid = |message: &str| failure("invalid_params", "validate", message, None);
    let cwd = std::path::Path::new(&params.cwd);
    if !cwd.is_absolute() || !cwd.is_dir() {
        return Err(invalid("cwd must be an existing absolute directory"));
    }
    if let Some(name) = &params.name {
        if name.is_empty()
            || name.len() > 32
            || !name.starts_with(|c: char| c.is_ascii_lowercase())
            || !name
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
        {
            return Err(invalid("name must start with a lowercase letter and contain lowercase letters, digits, '-' or '_' (1-32 characters)"));
        }
    }
    let catalog = super::agent_catalog::catalog().map_err(|e| invalid(&e))?;
    let available = catalog["agents"].as_array().is_some_and(|agents| {
        agents
            .iter()
            .any(|a| a["kind"] == params.kind && a["available"] == true)
    });
    if !available {
        return Err(invalid(
            "agent kind is unsupported or its executable is unavailable",
        ));
    }
    match &params.session_id {
        Some(id) => super::agent_catalog::resolve_resume(&params.kind, &params.cwd, id)
            .map_err(|e| invalid(&e)),
        None => Ok(Vec::new()),
    }
}

pub(super) fn existing_session(params: &AgentLaunchParams, value: &Value) -> Option<Value> {
    let id = params.session_id.as_deref()?;
    value["agents"].as_array()?.iter().find_map(|agent| {
        if agent["agent"].as_str()? != params.kind { return None; }
        let reference = agent["agent_session"]["value"].as_str()?;
        let stem = std::path::Path::new(reference).file_stem().and_then(|p| p.to_str()).unwrap_or(reference);
        // Pi and Codex filenames prefix their native UUID with a timestamp.
        let matches = reference == id || stem == id || stem.strip_suffix(id).is_some_and(|prefix| prefix.ends_with('_') || prefix.ends_with('-'));
        matches.then(|| json!({"type":"agent_launched","pane_id":agent["pane_id"],"workspace_id":agent["workspace_id"],"existing":true}))
    })
}

pub(super) fn start(
    tx: &ApiRequestSender,
    pane: &str,
    name: &str,
    kind: &str,
    args: Vec<String>,
) -> Result<(), Value> {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let result = call(
            tx,
            "agent.start",
            json!({"pane_id":pane,"name":name,"kind":kind,"args":args}),
            "start",
            Some(pane),
        );
        match result {
            Ok(_) => return Ok(()),
            Err(error)
                if matches!(
                    error["code"].as_str(),
                    Some("agent_pane_busy" | "agent_pane_unavailable")
                ) && Instant::now() < deadline =>
            {
                // These errors precede every mutation in start_agent; retry only shell readiness.
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(error) => return Err(error),
        }
    }
}

pub(super) fn wait_ready(tx: &ApiRequestSender, pane: &str) -> Result<(), Value> {
    let deadline = Instant::now() + Duration::from_secs(35);
    loop {
        let result = call(tx, "agent.get", json!({"target":pane}), "ready", Some(pane))?;
        let agent = &result["agent"];
        if agent["interactive_ready"] == true {
            return Ok(());
        }
        if agent["launch_pending"] != true || Instant::now() >= deadline {
            return Err(failure("agent_not_ready", "ready", "agent did not reach interactive readiness; the created pane is available for inspection", Some(pane)));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

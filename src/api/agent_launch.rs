//! Server-side orchestration shared by every API client.
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use serde_json::{json, Value};

use super::agent_launch_support::{call, existing_session, start, validate, wait_ready};
use super::schema::AgentLaunchParams;
use super::ApiRequestSender;

struct Attempt {
    params: AgentLaunchParams,
    result: Result<Value, Value>,
}

// Never evict completed attempts: retrying an old key must not create a second pane.
static ATTEMPTS: OnceLock<Mutex<HashMap<String, Attempt>>> = OnceLock::new();

pub(super) fn read_response(id: String, result: Result<Value, String>) -> String {
    response(
        id,
        result.map_err(|message| failure("invalid_params", "read", message, None)),
    )
}

fn response(id: String, result: Result<Value, Value>) -> String {
    match result {
        Ok(result) => json!({"id": id, "result": result}).to_string(),
        Err(error) => json!({"id": id, "error": error}).to_string(),
    }
}

pub(super) fn failure(
    code: &str,
    stage: &str,
    message: impl ToString,
    pane: Option<&str>,
) -> Value {
    json!({"code": code, "message": message.to_string(), "stage": stage, "pane_id": pane})
}

pub(super) fn launch(id: String, params: AgentLaunchParams, tx: &ApiRequestSender) -> String {
    if params.request_id.is_empty() || params.request_id.len() > 128 {
        return response(
            id,
            Err(failure(
                "invalid_params",
                "validate",
                "request_id must contain 1-128 bytes",
                None,
            )),
        );
    }
    let Ok(mut attempts) = ATTEMPTS.get_or_init(Default::default).lock() else {
        return response(
            id,
            Err(failure(
                "internal_error",
                "validate",
                "launch registry unavailable",
                None,
            )),
        );
    };
    if let Some(attempt) = attempts.get(&params.request_id) {
        let result = if attempt.params == params {
            attempt.result.clone()
        } else {
            Err(failure(
                "request_id_conflict",
                "validate",
                "request_id was already used with different parameters",
                None,
            ))
        };
        return response(id, result);
    }
    if attempts.len() >= 4096 {
        return response(
            id,
            Err(failure(
                "launch_limit",
                "validate",
                "launch request registry is full; restart the server before creating more agents",
                None,
            )),
        );
    }
    let result = perform(&params, tx);
    attempts.insert(
        params.request_id.clone(),
        Attempt {
            params,
            result: result.clone(),
        },
    );
    response(id, result)
}

fn perform(params: &AgentLaunchParams, tx: &ApiRequestSender) -> Result<Value, Value> {
    let mut normalized = params.clone();
    normalized.cwd = super::agent_directories::normalize(&params.cwd)
        .map_err(|e| failure("invalid_params", "validate", e, None))?
        .to_string_lossy()
        .into_owned();
    let params = &normalized;
    let args = validate(params)?;
    let agents = call(tx, "agent.list", json!({}), "validate", None)?;
    if let Some(existing) = existing_session(params, &agents) {
        return Ok(existing);
    }
    if params.name.as_ref().is_some_and(|name| {
        agents["agents"]
            .as_array()
            .is_some_and(|agents| agents.iter().any(|a| a["name"].as_str() == Some(name)))
    }) {
        return Err(failure(
            "agent_name_taken",
            "validate",
            "agent name is already in use",
            None,
        ));
    }
    let name = launch_name(params, &agents);
    let created = create(params, tx)?;
    let pane = created["root_pane"]["pane_id"]
        .as_str()
        .ok_or_else(|| failure("internal_error", "create", "missing pane id", None))?;
    let workspace = created["tab"]["workspace_id"].as_str().ok_or_else(|| {
        failure(
            "internal_error",
            "create",
            "missing workspace id",
            Some(pane),
        )
    })?;
    let resume_path = (params.kind == "pi")
        .then(|| args.last().cloned())
        .flatten();
    start(tx, pane, &name, &params.kind, args)?;
    wait_ready(tx, pane)?;
    if let Some(session_id) = &params.session_id {
        // Seed the known resume identity only before any native hook report.
        // Native sequences are positive, so they always supersede this report.
        call(
            tx,
            "pane.report_agent_session",
            json!({"pane_id":pane,
            "source":format!("herdr:{}",params.kind),"agent":params.kind,
            "agent_session_id":session_id,"agent_session_path":resume_path,
            "session_start_source":"resume","seq":0}),
            "session",
            Some(pane),
        )?;
    }
    Ok(json!({"type":"agent_launched", "pane_id":pane, "workspace_id":workspace, "existing":false}))
}

fn launch_name(params: &AgentLaunchParams, agents: &Value) -> String {
    if let Some(name) = &params.name {
        return name.clone();
    }
    // Public pane IDs are case-sensitive; they are not valid agent names.
    // Launch orchestration holds the registry lock while allocating this name.
    let mut number = 1_u64;
    loop {
        let name = format!("{}-{number}", params.kind);
        if !agents["agents"].as_array().is_some_and(|agents| {
            agents
                .iter()
                .any(|agent| agent["name"].as_str() == Some(&name))
        }) {
            return name;
        }
        number += 1;
    }
}

fn create(params: &AgentLaunchParams, tx: &ApiRequestSender) -> Result<Value, Value> {
    match &params.workspace_id {
        Some(workspace) => call(
            tx,
            "tab.create",
            json!({"workspace_id":workspace,"cwd":params.cwd,"label":params.name,"focus":false}),
            "create",
            None,
        ),
        None => call(
            tx,
            "workspace.create",
            json!({"cwd":params.cwd,"label":params.project_label,"focus":false}),
            "create",
            None,
        ),
    }
}

use super::schema::{AgentSessionsParams, DirectoryListParams};
use serde_json::{json, Value};

pub(super) fn catalog() -> Result<Value, String> {
    let agents: Vec<_> = crate::detect::Agent::ALL.into_iter().map(|agent| {
        let kind = crate::detect::agent_label(agent);
        json!({"kind":kind,"label":kind,"available":crate::integration::command_available(crate::detect::interactive_agent_executable(agent)),"resumable":matches!(kind,"codex"|"claude"|"pi"|"zcode")})
    }).collect();
    Ok(
        json!({"type":"agent_catalog","agents":agents,"home":crate::integration::home_dir().ok().map(|p|p.to_string_lossy().into_owned())}),
    )
}

pub(super) fn directories(params: &DirectoryListParams) -> Result<Value, String> {
    super::agent_directories::list(params)
}

pub(super) fn sessions(params: &AgentSessionsParams) -> Result<Value, String> {
    let cwd = super::agent_directories::normalize(&params.cwd)?;
    let query = params.query.as_deref().unwrap_or("").to_lowercase();
    let mut entries = super::agent_history::list(&params.kind)?;
    entries.retain(|entry| {
        super::agent_directories::same_directory(&entry.cwd, &cwd)
            && (query.is_empty()
                || entry.title.to_lowercase().contains(&query)
                || entry.id.to_lowercase().contains(&query))
    });
    entries.sort_by(|a, b| {
        b.updated_at
            .cmp(&a.updated_at)
            .then_with(|| a.id.cmp(&b.id))
    });
    let start = params.cursor.unwrap_or(0).min(entries.len());
    let end = start
        .saturating_add(params.limit.unwrap_or(30).clamp(1, 100))
        .min(entries.len());
    Ok(
        json!({"type":"agent_sessions","sessions":entries[start..end],"next_cursor":(end<entries.len()).then_some(end)}),
    )
}

pub(super) fn resolve_resume(kind: &str, cwd: &str, id: &str) -> Result<Vec<String>, String> {
    let directory = super::agent_directories::normalize(cwd)?;
    let entry = super::agent_history::discover(kind)?
        .into_iter()
        .find(|entry| {
            entry.id == id && super::agent_directories::same_directory(&entry.cwd, &directory)
        })
        .ok_or("session does not exist for this agent and directory")?;
    let reference = if kind == "pi" {
        crate::agent_resume::AgentSessionRef::path(
            entry.path.as_deref().ok_or("session path is unavailable")?,
        )
    } else {
        crate::agent_resume::AgentSessionRef::id(&entry.id)
    }
    .ok_or("invalid native session reference")?;
    let plan = crate::agent_resume::plan(&format!("herdr:{kind}"), kind, &reference)
        .ok_or("agent resume is not supported")?;
    Ok(plan.argv.into_iter().skip(1).collect())
}

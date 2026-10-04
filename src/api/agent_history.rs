use super::schema::AgentHistoryEntry;
use codex_trace_parser::provider::Provider;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, UNIX_EPOCH};

type HistoryCache = HashMap<String, (Instant, Vec<AgentHistoryEntry>)>;
static CACHE: OnceLock<Mutex<HistoryCache>> = OnceLock::new();

/// Cache discovery independently of search/paging so keystrokes do not rescan logs.
pub(super) fn list(kind: &str) -> Result<Vec<AgentHistoryEntry>, String> {
    let mut cache = CACHE
        .get_or_init(Default::default)
        .lock()
        .map_err(|e| e.to_string())?;
    if let Some((at, entries)) = cache.get(kind) {
        if at.elapsed() < Duration::from_secs(10) {
            return Ok(entries.clone());
        }
    }
    let entries = discover(kind)?;
    cache.insert(kind.into(), (Instant::now(), entries.clone()));
    Ok(entries)
}

pub(super) fn discover(kind: &str) -> Result<Vec<AgentHistoryEntry>, String> {
    if kind == "zcode" {
        zcode_sessions()
    } else {
        file_sessions(kind)
    }
}

fn provider_root(provider: Provider) -> Result<PathBuf, String> {
    let override_dir = match provider {
        Provider::Codex => {
            std::env::var_os("CODEX_HOME").map(|p| PathBuf::from(p).join("sessions"))
        }
        Provider::Claude => {
            std::env::var_os("CLAUDE_CONFIG_DIR").map(|p| PathBuf::from(p).join("projects"))
        }
        Provider::Pi => {
            std::env::var_os("PI_CODING_AGENT_DIR").map(|p| PathBuf::from(p).join("sessions"))
        }
    };
    override_dir
        .or_else(|| provider.default_dir())
        .ok_or_else(|| "agent home directory is unavailable".into())
}

fn file_sessions(kind: &str) -> Result<Vec<AgentHistoryEntry>, String> {
    let provider =
        Provider::from_id(kind).ok_or("history discovery is not supported for this agent")?;
    let root = provider_root(provider)?;
    if !root.exists() {
        return Ok(Vec::new());
    }
    let sessions = match provider {
        Provider::Codex => codex_trace_parser::discover::discover_sessions(&root)?,
        _ => codex_trace_parser::chat::discover_chat_sessions(&root, provider)?,
    };
    Ok(sessions
        .into_iter()
        .filter(|s| !s.is_external_worker && !s.is_inline_worker && !s.is_archived)
        .filter_map(|s| {
            let cwd = s.cwd?;
            let modified = std::fs::metadata(&s.path)
                .ok()?
                .modified()
                .ok()?
                .duration_since(UNIX_EPOCH)
                .ok()?;
            let title = s
                .thread_name
                .or(s.ai_title)
                .or(s.last_user_message)
                .unwrap_or_else(|| s.id.clone());
            Some(AgentHistoryEntry {
                id: s.id,
                title: title.chars().take(180).collect(),
                cwd,
                updated_at: modified.as_millis().min(u64::MAX as u128) as u64,
                path: Some(s.path),
            })
        })
        .collect())
}

fn zcode_sessions() -> Result<Vec<AgentHistoryEntry>, String> {
    let path = crate::integration::zcode_session_db().map_err(|e| e.to_string())?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let connection =
        rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|e| e.to_string())?;
    connection
        .busy_timeout(Duration::from_secs(2))
        .map_err(|e| e.to_string())?;
    let mut statement = connection.prepare("SELECT id,title,directory,time_updated FROM session WHERE parent_id IS NULL AND time_archived IS NULL ORDER BY time_updated DESC,id").map_err(|e|e.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok(AgentHistoryEntry {
                id: row.get(0)?,
                title: row.get(1)?,
                cwd: row.get(2)?,
                updated_at: row.get::<_, i64>(3)?.max(0) as u64,
                path: None,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

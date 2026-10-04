use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use super::discover::CodexSessionInfo;

/// The agent whose session logs a file belongs to.
///
/// Sessions from every provider are normalised into the same CodexTurn/ToolCall
/// model; the provider id travels alongside so the UI can badge and group them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Codex,
    Claude,
    Pi,
}

impl Provider {
    pub const ALL: [Provider; 3] = [Provider::Codex, Provider::Claude, Provider::Pi];

    pub fn id(self) -> &'static str {
        match self {
            Provider::Codex => "codex",
            Provider::Claude => "claude",
            Provider::Pi => "pi",
        }
    }

    pub fn display_name(self) -> &'static str {
        match self {
            Provider::Codex => "Codex",
            Provider::Claude => "Claude Code",
            Provider::Pi => "Pi",
        }
    }

    pub fn from_id(id: &str) -> Option<Provider> {
        Provider::ALL.into_iter().find(|p| p.id() == id)
    }

    /// Standard on-disk log root for this provider.
    pub fn default_dir(self) -> Option<PathBuf> {
        dirs::home_dir().map(|home| match self {
            Provider::Codex => home.join(".codex").join("sessions"),
            Provider::Claude => home.join(".claude").join("projects"),
            Provider::Pi => home.join(".pi").join("agent").join("sessions"),
        })
    }

    /// Classify a session file by its location in the filesystem.
    ///
    /// Detection keys on the `<agent-home>/…` path shape (`.codex/sessions`,
    /// `.claude/projects`, `.pi/agent/sessions`) rather than filenames, since
    /// Claude Code and pi name session files by bare UUID. Unknown locations
    /// fall back to Codex, matching the historical single-provider behaviour.
    pub fn detect_from_path(path: &Path) -> Provider {
        let components: Vec<String> = path
            .components()
            .map(|c| c.as_os_str().to_string_lossy().to_string())
            .collect();
        let has_pair = |a: &str, b: &str| {
            components
                .windows(2)
                .any(|window| window[0] == a && window[1] == b)
        };
        let has_triple = |a: &str, b: &str, c: &str| {
            components
                .windows(3)
                .any(|window| window[0] == a && window[1] == b && window[2] == c)
        };
        if has_triple(".pi", "agent", "sessions") {
            return Provider::Pi;
        }
        if has_pair(".claude", "projects") {
            return Provider::Claude;
        }
        if has_pair(".codex", "sessions") {
            return Provider::Codex;
        }
        Provider::Codex
    }

    /// Does this path look like a main session transcript of this provider?
    ///
    /// Claude Code keeps per-session subagent transcripts under a `subagents/`
    /// directory; those are child conversations, not top-level sessions, so
    /// discovery skips them.
    pub fn is_session_file(self, path: &Path) -> bool {
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            return false;
        };
        match self {
            Provider::Codex => {
                if !name.starts_with("rollout-") {
                    return false;
                }
                // A plain file briefly coexists with its compressed copy while
                // Codex materialises it back for append; skip the duplicate.
                if let Some(plain) = name
                    .strip_suffix(".jsonl.zst")
                    .map(|base| format!("{base}.jsonl"))
                {
                    return !path.with_file_name(plain).exists();
                }
                name.ends_with(".jsonl")
            }
            Provider::Claude | Provider::Pi => {
                if !name.ends_with(".jsonl") {
                    return false;
                }
                !path
                    .components()
                    .any(|c| c.as_os_str().to_string_lossy() == "subagents")
            }
        }
    }
}

/// Standard chat-provider log roots that exist alongside the Codex root.
///
/// Used in production; tests inject their own roots (or none) for isolation.
pub fn default_chat_roots() -> Vec<(Provider, PathBuf)> {
    Provider::ALL
        .into_iter()
        .filter(|provider| !matches!(provider, Provider::Codex))
        .filter_map(|provider| provider.default_dir().map(|dir| (provider, dir)))
        .collect()
}

/// Filesystem roots to scan for each provider.
///
/// `configured_codex_dir` overrides the Codex root only (the historical
/// "sessions dir" setting); the chat roots carry the Claude Code and pi
/// locations.
pub fn session_roots(
    configured_codex_dir: Option<&str>,
    chat_roots: &[(Provider, PathBuf)],
) -> Vec<(Provider, PathBuf)> {
    let mut roots = Vec::new();
    let codex_root = configured_codex_dir
        .filter(|dir| !dir.trim().is_empty())
        .map(PathBuf::from)
        .or_else(|| Provider::Codex.default_dir());
    if let Some(root) = codex_root {
        roots.push((Provider::Codex, root));
    }
    roots.extend(chat_roots.iter().cloned());
    roots
}

/// Discover sessions across every provider root, merged newest-first.
pub fn discover_all(
    configured_codex_dir: Option<&str>,
    chat_roots: &[(Provider, PathBuf)],
) -> Vec<CodexSessionInfo> {
    let mut sessions = Vec::new();
    for (provider, root) in session_roots(configured_codex_dir, chat_roots) {
        let found = match provider {
            Provider::Codex => super::discover::discover_sessions(&root),
            _ => super::chat::discover_chat_sessions(&root, provider),
        };
        if let Ok(found) = found {
            sessions.extend(found);
        }
    }
    sessions.sort_by(|a, b| {
        b.start_time
            .cmp(&a.start_time)
            .then_with(|| b.last_activity_time.cmp(&a.last_activity_time))
    });
    sessions
}

/// Every live session file across all provider roots (for activity reconciliation).
pub fn collect_all_session_paths(
    configured_codex_dir: Option<&str>,
    chat_roots: &[(Provider, PathBuf)],
) -> HashSet<PathBuf> {
    let mut paths = HashSet::new();
    for (provider, root) in session_roots(configured_codex_dir, chat_roots) {
        collect_root_session_paths(&root, provider, &mut paths);
    }
    paths
}

fn collect_root_session_paths(dir: &Path, provider: Provider, paths: &mut HashSet<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_root_session_paths(&path, provider, &mut *paths);
            continue;
        }
        if provider.is_session_file(&path) {
            paths.insert(path);
        }
    }
}

/// Derive a `YYYY/MM/DD` group from a file's modification time.
///
/// Claude Code and pi name session files by UUID without embedding a date, so
/// the filesystem timestamp is the only grouping signal available.
pub fn date_group_from_mtime(path: &Path) -> String {
    let Ok(metadata) = fs::metadata(path) else {
        return String::new();
    };
    let Ok(modified) = metadata.modified() else {
        return String::new();
    };
    let chrono_time: chrono::DateTime<chrono::Local> = modified.into();
    chrono_time.format("%Y/%m/%d").to_string()
}

/// Extract the last user-authored message text from one raw JSONL line.
///
/// Used by the picker activity tracker to show the latest prompt without a
/// full session parse. Tool-result-only user lines (Claude Code) and tool
/// result events (pi) are not user-authored messages.
pub fn chat_user_message_from_line(provider: Provider, line: &str) -> Option<String> {
    let v: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return None,
    };
    let message = match provider {
        Provider::Claude => {
            if v.get("type").and_then(Value::as_str) != Some("user") {
                return None;
            }
            if v.get("isSidechain").and_then(Value::as_bool) == Some(true) {
                return None;
            }
            let content = v
                .get("message")
                .and_then(|m| m.get("content"))
                .unwrap_or(&Value::Null);
            let is_tool_result = match content {
                Value::Array(items) => {
                    !items.is_empty()
                        && items.iter().all(|item| {
                            item.get("type").and_then(Value::as_str) == Some("tool_result")
                        })
                }
                _ => false,
            };
            if is_tool_result {
                return None;
            }
            Some(chat_content_text(content))
        }
        Provider::Pi => {
            if v.get("type").and_then(Value::as_str) != Some("message") {
                return None;
            }
            let message = v.get("message").unwrap_or(&Value::Null);
            if message.get("role").and_then(Value::as_str) != Some("user") {
                return None;
            }
            Some(chat_content_text(
                message.get("content").unwrap_or(&Value::Null),
            ))
        }
        Provider::Codex => return None,
    }?;
    let trimmed = message.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

/// Flatten a chat message content field (string or typed block array) into text.
pub fn chat_content_text(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .filter_map(|item| {
                let block_type = item.get("type").and_then(Value::as_str)?;
                if matches!(block_type, "text" | "tool_result") {
                    item.get("text").and_then(Value::as_str).map(str::to_string)
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home() -> PathBuf {
        dirs::home_dir().expect("home dir in test env")
    }

    #[test]
    fn provider_ids_round_trip() {
        for provider in Provider::ALL {
            assert_eq!(Provider::from_id(provider.id()), Some(provider));
        }
        assert_eq!(Provider::from_id("other"), None);
    }

    #[test]
    fn display_names_are_human_readable() {
        assert_eq!(Provider::Codex.display_name(), "Codex");
        assert_eq!(Provider::Claude.display_name(), "Claude Code");
        assert_eq!(Provider::Pi.display_name(), "Pi");
    }

    #[test]
    fn detect_from_path_classifies_by_agent_home() {
        let home = home();
        let codex = home.join(".codex/sessions/2026/09/13/rollout-abc.jsonl");
        let claude = home.join(".claude/projects/-Users-me-proj/29433de8-uuid.jsonl");
        let pi = home.join(".pi/agent/sessions/--Users-me-proj/2026-id.jsonl");
        assert_eq!(Provider::detect_from_path(&codex), Provider::Codex);
        assert_eq!(Provider::detect_from_path(&claude), Provider::Claude);
        assert_eq!(Provider::detect_from_path(&pi), Provider::Pi);
        // Unknown locations fall back to Codex for backward compatibility.
        let custom = PathBuf::from("/tmp/custom-dir/rollout-x.jsonl");
        assert_eq!(Provider::detect_from_path(&custom), Provider::Codex);
    }

    #[test]
    fn is_session_file_filters_provider_layouts() {
        let codex_main = PathBuf::from("/h/.codex/sessions/2026/09/13/rollout-a.jsonl");
        let codex_other = PathBuf::from("/h/.codex/sessions/2026/09/13/history.jsonl");
        let claude_main = PathBuf::from("/h/.claude/projects/p/uuid.jsonl");
        let claude_sub = PathBuf::from("/h/.claude/projects/p/uuid/subagents/agent-a.jsonl");
        let pi_main = PathBuf::from("/h/.pi/agent/sessions/p/2026-id.jsonl");
        assert!(Provider::Codex.is_session_file(&codex_main));
        assert!(!Provider::Codex.is_session_file(&codex_other));
        assert!(Provider::Claude.is_session_file(&claude_main));
        assert!(!Provider::Claude.is_session_file(&claude_sub));
        assert!(Provider::Pi.is_session_file(&pi_main));
    }

    #[test]
    fn session_roots_override_only_codex() {
        let chat_roots = vec![(Provider::Claude, PathBuf::from("/tmp/claude-root"))];
        let roots = session_roots(Some("/tmp/custom-codex"), &chat_roots);
        assert_eq!(
            roots[0],
            (Provider::Codex, PathBuf::from("/tmp/custom-codex"))
        );
        assert_eq!(
            roots[1],
            (Provider::Claude, PathBuf::from("/tmp/claude-root"))
        );
        // An empty chat-root list keeps discovery scoped to the codex dir.
        let codex_only = session_roots(Some("/tmp/custom-codex"), &[]);
        assert_eq!(codex_only.len(), 1);
    }

    #[test]
    fn date_group_from_mtime_formats_ymd() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("s.jsonl");
        fs::write(&file, "{}\n").unwrap();
        let group = date_group_from_mtime(&file);
        assert_eq!(group.split('/').count(), 3);
        assert!(group.split('/').all(|part| !part.is_empty()));
    }

    #[test]
    fn chat_user_message_reads_claude_prompt_lines() {
        let line = r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"fix the bug"}]},"uuid":"u1"}"#;
        assert_eq!(
            chat_user_message_from_line(Provider::Claude, line).as_deref(),
            Some("fix the bug")
        );
        // Tool-result-only lines are not user-authored prompts.
        let tool_line = r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}"#;
        assert_eq!(
            chat_user_message_from_line(Provider::Claude, tool_line),
            None
        );
    }

    #[test]
    fn chat_user_message_reads_pi_prompt_lines() {
        let line = r#"{"type":"message","id":"m1","message":{"role":"user","content":[{"type":"text","text":"hello pi"}]}}"#;
        assert_eq!(
            chat_user_message_from_line(Provider::Pi, line).as_deref(),
            Some("hello pi")
        );
    }
}

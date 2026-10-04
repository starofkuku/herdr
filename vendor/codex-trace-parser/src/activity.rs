use std::collections::HashSet;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use super::chat::{ChatEvent, ChatStop};
use super::compression::resolve_rollout_path;
use super::discover::{scan_session_file, user_message_from_payload, CodexSessionInfo};
use super::entry::{event_msg_type, RawEntry};
use super::provider::Provider;

/// A session whose file has not been written recently cannot still be actively processing.
pub const ACTIVITY_STALE_AFTER: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileFingerprint {
    size: u64,
    modified: Option<SystemTime>,
}

impl FileFingerprint {
    fn from_metadata(metadata: &fs::Metadata) -> Self {
        Self {
            size: metadata.len(),
            modified: metadata.modified().ok(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActivitySnapshot {
    pub is_ongoing: bool,
    pub last_activity_time: String,
    pub file_size_bytes: u64,
    pub last_user_message: Option<String>,
}

/// Incremental activity-only parser for one rollout file.
///
/// The picker already performs a full metadata scan at startup. After that point this tracker
/// keeps only the event-state needed for `is_ongoing` and reads appended JSONL bytes, so a large
/// historical session is not reparsed on every filesystem notification.
pub struct ActivityTracker {
    requested_path: PathBuf,
    resolved_path: PathBuf,
    provider: Provider,
    parser_offset: u64,
    pending_line: String,
    turn_count: u32,
    has_session_end: bool,
    is_ongoing: bool,
    last_activity_time: String,
    last_user_message: Option<String>,
    fingerprint: FileFingerprint,
}

impl ActivityTracker {
    pub fn from_info(info: &CodexSessionInfo) -> Self {
        let requested_path = PathBuf::from(&info.path);
        let resolved_path =
            resolve_rollout_path(&requested_path).unwrap_or_else(|| requested_path.clone());
        let metadata = fs::metadata(&resolved_path).ok();
        let fingerprint = metadata
            .as_ref()
            .map(FileFingerprint::from_metadata)
            .unwrap_or(FileFingerprint {
                size: info.file_size_bytes,
                modified: None,
            });
        let parser_offset = metadata
            .as_ref()
            .map(|metadata| metadata.len())
            .unwrap_or(info.file_size_bytes);

        Self {
            requested_path,
            resolved_path,
            provider: Provider::from_id(&info.provider).unwrap_or(Provider::Codex),
            parser_offset,
            pending_line: String::new(),
            turn_count: info.turn_count,
            has_session_end: info.has_session_end,
            is_ongoing: info.is_ongoing,
            last_activity_time: info.last_activity_time.clone(),
            last_user_message: info.last_user_message.clone(),
            fingerprint,
        }
    }

    /// Load a new file once. New sessions are normally small; existing sessions use
    /// `from_info`, seeded by the initial picker scan, and never take this path for appends.
    pub fn load(path: &Path) -> Result<Self, String> {
        let scan_path = resolve_rollout_path(path).unwrap_or_else(|| path.to_path_buf());
        let provider = Provider::detect_from_path(path);
        let mut info = match provider {
            Provider::Codex => scan_session_file(&scan_path),
            _ => super::chat::scan_chat_session(&scan_path, provider),
        }
        .ok_or_else(|| format!("unable to scan session file: {}", path.display()))?;
        // Keep the requested path stable when a plain rollout has just been replaced by zstd.
        // The next refresh can then detect the replacement without changing the frontend key.
        info.path = path.to_string_lossy().to_string();
        Ok(Self::from_info(&info))
    }

    pub fn path(&self) -> &Path {
        &self.requested_path
    }

    pub fn fingerprint(&self) -> &FileFingerprint {
        &self.fingerprint
    }

    pub fn snapshot(&self) -> ActivitySnapshot {
        ActivitySnapshot {
            is_ongoing: self.is_ongoing,
            last_activity_time: self.last_activity_time.clone(),
            file_size_bytes: self.fingerprint.size,
            last_user_message: self.last_user_message.clone(),
        }
    }

    /// Set the state from the selected-session watcher without forcing a full activity parse.
    pub fn set_ongoing(&mut self, ongoing: bool) {
        self.is_ongoing = ongoing;
    }

    pub fn refresh(&mut self) -> Result<ActivitySnapshot, String> {
        let Some(resolved_path) = resolve_rollout_path(&self.requested_path) else {
            return Err(format!(
                "session file does not exist: {}",
                self.requested_path.display()
            ));
        };
        let metadata = fs::metadata(&resolved_path).map_err(|e| e.to_string())?;
        let fingerprint = FileFingerprint::from_metadata(&metadata);
        let path_changed = resolved_path != self.resolved_path;
        let is_zstd = resolved_path.extension().and_then(|ext| ext.to_str()) == Some("zst");

        if path_changed || fingerprint.size < self.parser_offset {
            return self.replace_from_disk();
        }

        // A plain file whose mtime changed without growing may have been replaced in place.
        // Rebuild only in that unusual case; normal Codex appends grow the file.
        if fingerprint.size == self.parser_offset {
            if fingerprint.modified != self.fingerprint.modified {
                return self.replace_from_disk();
            }
            self.fingerprint = fingerprint;
            self.apply_freshness();
            return Ok(self.snapshot());
        }

        if is_zstd {
            return self.replace_from_disk();
        }

        let mut file = fs::File::open(&resolved_path).map_err(|e| e.to_string())?;
        file.seek(SeekFrom::Start(self.parser_offset))
            .map_err(|e| e.to_string())?;
        let mut appended = String::new();
        file.read_to_string(&mut appended)
            .map_err(|e| e.to_string())?;

        self.parser_offset = fingerprint.size;
        self.resolved_path = resolved_path;
        self.fingerprint = fingerprint;

        let combined = if self.pending_line.is_empty() {
            appended
        } else {
            let mut pending = std::mem::take(&mut self.pending_line);
            pending.push_str(&appended);
            pending
        };
        let has_trailing_newline = combined.ends_with('\n');
        let mut lines: Vec<&str> = combined.split('\n').collect();
        let final_line = if has_trailing_newline {
            lines.pop();
            None
        } else {
            lines.pop()
        };

        for line in lines {
            self.process_line(line);
        }
        if let Some(line) = final_line {
            if line.is_empty() {
                return Ok(self.finish_refresh());
            }
            let parseable = match self.provider {
                Provider::Codex => RawEntry::parse(line).is_some(),
                // Chat lines carry plain JSON; a parseable object is complete.
                _ => serde_json::from_str::<serde_json::Value>(line).is_ok(),
            };
            if parseable {
                self.process_line(line);
            } else {
                self.pending_line = line.to_string();
            }
        }

        Ok(self.finish_refresh())
    }

    fn replace_from_disk(&mut self) -> Result<ActivitySnapshot, String> {
        let replacement = Self::load(&self.requested_path)?;
        let snapshot = replacement.snapshot();
        *self = replacement;
        Ok(snapshot)
    }

    fn process_line(&mut self, line: &str) {
        match self.provider {
            Provider::Codex => {
                let Some(entry) = RawEntry::parse(line) else {
                    return;
                };
                self.process_entry(&entry);
            }
            provider => self.process_chat_line(provider, line),
        }
    }

    /// Interpret one appended chat-provider line (Claude Code / pi) using the
    /// same adapters as the full parser, so activity stays consistent with
    /// what a session load would show.
    fn process_chat_line(&mut self, provider: Provider, line: &str) {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            return;
        };
        if let Some(timestamp) = value.get("timestamp").and_then(|t| t.as_str()) {
            self.last_activity_time = timestamp.to_string();
        }
        if let Some(message) = super::provider::chat_user_message_from_line(provider, line) {
            self.last_user_message = Some(message);
        }
        for event in super::chat::adapter_for(provider).adapt(&value) {
            match event {
                ChatEvent::User { .. } => {
                    self.turn_count += 1;
                    self.is_ongoing = true;
                }
                ChatEvent::Assistant { stop, .. } => {
                    // The provider's stop reason decides: `tool_use` means more is
                    // coming, anything terminal means this turn is done. Without
                    // one, an assistant line still means the session is alive.
                    self.is_ongoing = stop.is_none() || stop == Some(ChatStop::ToolUse);
                }
                ChatEvent::ToolResult { .. } => {
                    // Deliberately does not close the turn: returning a tool result
                    // only means the model can continue, and it routinely reads the
                    // result, thinks, and answers afterwards. Closing here was why
                    // a running Claude Code or pi session never showed as running —
                    // its file sits on a tool result most of the time. A run that
                    // really did stop is cleared by the staleness check below.
                }
                ChatEvent::Ignored
                | ChatEvent::Meta { .. }
                | ChatEvent::ModelChange { .. }
                | ChatEvent::Title { .. } => {}
            }
        }
    }

    fn process_entry(&mut self, entry: &RawEntry) {
        if let Some(timestamp) = entry.timestamp.as_deref().filter(|value| !value.is_empty()) {
            self.last_activity_time = timestamp.to_string();
        }
        if let Some(message) = user_message_from_payload(&entry.entry_type, &entry.payload) {
            self.last_user_message = Some(message);
        }

        match entry.entry_type.as_str() {
            "session_end" => {
                self.has_session_end = true;
                self.is_ongoing = false;
            }
            "event_msg" => match event_msg_type(&entry.payload) {
                Some("task_started") => {
                    self.turn_count += 1;
                    if !self.has_session_end {
                        self.is_ongoing = true;
                    }
                }
                Some("user_message") if self.turn_count == 0 => {
                    self.turn_count += 1;
                    if !self.has_session_end {
                        self.is_ongoing = true;
                    }
                }
                Some("task_complete")
                | Some("turn_aborted")
                | Some("token_budget_abort")
                | Some("inference_stream_cancelled") => {
                    self.is_ongoing = false;
                }
                _ => {}
            },
            _ => {}
        }
    }

    fn finish_refresh(&mut self) -> ActivitySnapshot {
        self.apply_freshness();
        self.snapshot()
    }

    fn apply_freshness(&mut self) {
        if !self.is_ongoing || self.has_session_end {
            return;
        }
        if let Some(modified) = self.fingerprint.modified {
            if SystemTime::now()
                .duration_since(modified)
                .map(|age| age > ACTIVITY_STALE_AFTER)
                .unwrap_or(false)
            {
                self.is_ongoing = false;
            }
        }
    }
}

/// Enumerate rollout paths without opening the files. This is used by the periodic reconciliation
/// pass, so its cost is proportional to directory metadata rather than transcript size.
pub fn collect_session_paths(sessions_dir: &Path) -> HashSet<PathBuf> {
    let mut paths = HashSet::new();
    collect_session_paths_inner(sessions_dir, &mut paths);
    paths
}

fn collect_session_paths_inner(dir: &Path, paths: &mut HashSet<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_session_paths_inner(&path, paths);
            continue;
        }

        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("");
        if !name.starts_with("rollout-") {
            continue;
        }

        if let Some(plain_name) = name
            .strip_suffix(".jsonl.zst")
            .map(|base| format!("{base}.jsonl"))
        {
            if path.with_file_name(plain_name).exists() {
                continue;
            }
        } else if !name.ends_with(".jsonl") {
            continue;
        }

        if path.is_file() {
            paths.insert(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::OpenOptions;
    use std::io::Write;

    fn session_prefix() -> String {
        r#"{"timestamp":"2026-08-18T12:00:00Z","type":"session_meta","payload":{"id":"activity-test","timestamp":"2026-08-18T12:00:00Z"}}
{"timestamp":"2026-08-18T12:00:01Z","type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1"}}
"#
        .to_string()
    }

    #[test]
    fn refresh_reads_only_appended_terminal_event() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rollout-activity.jsonl");
        std::fs::write(&path, session_prefix()).unwrap();

        let mut tracker = ActivityTracker::load(&path).unwrap();
        assert!(tracker.snapshot().is_ongoing);
        let initial_size = tracker.snapshot().file_size_bytes;

        let mut file = OpenOptions::new().append(true).open(&path).unwrap();
        writeln!(
            file,
            r#"{{"timestamp":"2026-08-18T12:00:02Z","type":"event_msg","payload":{{"type":"task_complete"}}}}"#
        )
        .unwrap();

        let snapshot = tracker.refresh().unwrap();
        assert!(!snapshot.is_ongoing);
        assert_eq!(snapshot.last_activity_time, "2026-08-18T12:00:02Z");
        assert!(snapshot.file_size_bytes > initial_size);
    }

    #[test]
    fn refresh_captures_an_appended_user_message() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rollout-user-message.jsonl");
        std::fs::write(&path, session_prefix()).unwrap();
        let mut tracker = ActivityTracker::load(&path).unwrap();

        let mut file = OpenOptions::new().append(true).open(&path).unwrap();
        writeln!(
            file,
            r#"{{"timestamp":"2026-08-18T12:00:02Z","type":"event_msg","payload":{{"type":"item_completed","item":{{"type":"UserMessage","content":[{{"type":"text","text":"Newest request"}}]}}}}}}"#
        )
        .unwrap();

        let snapshot = tracker.refresh().unwrap();
        assert_eq!(
            snapshot.last_user_message.as_deref(),
            Some("Newest request")
        );
    }

    #[test]
    fn collect_session_paths_ignores_non_rollouts_and_duplicate_compressed_files() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("notes.jsonl"), "ignored").unwrap();
        std::fs::write(dir.path().join("rollout-one.jsonl"), session_prefix()).unwrap();
        std::fs::write(dir.path().join("rollout-one.jsonl.zst"), "ignored").unwrap();

        let paths = collect_session_paths(dir.path());
        assert_eq!(paths.len(), 1);
        assert!(paths.contains(&dir.path().join("rollout-one.jsonl")));
    }

    /// Chat-provider tracker over a Claude transcript whose head is a tool call
    /// still open, with `last_line` appended — the shape a live session is in most
    /// of the time. The tempdir is returned so the file outlives the tracker, and
    /// the path keeps its `.claude/projects` layout because provider detection
    /// reads it back off the path.
    fn claude_tracker(last_line: &str) -> (tempfile::TempDir, ActivityTracker) {
        use std::io::Write;
        let dir = tempfile::tempdir().unwrap();
        let session_dir = dir.path().join(".claude/projects/-tmp-proj");
        std::fs::create_dir_all(&session_dir).unwrap();
        let path = session_dir.join("29433de8-live.jsonl");
        let head = concat!(
            r#"{"type":"user","message":{"role":"user","content":"check the tests"},"uuid":"u-1","timestamp":"2026-07-11T18:05:06Z","sessionId":"s1"}"#,
            "\n",
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu-9","name":"Bash","input":{"command":"cargo test"}}],"stop_reason":"tool_use","usage":{"input_tokens":10,"output_tokens":5}},"uuid":"a-1","timestamp":"2026-07-11T18:05:10Z"}"#,
            "\n"
        );
        std::fs::write(&path, head).unwrap();
        let mut tracker = ActivityTracker::load(&path).unwrap();
        let mut file = OpenOptions::new().append(true).open(&path).unwrap();
        writeln!(file, "{last_line}").unwrap();
        drop(file);
        tracker.refresh().unwrap();
        (dir, tracker)
    }

    #[test]
    fn a_returned_tool_result_does_not_end_a_chat_turn() {
        // Before this, `pending_tool_calls` hitting zero cleared `is_ongoing`, so a
        // running Claude Code or pi session never showed as running: its file sits
        // on a tool result while the model reads it and composes its answer.
        let (_dir, tracker) = claude_tracker(
            r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu-9","content":[{"type":"text","text":"ok"}]}]},"uuid":"u-2","timestamp":"2026-07-11T18:05:11Z"}"#,
        );
        assert!(tracker.snapshot().is_ongoing);
    }

    #[test]
    fn a_terminal_stop_reason_ends_a_chat_turn() {
        let (_dir, tracker) = claude_tracker(
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Done."}],"stop_reason":"end_turn","usage":{"input_tokens":10,"output_tokens":5}},"uuid":"a-2","timestamp":"2026-07-11T18:05:20Z"}"#,
        );
        assert!(!tracker.snapshot().is_ongoing);
    }

    #[test]
    fn a_tool_use_stop_reason_keeps_a_chat_turn_running() {
        let (_dir, tracker) = claude_tracker(
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu-10","name":"Bash","input":{"command":"ls"}}],"stop_reason":"tool_use","usage":{"input_tokens":10,"output_tokens":5}},"uuid":"a-3","timestamp":"2026-07-11T18:05:20Z"}"#,
        );
        assert!(tracker.snapshot().is_ongoing);
    }
}

//! ZCode's conversation, read from the store ZCode keeps it in.
//!
//! Every other agent herdr renders a transcript for writes one JSON lines file
//! per session and `codex-trace-parser` reads it. ZCode does not: its sessions
//! live in a single SQLite database, and the only JSONL it writes is a model-I/O
//! diagnostic log that is truncated on rotation, so it cannot stand in for a
//! transcript. This module is therefore the one place herdr reads an agent's
//! conversation itself rather than through the parser.
//!
//! Two things are deliberately not done here. Nothing is ever written — the
//! database is opened read-only, so a bug here cannot damage a user's sessions —
//! and nothing is inferred: the projection below is ZCode's own rule
//! (`getConversationMessageProjectionPolicy` and `projectSessionTranscript` in
//! its `packages/shared` and `apps/zcode-cli` trees), restated so that hidden
//! runtime traffic like todo reminders does not surface as conversation.

use std::path::Path;
use std::time::Duration;

use rusqlite::{Connection, OpenFlags};
use serde_json::Value;

use crate::api::schema::{
    PaneSessionMessage, PaneSessionPagination, PaneSessionToolCall, PaneSessionTurn,
};

/// How long to wait for a lock before giving up.
///
/// The writer is ZCode itself, and its transactions are short; a read that has
/// to wait longer than this is better reported than waited on, because the
/// caller falls back to the pane's rendered text.
const BUSY_TIMEOUT_MS: u64 = 2_000;

/// Rough bytes per message, used to turn the caller's byte budget into a row
/// limit. Only a hint: `pane.session` caps by bytes for a file, but rows are the
/// unit a database pages in.
const BYTES_PER_MESSAGE: usize = 400;

/// Bounds on that conversion, so a strange budget cannot ask for the whole
/// session or for a single row.
const MIN_MESSAGES: usize = 40;
const MAX_MESSAGES: usize = 600;

/// The database ZCode keeps its sessions in.
///
/// `None` when there is no home directory to resolve against; a missing file is
/// left to the caller to notice, so that "no store" and "empty store" stay
/// distinguishable.
pub(crate) fn database_path() -> Option<std::path::PathBuf> {
    crate::integration::zcode_session_db().ok()
}

/// One page of a session's conversation.
pub(crate) struct ZcodeSessionPage {
    pub(crate) cwd: Option<String>,
    pub(crate) turns: Vec<PaneSessionTurn>,
    pub(crate) pagination: PaneSessionPagination,
}

/// A message row, before its parts are read.
struct MessageRow {
    id: String,
    sequence: i64,
    data: Value,
}

/// Reads one page of a session, newest first.
///
/// `cursor` is the sequence of the oldest message the caller already has; the
/// page returned ends just before it. `max_bytes` is the caller's budget, turned
/// into a row count because a database pages by rows.
pub(crate) fn read_session(
    db: &Path,
    session_id: &str,
    cursor: Option<u64>,
    max_bytes: Option<usize>,
) -> Result<ZcodeSessionPage, String> {
    let connection = Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|err| format!("zcode store: {err}"))?;
    connection
        .busy_timeout(Duration::from_millis(BUSY_TIMEOUT_MS))
        .map_err(|err| format!("zcode store: {err}"))?;

    let cwd = session_directory(&connection, session_id);
    let limit = message_limit(max_bytes);
    let (rows, has_more) = read_page(&connection, session_id, cursor, limit)?;
    // The cursor is the oldest row the page touched, taken before any filtering:
    // a page whose messages were all runtime traffic would otherwise report no
    // cursor and be fetched again forever.
    let next_cursor = rows.iter().map(|row| row.sequence as u64).min();
    let total_turns = count_turns(&connection, session_id);
    let turns = build_turns(&connection, rows)?;

    Ok(ZcodeSessionPage {
        cwd,
        pagination: PaneSessionPagination {
            next_cursor: if has_more { next_cursor } else { None },
            has_more,
            total_turns,
        },
        turns,
    })
}

/// The working directory this session ran in, for the header.
fn session_directory(connection: &Connection, session_id: &str) -> Option<String> {
    connection
        .query_row(
            "SELECT directory FROM session WHERE id = ?1",
            [session_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .ok()
        .flatten()
        .filter(|value| !value.is_empty())
}

/// How many turns the session holds in total, for the caller's paging display.
///
/// A turn begins with a user message, so counting the user messages that are not
/// hidden counts the turns — the visibility test is the same one the projection
/// applies, expressed in SQL so the whole session does not have to be read.
fn count_turns(connection: &Connection, session_id: &str) -> u64 {
    connection
        .query_row(
            "SELECT COUNT(*) FROM message \
             WHERE session_id = ?1 \
               AND json_extract(data, '$.role') = 'user' \
               AND json_extract(data, '$.semantics.transcriptVisibility') IS NOT 'hidden' \
               AND json_extract(data, '$.summary') IS NULL",
            [session_id],
            |row| row.get::<_, i64>(0),
        )
        .map(|count| count.max(0) as u64)
        .unwrap_or(0)
}

/// The row budget for one page.
fn message_limit(max_bytes: Option<usize>) -> usize {
    match max_bytes {
        Some(bytes) => (bytes / BYTES_PER_MESSAGE).clamp(MIN_MESSAGES, MAX_MESSAGES),
        None => MAX_MESSAGES,
    }
}

/// Reads up to `limit` messages, newest first, and says whether earlier ones remain.
///
/// The ordering is ZCode's own (`sequence is null, sequence, time_created,
/// rowid`); its `sequence` was added by a migration and backfilled, so rows
/// written before it are ordered by the fields that predate it.
fn read_page(
    connection: &Connection,
    session_id: &str,
    cursor: Option<u64>,
    limit: usize,
) -> Result<(Vec<MessageRow>, bool), String> {
    let mut statement = connection
        .prepare(
            "SELECT id, sequence, data FROM message \
             WHERE session_id = ?1 AND sequence IS NOT NULL AND (?2 IS NULL OR sequence < ?2) \
             ORDER BY sequence DESC LIMIT ?3",
        )
        .map_err(|err| format!("zcode store: {err}"))?;
    let cursor_value = cursor.map(|value| value as i64);
    // One extra row answers "is there an earlier page" without a second query.
    let rows = statement
        .query_map(
            rusqlite::params![session_id, cursor_value, (limit + 1) as i64],
            |row| {
                let raw: String = row.get(2)?;
                Ok(MessageRow {
                    id: row.get(0)?,
                    sequence: row.get(1)?,
                    data: serde_json::from_str(&raw).unwrap_or(Value::Null),
                })
            },
        )
        .map_err(|err| format!("zcode store: {err}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("zcode store: {err}"))?;

    let has_more = rows.len() > limit;
    let mut kept = rows;
    kept.truncate(limit);
    // Oldest first, which is the order the conversation reads in.
    kept.reverse();
    Ok((kept, has_more))
}

/// Turns a page of messages into turns, reading each message's parts.
fn build_turns(
    connection: &Connection,
    rows: Vec<MessageRow>,
) -> Result<Vec<PaneSessionTurn>, String> {
    let mut turns: Vec<PaneSessionTurn> = Vec::new();
    for row in rows {
        if !is_transcript_message(&row.data) {
            continue;
        }
        let parts = read_parts(connection, &row.id)?;
        match role_of(&row.data) {
            Some("user") => turns.push(new_turn(&row, &parts)),
            Some("assistant") => {
                match turns.last_mut() {
                    // An assistant message with no user message before it is a
                    // session that began mid-turn; it starts its own.
                    Some(turn) => append_assistant(turn, &row, &parts),
                    None => turns.push(new_turn(&row, &parts)),
                };
            }
            _ => {}
        }
    }
    Ok(turns)
}

/// One message's parts, in ZCode's own order.
fn read_parts(connection: &Connection, message_id: &str) -> Result<Vec<Value>, String> {
    let mut statement = connection
        .prepare(
            "SELECT data FROM part WHERE message_id = ?1 \
             ORDER BY sequence IS NULL, sequence, time_created, id",
        )
        .map_err(|err| format!("zcode store: {err}"))?;
    let parts = statement
        .query_map([message_id], |row| {
            let raw: String = row.get(0)?;
            Ok(serde_json::from_str(&raw).unwrap_or(Value::Null))
        })
        .map_err(|err| format!("zcode store: {err}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("zcode store: {err}"))?;
    Ok(parts)
}

/// ZCode's own rule for what belongs in a transcript.
///
/// Restated from `getConversationMessageProjectionPolicy`: a hidden message is
/// runtime traffic rather than conversation, a summary is the compaction
/// stand-in for history that is still present, and a model-only message was
/// never shown to anyone.
fn is_transcript_message(data: &Value) -> bool {
    if data.get("summary").is_some_and(|value| !value.is_null()) {
        return false;
    }
    let semantics = data.get("semantics");
    let field = |name: &str| {
        semantics
            .and_then(|value| value.get(name))
            .and_then(Value::as_str)
    };
    if field("transcriptVisibility") == Some("hidden") {
        return false;
    }
    if let Some(kind) = field("kind") {
        if kind == "compact_summary" || kind == "timeline_event" || kind == "fork_notice" {
            return false;
        }
    }
    match role_of(data) {
        // A user message is real when someone typed it: not synthesized, and not
        // one of the runtime's own nudges.
        Some("user") => {
            data.get("synthetic") != Some(&Value::Bool(true))
                && field("origin") != Some("agent_runtime")
                && data.get("visibility").and_then(Value::as_str) != Some("model-only")
        }
        Some("assistant") => field("kind") == Some("assistant_response"),
        _ => false,
    }
}

fn role_of(data: &Value) -> Option<&str> {
    data.get("role").and_then(Value::as_str)
}

/// Timestamps are milliseconds since the epoch; the wire carries seconds.
fn seconds(value: Option<&Value>) -> Option<u64> {
    value
        .and_then(Value::as_i64)
        .filter(|ms| *ms > 0)
        .map(|ms| (ms / 1000) as u64)
}

/// Starts a turn from a user message, or from the first assistant message when
/// the session began mid-turn.
fn new_turn(row: &MessageRow, parts: &[Value]) -> PaneSessionTurn {
    let is_user = role_of(&row.data) == Some("user");
    let created = seconds(row.data.get("time").and_then(|time| time.get("created")));
    let completed = seconds(row.data.get("time").and_then(|time| time.get("completed")));
    let text = if is_user {
        user_text(parts)
    } else {
        String::new()
    };
    let mut turn = PaneSessionTurn {
        // The sequence is the cursor the next page resumes from, and it is the
        // only per-message number that is stable in this store.
        turn_id: row.sequence.to_string(),
        started_at: created,
        completed_at: completed,
        duration_ms: match (created, completed) {
            (Some(start), Some(end)) if end >= start => Some((end - start) * 1000),
            _ => None,
        },
        status: "completed".to_string(),
        user_message: if text.is_empty() { None } else { Some(text) },
        agent_messages: Vec::new(),
        tool_calls: Vec::new(),
        final_answer: None,
        model: row
            .data
            .get("modelId")
            .and_then(Value::as_str)
            .map(str::to_string),
        error: None,
        aborted_reason: None,
    };
    if !is_user {
        append_assistant(&mut turn, row, parts);
    }
    turn
}

/// Adds one assistant message's text, reasoning, and tool calls to a turn.
///
/// Every item carries the position of its part in the message, which is what
/// lets a client interleave the reply with the calls that produced it instead of
/// stacking all the calls at the end.
fn append_assistant(turn: &mut PaneSessionTurn, row: &MessageRow, parts: &[Value]) {
    let completed = seconds(row.data.get("time").and_then(|time| time.get("completed")));
    if completed.is_some() {
        turn.completed_at = completed;
    }
    if let Some(error) = row.data.get("error").and_then(Value::as_str) {
        turn.error = Some(error.to_string());
        turn.status = "error".to_string();
    }

    for (index, part) in parts.iter().enumerate() {
        match part.get("type").and_then(Value::as_str) {
            Some("text") => {
                if let Some(text) = part.get("text").and_then(Value::as_str) {
                    if !text.is_empty() {
                        turn.agent_messages.push(PaneSessionMessage {
                            text: text.to_string(),
                            is_reasoning: false,
                            timestamp: None,
                            order: index,
                        });
                        turn.final_answer = Some(text.to_string());
                    }
                }
            }
            Some("reasoning") => {
                if let Some(text) = part.get("text").and_then(Value::as_str) {
                    if !text.is_empty() {
                        turn.agent_messages.push(PaneSessionMessage {
                            text: text.to_string(),
                            is_reasoning: true,
                            timestamp: None,
                            order: index,
                        });
                    }
                }
            }
            Some("tool") => {
                turn.tool_calls.push(tool_call(part, index));
            }
            _ => {}
        }
    }
}

/// One tool call, as ZCode recorded it.
fn tool_call(part: &Value, order: usize) -> PaneSessionToolCall {
    let state = part.get("state");
    let input = state.and_then(|value| value.get("input"));
    let status = state
        .and_then(|value| value.get("status"))
        .and_then(Value::as_str);
    let output = state
        .and_then(|value| value.get("output"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let error = state
        .and_then(|value| value.get("error"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let name = part.get("tool").and_then(Value::as_str).unwrap_or_default();

    PaneSessionToolCall {
        call_id: part
            .get("callID")
            .and_then(Value::as_str)
            .map(str::to_string),
        // ZCode names its tools in its own vocabulary; the wire carries the name
        // and lets the client pick the glyph and the label.
        kind: Some(name.to_string()),
        name: Some(name.to_string()),
        arguments: input.cloned(),
        // The client renders an edit from the call's own text; for ZCode that is
        // the tool's input, which it already has as structured arguments.
        input: None,
        output: output.or(error.clone()),
        path: tool_path(input),
        added: None,
        removed: None,
        failed: Some(status == Some("error") || error.is_some()),
        order,
    }
}

/// The file a call names, when it names one.
///
/// ZCode's tools spell the path differently by tool: edits use `file_path`, and
/// a shell command may mention several, so only an unambiguous single-file
/// argument is taken as the row's subject.
fn tool_path(input: Option<&Value>) -> Option<String> {
    let object = input?.as_object()?;
    for key in ["file_path", "filePath", "path", "target_file"] {
        if let Some(value) = object.get(key).and_then(Value::as_str) {
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

/// What a user message said.
///
/// Text parts are the message; an attachment or a chosen agent is recorded as a
/// part of its own, and both are shown, because a reader scrolling back needs to
/// see that a file was sent even though the file is not there any more.
fn user_text(parts: &[Value]) -> String {
    let mut chunks: Vec<String> = Vec::new();
    for part in parts {
        match part.get("type").and_then(Value::as_str) {
            Some("text") => {
                if part.get("ignored") == Some(&Value::Bool(true)) {
                    continue;
                }
                if let Some(text) = part.get("text").and_then(Value::as_str) {
                    if !text.is_empty() {
                        chunks.push(text.to_string());
                    }
                }
            }
            Some("file") => {
                let name = part
                    .get("filename")
                    .or_else(|| part.get("url"))
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                chunks.push(format!("[Attached file: {name}]"));
            }
            Some("agent") => {
                let name = part.get("name").and_then(Value::as_str).unwrap_or_default();
                chunks.push(format!("[Selected agent: {name}]"));
            }
            _ => {}
        }
    }
    chunks.join("\n\n")
}

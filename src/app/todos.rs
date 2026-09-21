//! The agent's own todo list, read out of its transcript.
//!
//! pi's `rpiv-todo` extension records the whole task list on every `todo` tool
//! call, in the tool result's `details` envelope, and the newest record is the
//! current state. The transcript parser behind `pane.session` deliberately
//! exposes a stable subset of its own types and does not carry that envelope
//! through, so the list is read here from the raw JSONL instead.
//!
//! The record alone is not what the agent shows. `rpiv-todo` puts a task away as
//! soon as the turn it was finished in ends: at the start of the next turn every
//! task that is already finished is hidden, and the overlay disappears once
//! nothing is left. Reporting the raw record instead would keep showing a list
//! the agent itself has already put away.
//!
//! Sessions reach tens of megabytes and the newest record sits at the end, so
//! the file is read backwards rather than parsed whole. The window grows instead
//! of being fixed because a single record can outgrow one chunk: the leading
//! fragment of any window that does not start at the start of the file is
//! discarded, and a wider window is guaranteed to cover that line in full.

use std::collections::HashSet;
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::Path;

/// One task in the agent's list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Todo {
    pub(crate) id: u64,
    pub(crate) subject: String,
    pub(crate) status: String,
}

/// Bytes in the first backwards window, and the largest one worth trying.
const WINDOW_START: u64 = 64 * 1024;
const WINDOW_MAX: u64 = 8 * 1024 * 1024;

/// Reads the todo list the agent is currently showing for itself.
///
/// `Ok(None)` means the transcript holds no todo record at all, which is the
/// normal case for an agent that has never used the tool. `Ok(Some(empty))`
/// means every task has been put away, which is the state the overlay hides
/// itself in.
pub(crate) fn read(path: &Path) -> io::Result<Option<Vec<Todo>>> {
    let mut file = File::open(path)?;
    let len = file.metadata()?.len();
    let mut window = WINDOW_START;

    loop {
        let start = len.saturating_sub(window);
        file.seek(SeekFrom::Start(start))?;
        let mut bytes = Vec::with_capacity((len - start) as usize);
        file.read_to_end(&mut bytes)?;
        let text = String::from_utf8_lossy(&bytes);

        let mut lines: Vec<&str> = text.split('\n').collect();
        if start > 0 {
            // The window begins mid-line, so its first fragment is only the tail
            // of a record that started earlier. A wider window covers it whole.
            lines.remove(0);
        }

        let Scan {
            records,
            turn_start,
        } = scan(&lines);
        let exhausted = start == 0 || window >= WINDOW_MAX;

        let Some((newest_at, newest)) = records.first() else {
            if exhausted {
                return Ok(None);
            }
            window = (window * 4).min(WINDOW_MAX);
            continue;
        };

        // Which tasks are put away depends on where this turn began, so the
        // window is grown until the boundary is in reach rather than guessed at.
        let Some(turn_start) = turn_start else {
            if exhausted {
                return Ok(Some(newest.clone()));
            }
            window = (window * 4).min(WINDOW_MAX);
            continue;
        };

        let hidden = hidden_tasks(&records, *newest_at, turn_start);
        return Ok(Some(
            newest
                .iter()
                .filter(|todo| !hidden.contains(&todo.id))
                .cloned()
                .collect(),
        ));
    }
}

/// Reads one window's records and its turn boundary.
struct Scan {
    /// Todo records in the window, newest first, with their line indices.
    records: Vec<(usize, Vec<Todo>)>,
    /// Line index of the newest user turn, when the window reaches one.
    turn_start: Option<usize>,
}

/// One pass over a window, collecting every record and the newest turn start.
///
/// Records and turn starts interleave, and a turn can write its list several
/// times, so which record describes the start of the turn is not known until
/// both indices are: the caller resolves that with `hidden_tasks`.
fn scan(lines: &[&str]) -> Scan {
    let mut records = Vec::new();
    let mut turn_start = None;

    for (index, line) in lines.iter().enumerate().rev() {
        if let Some(todos) = tasks_from_line(line) {
            records.push((index, todos));
        } else if turn_start.is_none() && is_user_turn(line) {
            turn_start = Some(index);
        }
    }

    Scan {
        records,
        turn_start,
    }
}

/// The ids the agent's overlay is already hiding.
///
/// A record written before this turn began is the list as the turn found it, so
/// every task already finished in it belongs to a turn that has ended. When the
/// newest record is itself older than the turn, the turn has not written yet
/// and that record is the one the boundary reads.
fn hidden_tasks(
    records: &[(usize, Vec<Todo>)],
    newest_at: usize,
    turn_start: usize,
) -> HashSet<u64> {
    let boundary = if newest_at < turn_start {
        records.first()
    } else {
        records.iter().find(|(index, _)| *index < turn_start)
    };

    match boundary {
        Some((_, todos)) => todos
            .iter()
            .filter(|todo| todo.status == "completed")
            .map(|todo| todo.id)
            .collect(),
        None => HashSet::new(),
    }
}

/// True when the line is the user's own turn rather than an injected record.
///
/// Tool results and hook output also arrive as user messages; those carry a
/// `<`-prefixed wrapper, so plain text is what marks a turn.
fn is_user_turn(line: &str) -> bool {
    if !line.contains("\"user\"") {
        return false;
    }
    let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
        return false;
    };

    let message = value.get("message");
    if message.and_then(|m| m.get("role")).and_then(|r| r.as_str()) != Some("user") {
        return false;
    }

    match message.and_then(|m| m.get("content")) {
        Some(serde_json::Value::String(text)) => is_user_text(text),
        Some(serde_json::Value::Array(parts)) => parts.iter().any(|part| {
            part.get("type").and_then(|t| t.as_str()) == Some("text")
                && part
                    .get("text")
                    .and_then(|t| t.as_str())
                    .is_some_and(is_user_text)
        }),
        _ => false,
    }
}

/// True when the text is something the user typed rather than injected context.
fn is_user_text(text: &str) -> bool {
    let trimmed = text.trim_start();
    !trimmed.is_empty() && !trimmed.starts_with('<')
}

/// The task list one transcript line carries, when it carries one.
///
/// The envelope hangs off `message.details`. Only a todo tool result has it, so
/// the shape is what decides — the substring check is just there to skip the
/// parse for the great majority of lines, which are unrelated records.
fn tasks_from_line(line: &str) -> Option<Vec<Todo>> {
    if !line.contains("\"tasks\"") {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(line).ok()?;
    let tasks = value
        .get("message")?
        .get("details")?
        .get("tasks")?
        .as_array()?;
    Some(tasks.iter().filter_map(task).collect())
}

fn task(value: &serde_json::Value) -> Option<Todo> {
    Some(Todo {
        id: value.get("id")?.as_u64()?,
        subject: value.get("subject")?.as_str()?.to_string(),
        status: value.get("status")?.as_str()?.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// Writes `lines` to a throwaway transcript and returns its path.
    ///
    /// The test removes the file. `tempfile` is not a dependency of this crate
    /// and the reader only ever needs a path to open.
    fn scratch(name: &str, lines: &[String]) -> std::path::PathBuf {
        let path =
            std::env::temp_dir().join(format!("herdr-todo-read-{name}-{}", std::process::id()));
        let mut file = File::create(&path).expect("create scratch transcript");
        for line in lines {
            writeln!(file, "{line}").expect("write scratch transcript");
        }
        path
    }

    /// One todo tool result, shaped the way pi records it.
    fn todo_line(tasks: &str) -> String {
        format!(
            r#"{{"type":"message","message":{{"role":"toolResult","toolName":"todo","content":[{{"type":"text","text":"ok"}}],"details":{{"action":"update","tasks":{tasks},"nextId":9}}}}}}"#
        )
    }

    fn subject_line() -> String {
        r#"{"type":"message","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}"#
            .to_string()
    }

    #[test]
    fn reads_the_task_list_from_a_record() {
        let path = scratch(
            "basic",
            &[
                subject_line(),
                todo_line(
                    r#"[{"id":1,"subject":"do a thing","status":"pending","description":"d","activeForm":"a"}]"#,
                ),
            ],
        );
        let todos = read(&path).expect("read").expect("a record");
        assert_eq!(
            todos,
            vec![Todo {
                id: 1,
                subject: "do a thing".into(),
                status: "pending".into(),
            }]
        );
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn the_newest_record_wins() {
        // The transcript ends on the record, so the turn is still open and the
        // newest record is the live one.
        let path = scratch(
            "newest",
            &[
                todo_line(r#"[{"id":1,"subject":"old","status":"pending"}]"#),
                subject_line(),
                todo_line(r#"[{"id":1,"subject":"new","status":"completed"}]"#),
            ],
        );
        let todos = read(&path).expect("read").expect("a record");
        assert_eq!(todos[0].subject, "new");
        assert_eq!(todos[0].status, "completed");
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn a_task_finished_in_an_ended_turn_is_put_away() {
        // The observed bug: every task was finished, the turn closed and the
        // overlay went with it, but the raw record still listed the work.
        let path = scratch(
            "put-away",
            &[
                subject_line(),
                todo_line(r#"[{"id":1,"subject":"done","status":"completed"}]"#),
                subject_line(),
            ],
        );
        let todos = read(&path).expect("read").expect("a record");
        assert!(todos.is_empty(), "a finished turn leaves nothing shown");
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn a_task_finished_during_this_turn_is_still_shown() {
        // It was pending when the turn began, so the turn it was finished in has
        // not ended and the overlay has not put it away yet.
        let path = scratch(
            "finished-now",
            &[
                todo_line(r#"[{"id":1,"subject":"a","status":"pending"}]"#),
                subject_line(),
                todo_line(r#"[{"id":1,"subject":"a","status":"completed"}]"#),
            ],
        );
        let todos = read(&path).expect("read").expect("a record");
        assert_eq!(todos.len(), 1);
        assert_eq!(todos[0].status, "completed");
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn only_the_tasks_finished_before_this_turn_are_put_away() {
        // The mixed case is the whole point of the boundary: the finished task
        // from the earlier turn goes, the one finished now and the open one stay.
        let path = scratch(
            "mixed",
            &[
                todo_line(
                    r#"[{"id":1,"subject":"a","status":"pending"},{"id":2,"subject":"b","status":"completed"}]"#,
                ),
                subject_line(),
                todo_line(
                    r#"[{"id":1,"subject":"a","status":"completed"},{"id":2,"subject":"b","status":"completed"},{"id":3,"subject":"c","status":"in_progress"}]"#,
                ),
            ],
        );
        let todos = read(&path).expect("read").expect("a record");
        let ids: Vec<u64> = todos.iter().map(|todo| todo.id).collect();
        assert_eq!(ids, vec![1, 3]);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn a_transcript_without_a_turn_reports_the_record_as_it_stands() {
        // Nothing says where a turn began, so there is no boundary to read and
        // the record is reported whole rather than guessed at.
        let path = scratch(
            "no-turn",
            &[todo_line(
                r#"[{"id":1,"subject":"a","status":"completed"}]"#,
            )],
        );
        let todos = read(&path).expect("read").expect("a record");
        assert_eq!(todos.len(), 1);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn injected_user_records_do_not_start_a_turn() {
        // Hook and tool output is delivered as a user message. Reading it as a
        // turn boundary would put the task away one turn too early.
        let path = scratch(
            "injected",
            &[
                subject_line(),
                r#"{"type":"message","message":{"role":"user","content":[{"type":"text","text":"<hook>noise</hook>"}]}}"#.to_string(),
                todo_line(r#"[{"id":1,"subject":"a","status":"completed"}]"#),
            ],
        );
        let todos = read(&path).expect("read").expect("a record");
        assert_eq!(todos.len(), 1, "the injected record is not a turn start");
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn a_record_larger_than_one_window_is_still_found() {
        // The description is big enough that the record cannot fit in the first
        // window, so the scan has to widen before it can see the line in one
        // piece. This is the case the growing window exists for.
        let filler = "x".repeat(WINDOW_START as usize * 2);
        let line = todo_line(&format!(
            r#"[{{"id":1,"subject":"big","status":"pending","description":"{filler}"}}]"#
        ));
        let path = scratch("large", &[line]);
        let todos = read(&path).expect("read").expect("a record");
        assert_eq!(todos[0].subject, "big");
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn a_transcript_without_a_record_reads_as_none() {
        let path = scratch("empty", &[subject_line(), subject_line()]);
        assert_eq!(read(&path).expect("read"), None);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn a_line_that_merely_mentions_tasks_is_not_a_record() {
        // `tasks` appears in plenty of ordinary payloads; only the envelope
        // under `message.details` counts.
        let path = scratch(
            "decoys",
            &[
                r#"{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"tasks"}]}}"#.to_string(),
                r#"{"type":"message","message":{"role":"toolResult","toolName":"todo","details":{"action":"list"}}}"#.to_string(),
            ],
        );
        assert_eq!(read(&path).expect("read"), None);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn a_task_missing_its_subject_is_skipped() {
        let path = scratch(
            "partial",
            &[todo_line(
                r#"[{"id":1,"status":"pending"},{"id":2,"subject":"kept","status":"pending"}]"#,
            )],
        );
        let todos = read(&path).expect("read").expect("a record");
        assert_eq!(todos.len(), 1);
        assert_eq!(todos[0].id, 2);
        std::fs::remove_file(&path).ok();
    }
}

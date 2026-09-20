//! The agent's own todo list, read out of its transcript.
//!
//! pi's `rpiv-todo` extension records the whole task list on every `todo` tool
//! call, in the tool result's `details` envelope, and the newest record is the
//! current state. The transcript parser behind `pane.session` deliberately
//! exposes a stable subset of its own types and does not carry that envelope
//! through, so the list is read here from the raw JSONL instead.
//!
//! Sessions reach tens of megabytes and the newest record sits at the end, so
//! the file is read backwards rather than parsed whole. The window grows instead
//! of being fixed because a single record can outgrow one chunk: the leading
//! fragment of any window that does not start at the start of the file is
//! discarded, and a wider window is guaranteed to cover that line in full.

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

/// Reads the agent's current todo list from its transcript.
///
/// `Ok(None)` means the transcript holds no todo record at all, which is the
/// normal case for an agent that has never used the tool.
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

        for line in lines.iter().rev() {
            if let Some(todos) = tasks_from_line(line) {
                return Ok(Some(todos));
            }
        }

        if start == 0 || window >= WINDOW_MAX {
            return Ok(None);
        }
        window = (window * 4).min(WINDOW_MAX);
    }
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
        let path = scratch(
            "newest",
            &[
                todo_line(r#"[{"id":1,"subject":"old","status":"pending"}]"#),
                subject_line(),
                todo_line(r#"[{"id":1,"subject":"new","status":"completed"}]"#),
                subject_line(),
            ],
        );
        let todos = read(&path).expect("read").expect("a record");
        assert_eq!(todos[0].subject, "new");
        assert_eq!(todos[0].status, "completed");
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

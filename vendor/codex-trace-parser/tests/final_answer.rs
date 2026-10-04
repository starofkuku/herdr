// Regression: a chat turn's `final_answer` must track the newest prose.
//
// These transcripts stream prose between tool calls, so the block that closes a
// turn does not exist when the turn first appears. An `is_none()` guard froze
// the value at the first block it saw, which made the transcript preview a
// mid-turn status line ("Now let me verify…") while the detail view showed the
// real answer. `ChatIncremental` is fed in two appends here, mirroring the file
// watcher.
use std::io::Write;

use codex_trace_parser::chat::ChatIncremental;
use codex_trace_parser::provider::Provider;

fn line(id: &str, secs: u32, text: &str) -> String {
    format!(
        r#"{{"type":"message","id":"{id}","timestamp":"2026-09-17T01:00:{secs:02}.000Z","message":{{"role":"assistant","content":[{{"type":"text","text":"{text}"}}]}}}}"#
    )
}

#[test]
fn final_answer_follows_prose_appended_after_the_turn_first_appears() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("pi-live.jsonl");
    let user = r#"{"type":"message","id":"u1","timestamp":"2026-09-17T01:00:00.000Z","message":{"role":"user","content":[{"type":"text","text":"q"}],"timestamp":1}}"#;
    std::fs::write(
        &path,
        format!("{user}\n{}\n", line("a1", 1, "EARLY working note")),
    )
    .unwrap();

    let mut inc = ChatIncremental::load(&path, Provider::Pi).unwrap();
    assert_eq!(
        inc.session().turns[0].final_answer.as_deref(),
        Some("EARLY working note"),
        "the first block is all there is so far"
    );

    // The model keeps going and the file grows.
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .unwrap();
    writeln!(file, "{}", line("a2", 2, "LATE real conclusion")).unwrap();
    drop(file);

    inc.refresh().unwrap();
    assert_eq!(
        inc.session().turns[0].final_answer.as_deref(),
        Some("LATE real conclusion"),
        "final_answer must follow the newest prose, not freeze on the first block"
    );
}

#[test]
fn final_answer_is_the_closing_block_of_a_finished_turn() {
    // The recompute must not disturb a turn that is already complete: its last
    // prose block is the answer either way.
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("pi-done.jsonl");
    let user = r#"{"type":"message","id":"u1","timestamp":"2026-09-17T01:00:00.000Z","message":{"role":"user","content":[{"type":"text","text":"q"}],"timestamp":1}}"#;
    std::fs::write(
        &path,
        format!(
            "{user}\n{}\n{}\n",
            line("a1", 1, "working note"),
            line("a2", 2, "the answer")
        ),
    )
    .unwrap();

    let inc = ChatIncremental::load(&path, Provider::Pi).unwrap();
    assert_eq!(
        inc.session().turns[0].final_answer.as_deref(),
        Some("the answer")
    );
}

//! Subagent runs started by the agent in a pane.
//!
//! pi's `pi-subagents` extension runs child agents in the background and keeps
//! their state under the OS temp directory:
//!
//! ```text
//! /tmp/pi-subagents-uid-<euid>/async-subagent-runs/<runId>/status.json
//! ```
//!
//! Each run records the *parent* session path it belongs to, as that path with
//! the `.jsonl` suffix removed, which is what ties a run back to a pane: the
//! pane already knows its own transcript path, so matching on the stem is
//! enough. `parentWorkflowRunId` links a child run to the workflow that spawned
//! it, but it is not what finds the runs in the first place.
//!
//! Everything here is best effort. The extension prunes finished runs, so an
//! empty answer is ordinary and must not be surfaced as a failure. The JSON is
//! read through `serde_json::Value` rather than a struct because each file
//! carries dozens of fields this view does not use, and a struct would break
//! the build every time the extension adds one.

use std::fs;
use std::path::{Path, PathBuf};

/// One subagent run, reduced to what the panel shows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SubagentRun {
    pub(crate) run_id: String,
    /// `single` or `workflow`.
    pub(crate) mode: String,
    /// `running`, `complete`, `failed`, or `stopped`.
    pub(crate) state: String,
    /// Agent profile that is running, for example `scout`.
    pub(crate) agent: String,
    /// The task as the parent described it, with the agent prefix removed.
    pub(crate) task: Option<String>,
    /// A file the task description names, when it names one.
    pub(crate) target: Option<String>,
    pub(crate) cwd: Option<String>,
    pub(crate) started_at: Option<u64>,
    pub(crate) ended_at: Option<u64>,
    pub(crate) turn_count: Option<u64>,
    pub(crate) tool_count: Option<u64>,
    pub(crate) tokens: Option<u64>,
    /// Only present while the run is live.
    pub(crate) current_tool: Option<String>,
    pub(crate) current_tool_args: Option<String>,
    /// The workflow this run belongs to, when it is a child of one.
    pub(crate) parent_workflow_run_id: Option<String>,
    /// Recent tool invocations, oldest first: what the run has been doing.
    pub(crate) tools: Vec<SubagentToolCall>,
    /// Recent output lines from the run, oldest first.
    pub(crate) output: Vec<String>,
    /// Result files the extension wrote for this run.
    pub(crate) artifacts: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SubagentToolCall {
    pub(crate) tool: String,
    pub(crate) args: String,
}

/// How much of a run's history to carry.
///
/// The file keeps a short tail anyway, but a cap keeps the API response
/// predictable whatever the extension decides to retain.
const MAX_TOOLS: usize = 20;
const MAX_OUTPUT: usize = 20;

/// Reads the runs belonging to the session at `transcript_path`.
///
/// `Ok(None)` means "nothing to show", which covers a missing temp tree, an
/// unknown session, and a pruned one alike — from the panel's point of view
/// they are the same thing.
pub(crate) fn read(transcript_path: &str) -> Option<Vec<SubagentRun>> {
    // The pane's transcript path is what the extension recorded, minus the
    // extension: `status.json` stores the session path without `.jsonl`.
    let stem = transcript_path
        .strip_suffix(".jsonl")
        .unwrap_or(transcript_path);
    let runs = read_runs_in(&runs_dir()?, stem);
    if runs.is_empty() {
        None
    } else {
        Some(runs)
    }
}

/// The testable core: reads every run under `runs_dir` that belongs to `stem`.
fn read_runs_in(runs_dir: &Path, stem: &str) -> Vec<SubagentRun> {
    let Ok(entries) = fs::read_dir(runs_dir) else {
        return Vec::new();
    };

    let mut runs: Vec<SubagentRun> = entries
        .flatten()
        .filter_map(|entry| read_run(&entry.path().join("status.json"), stem))
        .collect();

    // Newest first, which is the order the panel reads them in. A run with no
    // timestamp sorts last rather than being dropped.
    runs.sort_by_key(|run| std::cmp::Reverse(run.started_at));
    runs
}

/// Where the extension keeps its state.
fn runs_dir() -> Option<PathBuf> {
    Some(temp_root()?.join("async-subagent-runs"))
}

/// The extension's per-user temp root.
///
/// Mirrors `resolveTempScopeId()` in the extension: the effective uid on Unix,
/// and a user-name-scoped directory on platforms without one.
fn temp_root() -> Option<PathBuf> {
    #[cfg(unix)]
    {
        let uid = unsafe { libc::geteuid() };
        Some(std::env::temp_dir().join(format!("pi-subagents-uid-{uid}")))
    }
    #[cfg(not(unix))]
    {
        // The name the extension falls back to is environment-dependent.
        // Guessing risks reading an unrelated directory, so report nothing.
        None
    }
}

/// One `status.json`, or `None` when it is missing, unreadable, or belongs to
/// a different session.
fn read_run(status_path: &Path, stem: &str) -> Option<SubagentRun> {
    let text = fs::read_to_string(status_path).ok()?;
    let raw: serde_json::Value = serde_json::from_str(&text).ok()?;

    // The association test. The extension stores the parent session path here
    // with the extension already stripped, so a plain comparison is enough.
    let session_id = raw.get("sessionId").and_then(serde_json::Value::as_str)?;
    if session_id != stem {
        return None;
    }

    let run_id = string_at(&raw, "runId")?;

    // `steps` holds the per-step detail: one entry for a single run, one per
    // child for a workflow. The first entry describes the run itself.
    let step = raw
        .get("steps")
        .and_then(serde_json::Value::as_array)
        .and_then(|steps| steps.first());

    let session_name = step
        .and_then(|step| step.get("sessionName"))
        .and_then(serde_json::Value::as_str);

    Some(SubagentRun {
        run_id: run_id.clone(),
        mode: string_at(&raw, "mode").unwrap_or_else(|| "single".to_string()),
        state: string_at(&raw, "state").unwrap_or_else(|| "unknown".to_string()),
        agent: step
            .and_then(|step| step.get("agent"))
            .and_then(serde_json::Value::as_str)
            .unwrap_or("agent")
            .to_string(),
        task: session_name.and_then(strip_agent_prefix),
        target: session_name.and_then(declared_target),
        cwd: string_at(&raw, "cwd"),
        started_at: u64_at(&raw, "startedAt"),
        ended_at: u64_at(&raw, "endedAt"),
        turn_count: u64_at(&raw, "turnCount"),
        tool_count: u64_at(&raw, "toolCount"),
        tokens: raw
            .get("totalTokens")
            .and_then(|tokens| u64_at(tokens, "total")),
        current_tool: string_at(&raw, "currentTool"),
        current_tool_args: string_at(&raw, "currentToolArgs"),
        parent_workflow_run_id: string_at(&raw, "parentWorkflowRunId"),
        tools: step.map(read_tools).unwrap_or_default(),
        output: step.map(read_output).unwrap_or_default(),
        artifacts: read_artifacts(&raw, step, &run_id),
    })
}

fn string_at(value: &serde_json::Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(serde_json::Value::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

fn u64_at(value: &serde_json::Value, key: &str) -> Option<u64> {
    value.get(key).and_then(serde_json::Value::as_u64)
}

/// Drops the `agent: ` prefix the extension puts on a step's name.
///
/// The name reads `scout: 任务 A：…` while the agent is already a field of its
/// own, so repeating it in the task line is noise. A colon in ordinary prose
/// must not be mistaken for the separator, so the prefix has to look like a
/// bare agent name.
fn strip_agent_prefix(session_name: &str) -> Option<String> {
    let (prefix, rest) = session_name.split_once(':')?;
    let prefix = prefix.trim();
    if prefix.is_empty() || rest.trim().is_empty() {
        return None;
    }
    if prefix.contains(char::is_whitespace) || prefix.len() > 24 {
        return None;
    }
    Some(rest.trim().to_string())
}

/// A file path the task description demands, when it names one.
///
/// The prompt the parent writes is the only place a target file is recorded —
/// the extension never learns which files a child actually wrote — so this
/// reads the declared intent, and the panel presents it as exactly that.
fn declared_target(session_name: &str) -> Option<String> {
    for marker in ["目标文件：", "目标文件:", "target file:", "Target file:"] {
        let Some((_, rest)) = session_name.split_once(marker) else {
            continue;
        };
        let candidate = rest.split_whitespace().next().unwrap_or_default();
        if !candidate.is_empty() {
            return Some(candidate.to_string());
        }
    }
    None
}

fn read_tools(step: &serde_json::Value) -> Vec<SubagentToolCall> {
    let Some(entries) = step
        .get("recentTools")
        .and_then(serde_json::Value::as_array)
    else {
        return Vec::new();
    };
    let start = entries.len().saturating_sub(MAX_TOOLS);
    entries[start..]
        .iter()
        .filter_map(|entry| {
            Some(SubagentToolCall {
                tool: entry
                    .get("tool")
                    .and_then(serde_json::Value::as_str)?
                    .to_string(),
                args: entry
                    .get("args")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
            })
        })
        .collect()
}

fn read_output(step: &serde_json::Value) -> Vec<String> {
    let Some(entries) = step
        .get("recentOutput")
        .and_then(serde_json::Value::as_array)
    else {
        return Vec::new();
    };
    let start = entries.len().saturating_sub(MAX_OUTPUT);
    entries[start..]
        .iter()
        .filter_map(|entry| entry.as_str())
        .filter(|line| !line.trim().is_empty())
        .map(str::to_string)
        .collect()
}

/// The extension's own files for this run.
///
/// It writes `<runId>_<agent>_output.md`, `_meta.json`, `_input.md`, and a
/// transcript into a `subagent-artifacts` directory shared by every run of the
/// session, so a run's files are exactly those carrying its id as a prefix.
fn read_artifacts(
    raw: &serde_json::Value,
    step: Option<&serde_json::Value>,
    run_id: &str,
) -> Vec<String> {
    let dir = string_at(raw, "artifactsDir")
        .or_else(|| step.and_then(|step| string_at(step, "artifactsDir")));
    let Some(dir) = dir else {
        return Vec::new();
    };
    let Ok(entries) = fs::read_dir(&dir) else {
        return Vec::new();
    };

    let prefix = format!("{run_id}_");
    let mut artifacts: Vec<String> = entries
        .flatten()
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| name.starts_with(&prefix))
        .collect();
    artifacts.sort();
    artifacts
}

/// The number of runs still going, which is what the collapsed bar shows.
pub(crate) fn active_count(runs: &[SubagentRun]) -> usize {
    runs.iter().filter(|run| run.state == "running").count()
}

/// Reads the runs and counts the active ones in one step.
pub(crate) fn snapshot(transcript_path: &str) -> (usize, Vec<SubagentRun>) {
    let runs = read(transcript_path).unwrap_or_default();
    let active = active_count(&runs);
    (active, runs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    const STEM: &str = "/tmp/sessions/2026-09-20T08-30-34-375Z_01a0bdf0";

    /// A scratch runs directory; the caller removes it.
    ///
    /// `tempfile` is not a dependency of this crate, and all this needs is a
    /// place to write a couple of files.
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "herdr-subagents-test-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create scratch dir");
        dir
    }

    /// Writes one run's `status.json` under `dir`.
    fn write_run(dir: &Path, run_id: &str, body: &str) {
        let run_dir = dir.join(run_id);
        fs::create_dir_all(&run_dir).expect("create run dir");
        let mut file = fs::File::create(run_dir.join("status.json")).expect("create status");
        file.write_all(body.as_bytes()).expect("write status");
    }

    /// A live run, shaped the way the extension records one.
    fn running_run(run_id: &str, session_id: &str) -> String {
        format!(
            r#"{{
              "runId": "{run_id}",
              "sessionId": "{session_id}",
              "mode": "single",
              "state": "running",
              "cwd": "/home/u/project",
              "startedAt": 5000,
              "turnCount": 4,
              "toolCount": 4,
              "currentTool": "bash",
              "currentToolArgs": "sleep 70",
              "totalTokens": {{"input": 100, "output": 20, "total": 120}},
              "steps": [{{
                "agent": "scout",
                "sessionName": "scout: 任务 A：统计行数 目标文件：/tmp/probe/a.md 内容要求：…",
                "recentTools": [{{"tool": "bash", "args": "find . -name '*.rs'", "endMs": 1}}],
                "recentOutput": ["阶段1 完成", "阶段2 开始"]
              }}]
            }}"#
        )
    }

    #[test]
    fn reads_only_the_runs_of_this_session() {
        let dir = scratch("session-filter");
        write_run(&dir, "mine", &running_run("mine", STEM));
        write_run(
            &dir,
            "theirs",
            &running_run("theirs", "/tmp/sessions/someone-else"),
        );

        let runs = read_runs_in(&dir, STEM);
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].run_id, "mine");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn carries_the_fields_the_panel_shows() {
        let dir = scratch("fields");
        write_run(&dir, "mine", &running_run("mine", STEM));

        let runs = read_runs_in(&dir, STEM);
        let run = &runs[0];
        assert_eq!(run.mode, "single");
        assert_eq!(run.state, "running");
        assert_eq!(run.agent, "scout");
        assert_eq!(run.cwd.as_deref(), Some("/home/u/project"));
        assert_eq!(run.started_at, Some(5000));
        assert_eq!(run.tokens, Some(120));
        assert_eq!(run.current_tool.as_deref(), Some("bash"));
        assert_eq!(run.current_tool_args.as_deref(), Some("sleep 70"));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn strips_the_agent_prefix_and_reads_the_declared_target() {
        let dir = scratch("task");
        write_run(&dir, "mine", &running_run("mine", STEM));

        let run = &read_runs_in(&dir, STEM)[0];
        assert_eq!(
            run.task.as_deref(),
            Some("任务 A：统计行数 目标文件：/tmp/probe/a.md 内容要求：…")
        );
        assert_eq!(run.target.as_deref(), Some("/tmp/probe/a.md"));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_task_without_a_declared_target_has_none() {
        assert_eq!(declared_target("scout: just do something"), None);
        // A marker with nothing after it is not a target either.
        assert_eq!(declared_target("scout: 目标文件："), None);
    }

    #[test]
    fn prose_with_a_colon_keeps_its_text() {
        // The prefix test must not eat a sentence that merely contains a colon,
        // and then the task keeps its own leading text.
        assert_eq!(strip_agent_prefix("Task for scout"), None);
        assert_eq!(strip_agent_prefix("scout: do it").as_deref(), Some("do it"));
        // A multi-word prefix is prose, not an agent name.
        assert_eq!(strip_agent_prefix("Task for scout: do it"), None);
    }

    #[test]
    fn new_runs_come_first() {
        let dir = scratch("order");
        write_run(&dir, "old", &running_run("old", STEM));
        write_run(
            &dir,
            "new",
            &running_run("new", STEM).replace("\"startedAt\": 5000", "\"startedAt\": 9000"),
        );

        let runs = read_runs_in(&dir, STEM);
        assert_eq!(runs[0].run_id, "new");
        assert_eq!(runs[1].run_id, "old");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_finished_run_drops_the_fields_that_only_exist_while_live() {
        // The extension removes `currentTool` once a run ends, so the reader
        // must not require it.
        let dir = scratch("finished");
        let body = running_run("mine", STEM)
            .replace(r#""state": "running""#, r#""state": "complete""#)
            .replace(r#""currentTool": "bash","#, "")
            .replace(r#""currentToolArgs": "sleep 70","#, "");
        write_run(&dir, "mine", &body);

        let run = &read_runs_in(&dir, STEM)[0];
        assert_eq!(run.state, "complete");
        assert_eq!(run.current_tool, None);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_missing_directory_reads_as_nothing() {
        assert!(read_runs_in(Path::new("/nonexistent/herdr-subagents"), STEM).is_empty());
    }

    #[test]
    fn malformed_and_incomplete_files_are_skipped() {
        let dir = scratch("broken");
        write_run(&dir, "not-json", "{ not json");
        // Valid JSON, but with no run id.
        write_run(&dir, "no-id", &format!(r#"{{"sessionId": "{STEM}"}}"#));
        write_run(&dir, "good", &running_run("good", STEM));

        let runs = read_runs_in(&dir, STEM);
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].run_id, "good");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn active_count_counts_only_running_runs() {
        let dir = scratch("active");
        write_run(&dir, "a", &running_run("a", STEM));
        write_run(&dir, "b", &running_run("b", STEM));
        write_run(
            &dir,
            "c",
            &running_run("c", STEM)
                .replace(r#""state": "running""#, r#""state": "complete""#)
                .replace("\"startedAt\": 5000", "\"startedAt\": 4000"),
        );

        let runs = read_runs_in(&dir, STEM);
        assert_eq!(runs.len(), 3);
        assert_eq!(active_count(&runs), 2);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn artifacts_are_the_files_carrying_the_run_id() {
        let dir = scratch("artifacts");
        let artifact_dir = dir.join("artifacts");
        fs::create_dir_all(&artifact_dir).expect("create artifact dir");
        for name in [
            "mine_scout_output.md",
            "mine_scout_meta.json",
            // Another run's file, and one that is not an artifact at all.
            "other_scout_output.md",
            "readme.txt",
        ] {
            fs::write(artifact_dir.join(name), "x").expect("write artifact");
        }

        let body = format!(
            r#"{{"runId":"mine","sessionId":"{STEM}","state":"running","artifactsDir":"{}","steps":[{{"agent":"scout"}}]}}"#,
            artifact_dir.display()
        );
        write_run(&dir, "mine", &body);

        let run = &read_runs_in(&dir, STEM)[0];
        assert_eq!(
            run.artifacts,
            vec![
                "mine_scout_meta.json".to_string(),
                "mine_scout_output.md".to_string()
            ]
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_unreadable_artifacts_directory_is_not_an_error() {
        let dir = scratch("artifacts-missing");
        let body = format!(
            r#"{{"runId":"mine","sessionId":"{STEM}","state":"running","artifactsDir":"/nonexistent/artifacts","steps":[{{"agent":"scout"}}]}}"#
        );
        write_run(&dir, "mine", &body);

        let run = &read_runs_in(&dir, STEM)[0];
        assert!(run.artifacts.is_empty());
        fs::remove_dir_all(&dir).ok();
    }
}

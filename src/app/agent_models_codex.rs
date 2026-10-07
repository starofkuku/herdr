//! The models Codex can be switched to, and the one it is running.
//!
//! Unlike pi, nothing here is read from a file on disk. Codex owns its catalog
//! behind the app-server, so the list is asked of the same daemon the panes
//! connect to. A cached copy is not a substitute: the one on this machine lists
//! fourteen models and omits the model the account is actually running, so a
//! picker built on it would not even mark the current choice.
//!
//! The current model, by contrast, is on disk. Codex records the model it is
//! running in the thread's rollout file — as a `turn_context` per turn and as a
//! `thread_settings_applied` event whenever the settings change — so the last of
//! either in the transcript is the current answer.

use std::fs::File;
use std::io::{self, BufRead};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::api::schema::PaneModel;

/// How long a fetched catalog is reused before another fetch is started.
const CATALOG_TTL: Duration = Duration::from_secs(30);

struct Cached {
    fetched: Instant,
    models: Vec<PaneModel>,
}

fn cache() -> &'static Mutex<Option<Cached>> {
    static CACHE: std::sync::OnceLock<Mutex<Option<Cached>>> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

fn refreshing() -> &'static AtomicBool {
    static REFRESHING: AtomicBool = AtomicBool::new(false);
    &REFRESHING
}

/// Reads the catalog, from a cache that never blocks the caller.
///
/// The list comes from the app-server over a socket, and a socket call can take
/// seconds on a cold daemon. This runs in the API's request path, which is the
/// server's main loop: waiting there would stop the whole server — panes stop
/// being read, subscriptions stall, everything herdr does waits with it — so it
/// must not wait. Instead the answer is cached, and a stale cache starts a
/// refresh on a thread of its own while the request returns what is already
/// known: usually the previous list, and a note asking for another look the very
/// first time, before any list exists.
pub(crate) fn read() -> io::Result<Vec<PaneModel>> {
    if let Some(models) = cached_while_fresh() {
        return Ok(models);
    }
    refresh_in_background();
    match cache()
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().map(|cached| cached.models.clone()))
    {
        Some(models) => Ok(models),
        None => Err(io::Error::other(
            "reading the model list from the Codex app-server; open the menu again in a moment",
        )),
    }
}

fn cached_while_fresh() -> Option<Vec<PaneModel>> {
    cache().lock().ok().and_then(|guard| {
        guard
            .as_ref()
            .filter(|cached| cached.fetched.elapsed() < CATALOG_TTL)
            .map(|cached| cached.models.clone())
    })
}

fn refresh_in_background() {
    // One refresh at a time: a second request arriving while the first is still
    // in flight would otherwise start another daemon round trip to learn the
    // same thing.
    if refreshing().swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(|| {
        match fetch() {
            Ok(models) => {
                if let Ok(mut guard) = cache().lock() {
                    *guard = Some(Cached {
                        fetched: Instant::now(),
                        models,
                    });
                }
            }
            // Reported rather than surfaced: the request that started this
            // refresh has already answered, so the failure has nowhere to go
            // except the log the next request's note points at.
            Err(error) => tracing::warn!(%error, "codex model list refresh failed"),
        }
        refreshing().store(false, Ordering::SeqCst);
    });
}

fn fetch() -> io::Result<Vec<PaneModel>> {
    let result = query("model/list", serde_json::json!({"includeHidden": false}))?;
    parse(&result)
}

/// Parses a `model/list` result.
///
/// Separated from the call so the shape is exercised without a daemon.
pub(crate) fn parse(result: &Value) -> io::Result<Vec<PaneModel>> {
    let data = result
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "Codex model/list returned no model array",
            )
        })?;

    let mut models = Vec::new();
    for entry in data {
        let Some(id) = entry
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
        else {
            continue;
        };
        // `includeHidden: false` should already have excluded these. Filtering
        // again is deliberate: a server that ignored the flag would otherwise put
        // internal models in the menu, and hiding them again costs nothing.
        if entry.get("hidden").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        let label = entry
            .get("displayName")
            .and_then(Value::as_str)
            .filter(|name| *name != id)
            .map(str::to_string);
        models.push(PaneModel {
            id: id.to_string(),
            // Codex serves every model through the provider its config selects;
            // the list is not partitioned by provider the way pi's is, so there is
            // no second axis to group by and the field stays empty.
            provider: String::new(),
            label,
            current: false,
            // The levels the app-server reports for this model, in its order:
            // codex gates them per model, so the effort menu is per model too.
            efforts: codex_efforts(entry),
        });
    }

    // The server's own order, which is its priority order, is what Codex's picker
    // shows; sorting here would second-guess it.
    Ok(models)
}

/// The reasoning efforts a Codex model accepts.
///
/// Reported per model by the app-server, each with its own description; the id
/// is what `thread/settings/update` takes, so the id is what is kept.
fn codex_efforts(entry: &Value) -> Vec<String> {
    entry
        .get("supportedReasoningEfforts")
        .and_then(Value::as_array)
        .map(|levels| {
            levels
                .iter()
                .filter_map(|level| {
                    level
                        .get("reasoningEffort")
                        .and_then(Value::as_str)
                        .filter(|effort| !effort.is_empty())
                        .map(str::to_string)
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The model a thread is currently running.
///
/// Scanned forwards over the whole transcript, for the reason pi's reader is: the
/// answer can be a very long way from the end of a long session — a thread whose
/// model was set once near the top keeps it there — and a bounded tail read would
/// answer "unknown" for exactly the sessions that ran longest.
pub(crate) fn current_from_transcript(path: &Path) -> Option<(String, Option<String>)> {
    let file = File::open(path).ok()?;
    let mut reader = io::BufReader::with_capacity(64 * 1024, file);
    let mut line = Vec::new();
    let mut found = None;

    loop {
        line.clear();
        // Bytes, not a `String`: a truncated tail must not end the scan through an
        // otherwise readable file.
        if reader.read_until(b'\n', &mut line).ok()? == 0 {
            break;
        }
        // Every interesting line names the model, so this rejects nearly all of
        // them before any parsing.
        if !line.windows(5).any(|window| window == b"model") {
            continue;
        }
        let Ok(entry) = serde_json::from_slice::<Value>(&line) else {
            continue;
        };
        if let Some((model, effort)) = model_of(&entry) {
            found = Some((model, effort));
        }
    }

    found
}

/// The model, and the effort, named by one transcript entry, when it names them.
fn model_of(entry: &Value) -> Option<(String, Option<String>)> {
    let payload = entry.get("payload")?;
    let (model, effort) = match entry.get("type").and_then(Value::as_str) {
        // Recorded once per turn, and the closest thing to "what just ran".
        Some("turn_context") => (payload.get("model"), payload.get("effort")),
        // Recorded when the thread's settings change, which is what a switch
        // produces even before the next turn.
        Some("event_msg")
            if payload.get("type").and_then(Value::as_str) == Some("thread_settings_applied") =>
        {
            // The settings event names the model it applied but records no
            // effort — the field is null there even right after an effort
            // change, and treating null as "no level" would lose the last one
            // that a turn actually recorded. So it speaks for the model only,
            // and the effort stays whatever the last turn said.
            let settings = payload.get("thread_settings")?;
            (settings.get("model"), None)
        }
        _ => return None,
    };
    let model = model?
        .as_str()
        .filter(|model| !model.is_empty())
        .map(str::to_string)?;
    let effort = effort
        .and_then(Value::as_str)
        .filter(|effort| !effort.is_empty())
        .map(str::to_string);
    Some((model, effort))
}

/// The thread id a Codex rollout belongs to.
///
/// Read from the rollout's own first record, which names the session it was
/// opened for. The filename encodes the same id, but the record is the source
/// the rest of Codex writes and reads, and reading it does not depend on the
/// naming convention holding.
pub(crate) fn thread_id(path: &Path) -> Option<String> {
    let file = File::open(path).ok()?;
    let mut reader = io::BufReader::with_capacity(8 * 1024, file);
    let mut line = String::new();
    if reader.read_line(&mut line).ok()? == 0 {
        return None;
    }
    let entry = serde_json::from_str::<Value>(&line).ok()?;
    entry
        .pointer("/payload/session_id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
}

/// Applies a model choice to a thread.
///
/// `thread/settings/update` changes the model for the thread's subsequent turns,
/// which is the whole of what a mid-session switch can mean: the turn in flight
/// keeps the model it was captured with. Timeboxed tighter than a read, because
/// it answers a click someone is waiting on.
pub(crate) fn switch_model(thread_id: &str, model: &str, effort: Option<&str>) -> io::Result<()> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    runtime.block_on(async {
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            // The effort rides along when one was chosen: the same update sets
            // both, and splitting them would let the model land on a level it
            // does not accept.
            let mut params = serde_json::json!({"threadId": thread_id, "model": model});
            if let Some(effort) = effort {
                params["effort"] = serde_json::Value::String(effort.to_string());
            }
            crate::codex_bridge::query("thread/settings/update", params).await
        })
        .await
        .map_err(|_| io::Error::other("the Codex app-server did not answer in time"))?
        .map(|_| ())
    })
}

/// Finds the rollout a live Codex process is on, without its help.
///
/// This is the fallback for Codex's own report never arriving: its `SessionStart`
/// hook fires on the first turn of a session, so a pane that resumes an existing
/// thread — `codex resume --last` — runs with no session identity as far as herdr
/// can see, and the conversation view and model picker both stay blind until
/// something else tells herdr where the thread lives. The rollout file itself is
/// that something, and which one it is follows Codex's own rule for `--last`: the
/// most recent rollout recorded for the working directory the process runs in.
/// No working directory, no answer — the alternative is guessing between every
/// session on the machine.
///
/// Deliberately read-side only. Nothing here reports or persists a session: a
/// real hook report remains the authority and will overwrite whatever this
/// found the moment it arrives.
///
/// The walk is bounded the way the id lookup's is, and the first line of each
/// candidate is the only part read.
pub(crate) fn discover_transcript(cwd: Option<&Path>) -> Option<std::path::PathBuf> {
    let root = codex_sessions_root()?;
    let cwd = cwd?;
    let mut newest: Option<(std::time::SystemTime, std::path::PathBuf)> = None;
    let mut stack = vec![(root, 0_usize)];
    let mut visited = 0_usize;
    while let Some((directory, depth)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.flatten() {
            visited += 1;
            if visited > 20_000 {
                return None;
            }
            let path = entry.path();
            if path.is_dir() {
                if depth < 6 {
                    stack.push((path, depth + 1));
                }
                continue;
            }
            let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            if !name.starts_with("rollout-") || !name.ends_with(".jsonl") {
                continue;
            }
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            let Ok(modified) = metadata.modified() else {
                continue;
            };
            if rollout_working_directory(&path).as_deref() != Some(cwd) {
                continue;
            }
            if newest.as_ref().is_none_or(|(time, _)| modified > *time) {
                newest = Some((modified, path.clone()));
            }
        }
    }
    newest.map(|(_, path)| path)
}

/// The directory the pane's Codex records for one rollout, from its first line.
fn rollout_working_directory(path: &Path) -> Option<std::path::PathBuf> {
    let file = File::open(path).ok()?;
    let mut reader = io::BufReader::with_capacity(8 * 1024, file);
    let mut line = String::new();
    if reader.read_line(&mut line).ok()? == 0 {
        return None;
    }
    serde_json::from_str::<Value>(&line).ok().and_then(|entry| {
        entry
            .pointer("/payload/cwd")
            .and_then(Value::as_str)
            .map(std::path::PathBuf::from)
    })
}

/// Where Codex keeps its rollouts, when the default location is usable.
fn codex_sessions_root() -> Option<std::path::PathBuf> {
    let home = crate::integration::home_dir().ok()?;
    let root = home.join(".codex").join("sessions");
    root.is_dir().then_some(root)
}

/// Asks the app-server, without assuming an ambient runtime.
///
/// The API runs on plain OS threads, so the current-thread runtime is built here
/// rather than reached for: `Handle::current` would panic wherever none exists.
fn query(method: &str, params: Value) -> io::Result<Value> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    runtime.block_on(crate::codex_bridge::query(method, params))
}

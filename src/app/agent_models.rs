//! The models an agent can be switched to, read from its own configuration.
//!
//! pi keeps its catalog in `~/.pi/agent/models.json` as
//! `{"providers": {"<name>": {"models": [{"id": ...}]}}}`. That file is the same
//! one the agent reads, so listing it here cannot drift from what the agent
//! would accept.
//!
//! The pane's current model is a separate fact and is not in that file. pi
//! records it per session, as a `model_change` entry in the session's JSONL, so
//! the current model is read from the transcript the pane already points at.
use std::fs::File;
use std::io::{self, BufRead};
use std::path::Path;

use crate::api::schema::PaneModel;

/// Where pi keeps its model catalog, alongside its other agent state.
fn catalog_path() -> io::Result<std::path::PathBuf> {
    Ok(crate::integration::pi_agent_dir()?.join("models.json"))
}

/// Reads the catalog.
///
/// Every model is reported, including the same id under different providers:
/// `deepseek-flash` exists under three providers here, and they are not
/// interchangeable — the pane's current model is matched on both parts.
pub(crate) fn read() -> io::Result<Vec<PaneModel>> {
    let path = catalog_path()?;
    let raw = std::fs::read_to_string(&path)?;
    parse(&raw).map_err(|message| io::Error::new(io::ErrorKind::InvalidData, message))
}

/// Parses the catalog.
///
/// Separated from the read so the shape can be exercised without a file on disk.
pub(crate) fn parse(raw: &str) -> Result<Vec<PaneModel>, String> {
    let document: serde_json::Value =
        serde_json::from_str(raw).map_err(|err| format!("models.json is not valid JSON: {err}"))?;
    let providers = document
        .get("providers")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| "models.json has no providers table".to_string())?;

    let mut models = Vec::new();
    for (provider, entry) in providers {
        let Some(list) = entry.get("models").and_then(serde_json::Value::as_array) else {
            continue;
        };
        for model in list {
            let Some(id) = model.get("id").and_then(serde_json::Value::as_str) else {
                continue;
            };
            // The label is only worth carrying when it says more than the id,
            // which it usually does not — most entries repeat the id in `name`.
            let label = model
                .get("name")
                .and_then(serde_json::Value::as_str)
                .filter(|name| *name != id)
                .map(str::to_string);
            models.push(PaneModel {
                id: id.to_string(),
                provider: provider.clone(),
                label,
                current: false,
                efforts: pi_efforts(model),
            });
        }
    }

    models.sort_by(|a, b| a.provider.cmp(&b.provider).then_with(|| a.id.cmp(&b.id)));
    Ok(models)
}

/// The efforts a pi model accepts, derived the way pi itself derives them.
///
/// pi's own rule, from its bundled command handling: a model that does not
/// reason takes nothing but `off`, one that does offers the standard ladder
/// with the top two rungs (`xhigh`, `max`) present only when the model maps
/// them — `thinkingLevelMap` — or maps nothing at all. Reproducing that here
/// keeps the menu from offering a level pi would clamp away.
fn pi_efforts(model: &serde_json::Value) -> Vec<String> {
    /// pi's ladder, bottom to top, as its own constant spells it.
    const LADDER: [&str; 7] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
    if model.get("reasoning").and_then(serde_json::Value::as_bool) != Some(true) {
        return vec!["off".to_string()];
    }
    let map = model.get("thinkingLevelMap");
    LADDER
        .iter()
        .filter(|level| {
            let mapped = map.and_then(|map| map.get(**level));
            // pi's own rule, and the one its error message states: an explicit
            // null mapping removes a level, and the top two rungs exist only
            // where a model maps them. A model with no map at all therefore
            // offers the five lower levels — offering it max would be a choice
            // pi rejects, which is exactly what happened.
            if **level == "xhigh" || **level == "max" {
                mapped.is_some_and(|value| !value.is_null())
            } else {
                !mapped.is_some_and(|value| value.is_null())
            }
        })
        .map(|level| level.to_string())
        .collect()
}

/// The model a pane is currently running, as `(provider, model id)`.
///
/// pi writes a `model_change` entry whenever the model changes, so the last one
/// in the session file is the current model.
///
/// The scan runs forwards over the whole file rather than reading a window off
/// the end. The last change is not necessarily near the end: a session that runs
/// for hours after one early switch keeps its only `model_change` at the top, and
/// a bounded tail read would then answer "no model" for exactly the long sessions
/// that most need the right answer. Sessions here reach tens of megabytes, which a
/// streaming pass reads in tens of milliseconds, and each line is rejected on a
/// substring before any JSON parsing, so only the handful of real changes cost
/// anything.
pub(crate) fn current_from_session(path: &Path) -> Option<(String, String)> {
    let file = File::open(path).ok()?;
    let mut reader = io::BufReader::with_capacity(64 * 1024, file);
    let mut line = Vec::new();
    let mut found = None;

    loop {
        line.clear();
        // Read as bytes: a session file is text, but a truncated or corrupt tail
        // must not abort the scan through an otherwise readable file.
        if reader.read_until(b'\n', &mut line).ok()? == 0 {
            break;
        }
        let Ok(text) = std::str::from_utf8(&line) else {
            continue;
        };
        if !text.contains("model_change") {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<serde_json::Value>(text) else {
            continue;
        };
        if entry.get("type").and_then(serde_json::Value::as_str) != Some("model_change") {
            continue;
        }
        let provider = entry.get("provider").and_then(serde_json::Value::as_str);
        let model = entry.get("modelId").and_then(serde_json::Value::as_str);
        if let (Some(provider), Some(model)) = (provider, model) {
            // Not an early return: the last change in the file is the current one.
            found = Some((provider.to_string(), model.to_string()));
        }
    }

    found
}

/// The thinking level a pane is currently running, when its session records one.
///
/// pi writes a `thinking_level_change` entry for every change, exactly as it
/// writes `model_change` for a model, so the same forward scan answers this too.
/// A session that never changed its level may have no entry at all — the level
/// then lives in pi's settings, not in this session — and the honest answer is
/// none rather than a guess.
pub(crate) fn current_effort_from_session(path: &Path) -> Option<String> {
    let file = File::open(path).ok()?;
    let mut reader = io::BufReader::with_capacity(64 * 1024, file);
    let mut line = Vec::new();
    let mut found = None;

    loop {
        line.clear();
        if reader.read_until(b'\n', &mut line).ok()? == 0 {
            break;
        }
        let Ok(text) = std::str::from_utf8(&line) else {
            continue;
        };
        if !text.contains("thinking_level_change") {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<serde_json::Value>(text) else {
            continue;
        };
        if entry.get("type").and_then(serde_json::Value::as_str) != Some("thinking_level_change") {
            continue;
        }
        if let Some(level) = entry
            .get("thinkingLevel")
            .and_then(serde_json::Value::as_str)
            .filter(|level| !level.is_empty())
        {
            found = Some(level.to_string());
        }
    }

    found
}

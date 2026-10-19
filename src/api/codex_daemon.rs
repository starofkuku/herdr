//! Answers `server.restart_codex_daemon`.
//!
//! The shared Codex app-server daemon reads its config — the model catalog
//! included — once, at startup. Editing the catalog on disk therefore changes
//! nothing for a running daemon: every pane and every model menu keeps seeing
//! the old models until the daemon itself is restarted. This runs that restart
//! on demand and drops herdr's cached copy of the catalog, so the next open of
//! the model menu reads the fresh one instead of waiting out the cache.
//!
//! Served on the API path that does not enter the main loop: a restart takes
//! seconds, and that wait belongs to the caller's connection, not to the loop
//! every pane is served from.

use std::time::{Duration, Instant};

use serde_json::json;

/// How long the restart may take before it is killed and reported failed.
const RESTART_TIMEOUT: Duration = Duration::from_secs(60);

/// Runs `codex app-server daemon restart` and clears the catalog cache.
///
/// The timeout is enforced by polling rather than by a wait-with-deadline:
/// std has none, and leaving a hung restart holding this connection forever is
/// the outcome the cap exists to prevent.
/// The feature overrides the daemon was last configured with.
///
/// Codex records the shared feature settings its client chose — the ones a
/// session's resume compares against — in `settings.json`. A restart that does
/// not repeat them brings the daemon back on defaults, and a session configured
/// for a third-party provider then refuses to resume with "incompatible feature
/// settings". Passing them through keeps a restart from silently changing what
/// the daemon is willing to run.
fn feature_flags() -> Vec<String> {
    let Some(home) = std::env::var_os("HOME") else {
        return Vec::new();
    };
    let path = std::path::Path::new(&home).join(".codex/app-server-daemon/settings.json");
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    let Ok(document) = serde_json::from_str::<serde_json::Value>(&text) else {
        return Vec::new();
    };
    let Some(overrides) = document["featureOverrides"].as_object() else {
        return Vec::new();
    };
    let mut flags = Vec::new();
    for (name, value) in overrides {
        match value.as_bool() {
            Some(true) => {
                flags.push("--enable".to_string());
                flags.push(name.clone());
            }
            Some(false) => {
                flags.push("--disable".to_string());
                flags.push(name.clone());
            }
            None => {}
        }
    }
    flags
}

fn restart() -> Result<String, String> {
    let mut command = std::process::Command::new("codex");
    command.args(["app-server", "daemon", "restart"]);
    command.args(feature_flags());
    // A daemon inherits the environment of whoever starts it, and hooks from a
    // shared service must not carry one client's identity — without this, the
    // bridge would refuse the very daemon this restart produced, and the model
    // catalog would stay unreadable until someone fixed it by hand.
    for (key, _) in std::env::vars_os() {
        let name = key.to_string_lossy();
        if name.starts_with("HERDR_") || name == "CODEX_THREAD_ID" {
            command.env_remove(key);
        }
    }
    command.stdin(std::process::Stdio::null());
    let mut child = command
        .spawn()
        .map_err(|err| format!("cannot run codex: {err}"))?;

    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {
                if started.elapsed() >= RESTART_TIMEOUT {
                    let _ = child.kill();
                    let _ = child.wait();
                    break None;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(err) => return Err(format!("waiting for codex: {err}")),
        }
    };

    let output = match status {
        Some(status) if !status.success() => {
            return Err(format!("codex exited with {status}"));
        }
        Some(_) => String::new(),
        None => return Err("codex app-server daemon restart timed out".to_string()),
    };

    // The daemon behind the old catalog is gone; so is every answer cached
    // from it. The next reader re-fetches from the new daemon.
    crate::app::agent_models_codex::invalidate();
    Ok(output)
}

/// Renders the restart's outcome as a response line.
pub(super) fn response(id: String) -> String {
    match restart() {
        Ok(output) => {
            json!({"id": id, "result": {"restarted": true, "output": output}}).to_string()
        }
        Err(message) => {
            json!({"id": id, "error": {"code": "codex_daemon_restart_failed", "message": message}})
                .to_string()
        }
    }
}

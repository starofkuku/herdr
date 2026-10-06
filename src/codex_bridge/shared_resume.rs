//! Do not silently attach a pane to a loaded thread with another pane's config.
use serde_json::{json, Value};
use std::collections::HashMap;

#[derive(Default)]
pub(super) struct ResumeGuard {
    pending: HashMap<String, Value>,
    serial: u64,
}

impl ResumeGuard {
    pub fn prepare(&mut self, message: Value) -> Value {
        if message["method"] != "thread/resume" {
            return message;
        }
        self.serial += 1;
        let id = format!("herdr-shared-resume-{}", self.serial);
        let request = json!({"id":id,"method":"thread/read",
            "params":{"threadId":message["params"]["threadId"],"includeTurns":false}});
        self.pending.insert(id, message);
        request
    }

    /// A consumed probe produces either the original resume or a client error.
    pub fn resolve(&mut self, message: &Value) -> Option<(bool, Value)> {
        if message.get("method").is_some() {
            return None;
        }
        let original = self.pending.remove(message["id"].as_str()?)?;
        if message.get("error").is_some() {
            return Some((false, json!({"id":original["id"],"error":message["error"]})));
        }
        if message["result"]["thread"]["status"]["type"] == "notLoaded" {
            return Some((true, original));
        }
        Some((
            false,
            json!({"id":original["id"],"error":{"code":-32600,
            "message":"This Codex session is still loaded in the shared daemon. Close its other clients and let the daemon unload the idle session before restoring it in another pane; live attachment cannot safely replace pane-specific tool environment."}}),
        ))
    }
}

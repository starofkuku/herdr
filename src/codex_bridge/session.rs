use super::{mapping, pane::Pane};
use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};

pub(super) struct Session {
    pending: VecDeque<(mapping::Pending, Value)>,
    answered: HashSet<String>,
    serial: u64,
    source: String,
    items: HashMap<String, Value>,
    thread_requests: HashSet<String>,
    active_thread: Option<String>,
}

impl Session {
    pub fn new(source: String) -> Self {
        Self {
            pending: VecDeque::new(),
            answered: HashSet::new(),
            serial: 0,
            source,
            items: HashMap::new(),
            thread_requests: HashSet::new(),
            active_thread: None,
        }
    }

    pub fn refresh(&self, pane: &Pane) {
        pane.show(
            self.pending
                .iter()
                .find(|(p, _)| !p.submitted)
                .map(|(p, _)| p.clone()),
        );
        if let Ok(mut session) = pane.session.lock() {
            *session = self.active_thread.clone();
        }
    }

    /// Returns false for bridge-owned RPC acknowledgements, never for CLI replies.
    pub fn server(&mut self, message: &Value) -> bool {
        if message.get("method").is_none()
            && self.thread_requests.remove(&message["id"].to_string())
        {
            if let Some(thread) = message["result"]["thread"]["id"].as_str() {
                self.active_thread = Some(thread.into());
            }
        }
        if let Some(id) = message["id"]
            .as_str()
            .filter(|id| id.starts_with("herdr-answer-"))
        {
            let key = id.trim_start_matches("herdr-answer-");
            if message.get("error").is_some() {
                if let Some((p, _)) = self.pending.iter_mut().find(|(p, _)| p.key == key) {
                    p.submitted = false;
                    p.revision += 1;
                }
                tracing::warn!(error = ?message["error"], "Codex rejected asynchronous answer");
            } else {
                self.pending.retain(|(p, _)| p.key != key);
            }
            return false;
        }
        self.notification(message);
        self.enqueue(message);
        true
    }

    fn notification(&mut self, message: &Value) {
        let p = &message["params"];
        if message["method"] == "item/started" && p["item"]["type"] == "fileChange" {
            if let Some(id) = p["item"]["id"].as_str() {
                self.items.insert(id.into(), p["item"]["changes"].clone());
            }
        }
        match message["method"].as_str() {
            Some("serverRequest/resolved") => {
                let id = &p["requestId"];
                self.answered.insert(id.to_string());
                self.pending
                    .retain(|(pending, _)| pending.rpc_id.as_ref() != Some(id));
            }
            Some("turn/completed") => self.pending.retain(|(pending, _)| {
                pending.thread != p["threadId"] || pending.turn != p["turn"]["id"]
            }),
            Some("item/completed") if p["item"]["type"] == "userMessage" => {
                self.dismiss_async(&p["item"]["content"]);
            }
            _ => {}
        }
    }

    fn enqueue(&mut self, message: &Value) {
        let p = &message["params"];
        self.serial += 1;
        let mut enriched = message.clone();
        if message["method"] == "item/fileChange/requestApproval" {
            if let Some(changes) = p["itemId"].as_str().and_then(|id| self.items.remove(id)) {
                enriched["params"]["changes"] = changes;
            }
        }
        if let Some(pending) = mapping::request(&enriched, self.serial, &self.source) {
            let duplicate = self.pending.iter().any(|(old, _)| {
                if pending.rpc_id.is_some() {
                    old.rpc_id == pending.rpc_id
                } else {
                    old.thread == pending.thread && old.item == pending.item
                }
            });
            let resolved = pending
                .rpc_id
                .as_ref()
                .is_some_and(|id| self.answered.contains(&id.to_string()));
            if !duplicate && !resolved {
                self.pending.push_back((pending, message.clone()));
            }
        }
    }

    pub fn client(&mut self, message: &Value) -> bool {
        if matches!(
            message["method"].as_str(),
            Some("thread/start" | "thread/resume" | "thread/fork")
        ) {
            self.thread_requests.insert(message["id"].to_string());
        }
        if message.get("method").is_none() {
            let id = &message["id"];
            if !self.answered.insert(id.to_string()) {
                return false;
            }
            self.pending.retain(|(p, _)| p.rpc_id.as_ref() != Some(id));
        }
        true
    }

    pub fn answer(&mut self, key: &str, answers: &Value) -> Option<Value> {
        let (pending, original) = self
            .pending
            .iter_mut()
            .find(|(p, _)| p.key == key && !p.submitted)?;
        let Some(reply) = mapping::answer(pending, original, answers) else {
            pending.revision += 1;
            return None;
        };
        if let Some(id) = &pending.rpc_id {
            if !self.answered.insert(id.to_string()) {
                return None;
            }
        }
        pending.submitted = true;
        Some(reply)
    }

    fn dismiss_async(&mut self, content: &Value) {
        for input in content.as_array().into_iter().flatten() {
            let Some(text) = input["text"].as_str() else {
                continue;
            };
            let Some(body) = text
                .trim()
                .strip_prefix("<send_user_message_question_reply>")
                .and_then(|text| text.strip_suffix("</send_user_message_question_reply>"))
            else {
                continue;
            };
            if let Ok(Value::Array(replies)) = serde_json::from_str::<Value>(body) {
                for (p, _) in &mut self.pending {
                    if p.rpc_id.is_some() {
                        continue;
                    }
                    if let Some(questions) = p.request["questions"].as_array_mut() {
                        let before = questions.len();
                        questions.retain(|q| {
                            !replies.iter().any(|reply| {
                                let id = reply["questionItemId"].as_str().unwrap_or_default();
                                if id == p.item {
                                    return true;
                                }
                                let Ok(Value::Array(parts)) = serde_json::from_str::<Value>(id)
                                else {
                                    return false;
                                };
                                parts.len() == 3
                                    && parts[0] == "request_user_input_async"
                                    && parts[1] == p.item
                                    && q["id"] == format!("question-{}", parts[2])
                            })
                        });
                        if before != questions.len() {
                            p.revision += 1;
                        }
                    }
                }
                self.pending.retain(|(p, _)| {
                    p.rpc_id.is_some()
                        || p.request["questions"]
                            .as_array()
                            .is_some_and(|q| !q.is_empty())
                });
            }
        }
    }
}

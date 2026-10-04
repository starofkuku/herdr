//! Conversion at the Codex protocol boundary; terminal text is never parsed.
use serde_json::{json, Value};

#[derive(Clone, Debug)]
pub(super) struct Pending {
    pub key: String,
    pub rpc_id: Option<Value>,
    pub thread: String,
    pub turn: String,
    pub item: String,
    pub request: Value,
    pub submitted: bool,
    pub revision: u64,
}

fn text(value: &Value, key: &str) -> String {
    value[key].as_str().unwrap_or_default().to_owned()
}

pub(super) fn request(message: &Value, serial: u64, source: &str) -> Option<Pending> {
    let p = &message["params"];
    let (kind, title, questions, rpc_id) = fields(message)?;
    let key = format!("{source}:{serial}");
    let mut pending = Pending {
        key: key.clone(),
        rpc_id,
        thread: text(p, "threadId"),
        turn: text(p, "turnId"),
        item: text(&p["item"], "id"),
        submitted: false,
        revision: 0,
        request: json!({"source":source,"request_id":key,"kind":kind,"title":title,
            "summary":summary(p),"questions":questions,"created_unix_ms":super::now_ms()}),
    };
    let action_visible = kind != "approval"
        || pending.request["summary"]
            .as_str()
            .is_some_and(|s| !s.trim().is_empty());
    if kind == "notice" || !action_visible || !fits_card(&pending.request) {
        pending.request["kind"] = json!("notice");
        pending.request["questions"] = json!([]);
        pending.request["summary"] = json!("This Codex interaction needs the native terminal controls. Open them to inspect and respond; the request remains pending until Codex resolves it.");
    }
    Some(pending)
}

fn approval_options(p: &Value) -> Vec<Value> {
    let choices = p["availableDecisions"]
        .as_array()
        .cloned()
        .unwrap_or_else(|| vec![json!("accept"), json!("decline"), json!("cancel")]);
    choices
        .iter()
        .filter_map(|choice| {
            let label = match choice.as_str()? {
                "accept" => "Allow once",
                "acceptForSession" => "Allow for session",
                "decline" => "Deny",
                "cancel" => "Cancel turn",
                _ => return None,
            };
            Some(json!({"id":choice,"label":label}))
        })
        .collect()
}

type Fields = (&'static str, &'static str, Value, Option<Value>);
fn fields(message: &Value) -> Option<Fields> {
    let method = message["method"].as_str()?;
    let p = &message["params"];
    Some(match method {
        "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => {
            let options = approval_options(p);
            (
                "approval",
                "Codex approval",
                json!([{"id":"decision",
                "question":p["reason"].as_str().unwrap_or("Allow this action?"),
                "options":options}]),
                Some(message["id"].clone()),
            )
        }
        "item/tool/requestUserInput" => {
            let questions = questions(&p["questions"], false)?;
            (
                "question",
                "Codex question",
                json!(questions),
                Some(message["id"].clone()),
            )
        }
        "item/completed" if p["item"]["delivery"] == "async" => {
            let questions = questions(&p["item"]["questions"], true)?;
            ("question", "Codex question", json!(questions), None)
        }
        _ if message.get("id").is_some()
            && (method.ends_with("requestApproval")
                || method == "mcpServer/elicitation/request") =>
        {
            (
                "notice",
                "Codex interaction",
                json!([]),
                Some(message["id"].clone()),
            )
        }
        _ => return None,
    })
}

fn fits_card(request: &Value) -> bool {
    let Some(questions) = request["questions"].as_array() else {
        return false;
    };
    !questions.is_empty()
        && questions.len() <= 8
        && questions.iter().all(|q| {
            let options = q["options"].as_array();
            q["question"]
                .as_str()
                .is_some_and(|s| !s.trim().is_empty() && s.chars().count() <= 2000)
                && q["header"].as_str().is_none_or(|s| s.chars().count() <= 40)
                && options.is_some_and(|options| {
                    (q["allow_custom"] == true || !options.is_empty())
                        && options.len() <= 12
                        && options.iter().all(|o| {
                            o["label"]
                                .as_str()
                                .is_some_and(|s| !s.trim().is_empty() && s.chars().count() <= 120)
                                && o["description"]
                                    .as_str()
                                    .is_none_or(|s| s.chars().count() <= 1000)
                        })
                })
        })
        && request["summary"]
            .as_str()
            .is_none_or(|s| s.chars().count() <= 2000)
}

fn question(q: &Value, index: usize, asynchronous: bool) -> Value {
    let options: Vec<Value> = q["options"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
        .map(|(i, option)| {
            json!({"id":format!("option-{i}"),
            "label":if asynchronous {option.clone()} else {option["label"].clone()},
            "description":if asynchronous {Value::Null} else {option["description"].clone()}})
        })
        .collect();
    json!({"id":format!("question-{index}"),"question":if asynchronous {&q["title"]} else {&q["question"]},
        "header":q["header"],"allow_custom":asynchronous || options.is_empty() || q["isOther"] == true,
        "options":options})
}

fn summary(p: &Value) -> Option<String> {
    let detail = p
        .get("command")
        .filter(|v| !v.is_null())
        .or_else(|| p.get("changes"))
        .or_else(|| p.get("grantRoot"))?;
    let value = detail
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| detail.to_string());
    Some(value)
}

pub(super) fn answer(pending: &Pending, original: &Value, answers: &Value) -> Option<Value> {
    let answers = answers.as_array()?;
    let questions = pending.request["questions"].as_array()?;
    if questions.is_empty() {
        return None;
    }
    if answers.len() != questions.len() {
        return None;
    }
    let values = answer_values(questions, answers)?;
    if let Some(id) = &pending.rpc_id {
        let result = if pending.request["kind"] == "approval" {
            let choice = answers[0]["option_ids"][0].as_str()?;
            json!({"decision":choice})
        } else {
            let mut mapped = serde_json::Map::new();
            for (q, value) in original["params"]["questions"]
                .as_array()?
                .iter()
                .zip(values)
            {
                mapped.insert(q["id"].as_str()?.into(), json!({"answers":[value]}));
            }
            json!({"answers":mapped})
        };
        Some(json!({"id":id,"result":result}))
    } else {
        let replies: Vec<Value> = questions.iter().zip(values).map(|(q, value)| {
            let index = q["id"].as_str().unwrap_or_default().trim_start_matches("question-").parse::<usize>().unwrap_or_default();
            json!({"questionItemId":json!(["request_user_input_async",pending.item,index]).to_string(),
                "question":q["question"],"answer":value})
        }).collect();
        let text = format!(
            "<send_user_message_question_reply>{}</send_user_message_question_reply>",
            json!(replies)
        );
        Some(
            json!({"id":format!("herdr-answer-{}",pending.key),"method":"turn/steer",
            "params":{"threadId":pending.thread,"expectedTurnId":pending.turn,
                "input":[{"type":"text","text":text,"textElements":[]}]}}),
        )
    }
}

fn answer_values(questions: &[Value], answers: &[Value]) -> Option<Vec<String>> {
    let mut values = Vec::new();
    for q in questions {
        let answer = answers.iter().find(|a| a["question_id"] == q["id"])?;
        let custom = answer["text"].as_str().filter(|s| !s.trim().is_empty());
        let selected = answer["option_ids"].as_array().cloned().unwrap_or_default();
        if custom.is_some() && q["allow_custom"] != true {
            return None;
        }
        if custom.is_none() && selected.len() != 1 {
            return None;
        }
        let value = if let Some(custom) = custom {
            custom.to_owned()
        } else {
            let option = q["options"]
                .as_array()?
                .iter()
                .find(|o| o["id"] == selected[0])?;
            option["label"].as_str()?.to_owned()
        };
        values.push(value);
    }
    Some(values)
}

fn questions(raw: &Value, asynchronous: bool) -> Option<Value> {
    Some(Value::Array(
        raw.as_array()?
            .iter()
            .enumerate()
            .map(|(index, q)| question(q, index, asynchronous))
            .collect(),
    ))
}

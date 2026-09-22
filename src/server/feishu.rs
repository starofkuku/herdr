//! Pushing a notification to a Feishu (Lark) bot.
//!
//! Feishu answers a rejected message with HTTP 200, so the status code says
//! nothing about whether the message was delivered: `code == 0` in the body is
//! the only success signal. A wrong signature and a timestamp more than an hour
//! old share one code and one message, so the reason recorded here names both.
//!
//! The request goes out through `curl`, which is how this crate already reaches
//! an HTTPS URL, on a thread of its own: a push is a network round trip and has
//! no business in the event loop.

use std::io::Write as _;
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use sha2::{Digest, Sha256};

/// Everything a push says, already resolved to text.
pub(crate) struct Push {
    /// Headline, which also carries the state for a glance.
    pub(crate) title: String,
    pub(crate) project: String,
    pub(crate) agent: String,
    pub(crate) state: String,
    pub(crate) summary: String,
    /// Colours the card: something waiting on a person is not the same event as
    /// a task that merely finished.
    pub(crate) attention: bool,
    /// Where to open the conversation, when the gateway is reachable by name.
    pub(crate) link: Option<String>,
}

/// A push that has been decided but is waiting out its delay.
///
/// Held on the app so the event loop owns the timing, the way the toast's own
/// deadline works. Replaced wholesale whenever another change arrives, which is
/// what makes the delay a debounce rather than a queue.
pub(crate) struct PendingPush {
    pub(crate) url: String,
    pub(crate) secret: String,
    pub(crate) push: Push,
}

/// What one push attempt did, for the log.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Outcome {
    Sent,
    /// Feishu refused it. The code and message are what makes this legible: a
    /// lone "failed" would leave the cause unknown.
    Rejected {
        code: i64,
        message: String,
    },
    /// The request never produced an answer.
    Failed(String),
}

/// Signs a request the way Feishu validates it.
///
/// The construction is inverted from the usual one: the key is
/// `"<timestamp>\n<secret>"` and the signed message is empty. Running
/// `printf '' | openssl dgst -sha256 -hmac "$(printf '%s\n%s' "$TS" "$SECRET")"
/// -binary | base64` produces the same bytes, which is what the test pins.
fn sign(timestamp: i64, secret: &str) -> String {
    // HMAC-SHA256 by hand: the crate already has `sha2` and `base64`, and this is
    // one well-defined construction rather than a dependency.
    const BLOCK: usize = 64;

    let mut key = format!("{timestamp}\n{secret}").into_bytes();
    if key.len() > BLOCK {
        key = Sha256::digest(&key).to_vec();
    }
    key.resize(BLOCK, 0);

    let mut inner = Sha256::new();
    inner.update(key.iter().map(|byte| byte ^ 0x36).collect::<Vec<_>>());
    let inner = inner.finalize();

    let mut outer = Sha256::new();
    outer.update(key.iter().map(|byte| byte ^ 0x5c).collect::<Vec<_>>());
    outer.update(inner);

    base64::engine::general_purpose::STANDARD.encode(outer.finalize())
}

/// The request body: an interactive card, signed when a secret is configured.
fn body(push: &Push, timestamp: i64, signature: Option<&str>) -> serde_json::Value {
    let mut value = serde_json::json!({
        "msg_type": "interactive",
        "card": {
            "header": {
                "title": { "tag": "plain_text", "content": push.title },
                "template": if push.attention { "orange" } else { "green" },
            },
            "elements": [
                { "tag": "div", "fields": [
                    { "is_short": true, "text": { "tag": "lark_md",
                        "content": format!("**项目**\n{}", push.project) } },
                    { "is_short": true, "text": { "tag": "lark_md",
                        "content": format!("**Agent**\n{}", push.agent) } },
                    { "is_short": true, "text": { "tag": "lark_md",
                        "content": format!("**状态**\n{}", push.state) } },
                ] },
                { "tag": "hr" },
                { "tag": "div", "text": { "tag": "lark_md", "content": push.summary } },
                { "tag": "note", "elements": [
                    { "tag": "plain_text", "content": format!("herdr · {}", local_time(timestamp)) },
                ] },
            ],
        },
    });

    // The button is what makes a push actionable: a reader who has just been told
    // an agent needs them wants to open it, and a card without a link makes them
    // find the address themselves. Left out when there is no reachable origin,
    // because a button that fails is worse than no button.
    if let Some(link) = &push.link {
        value["card"]["elements"]
            .as_array_mut()
            .expect("elements is an array")
            .push(serde_json::json!({
                "tag": "action",
                "actions": [{
                    "tag": "button",
                    "text": { "tag": "plain_text", "content": "打开对话" },
                    "type": "primary",
                    "url": link,
                }],
            }));
    }

    if let Some(signature) = signature {
        // Both go at the top level of the body; DingTalk puts its pair in the
        // query instead, so this is not interchangeable between the two.
        value["timestamp"] = serde_json::json!(timestamp.to_string());
        value["sign"] = serde_json::json!(signature);
    }

    value
}

/// Whether Feishu's answer means the message was accepted.
fn accepted(answer: &str) -> Outcome {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(answer) else {
        return Outcome::Failed(format!("unreadable answer: {}", answer.trim()));
    };

    let code = value
        .get("code")
        .and_then(|code| code.as_i64())
        .unwrap_or(-1);
    if code == 0 {
        return Outcome::Sent;
    }

    let message = value
        .get("msg")
        .and_then(|msg| msg.as_str())
        .unwrap_or("no message")
        .to_owned();

    // 19021 is what a wrong signature and a stale timestamp both produce, and its
    // wording admits it. Relaying the text alone would send a reader looking for
    // the wrong cause, so the reach of the answer is spelled out here.
    if code == 19021 {
        return Outcome::Rejected {
            code,
            message: format!(
                "{message} (a wrong secret and a clock more than an hour off share this answer)"
            ),
        };
    }

    Outcome::Rejected { code, message }
}

/// Sends the push off the event loop.
pub(crate) fn push_in_background(url: String, secret: String, push: Push) {
    std::thread::spawn(move || match send(&url, &secret, &push) {
        // Info rather than debug: the default filter is `herdr=info`, so a
        // delivered push would otherwise leave no trace at all, and "did it
        // send?" is the question this line exists to answer.
        Outcome::Sent => tracing::info!(title = %push.title, "feishu push delivered"),
        Outcome::Rejected { code, message } => {
            tracing::warn!(code, message = %message, "feishu push rejected")
        }
        Outcome::Failed(err) => tracing::warn!(err = %err, "feishu push failed"),
    });
}

fn send(url: &str, secret: &str, push: &Push) -> Outcome {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or(0);
    let signature = (!secret.is_empty()).then(|| sign(timestamp, secret));
    let payload = body(push, timestamp, signature.as_deref()).to_string();

    let mut child = match Command::new("curl")
        .args([
            "-sS",
            "--max-time",
            "10",
            "-X",
            "POST",
            "-H",
            "Content-Type: application/json",
            // The body goes in on stdin: it carries a signature derived from the
            // secret, and a process argument is readable by anyone who can list
            // processes.
            "--data-binary",
            "@-",
            url,
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(err) => return Outcome::Failed(format!("curl could not start: {err}")),
    };

    if let Some(mut stdin) = child.stdin.take() {
        // A failed write surfaces as a failed exit below, with curl's own words.
        let _ = stdin.write_all(payload.as_bytes());
    }

    let output = match child.wait_with_output() {
        Ok(output) => output,
        Err(err) => return Outcome::Failed(format!("curl did not finish: {err}")),
    };

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Outcome::Failed(err.trim().to_owned());
    }

    accepted(&String::from_utf8_lossy(&output.stdout))
}

/// The moment a push was sent, in the reader's own time zone.
///
/// `chrono` rather than `std`: the standard library stops at a Unix timestamp,
/// and "when did this arrive" is a question a timestamp does not answer without
/// the reader doing arithmetic. The crate is already in the build through
/// `codex-trace-parser`, with `clock` enabled, so this costs no new code.
///
/// An unreadable timestamp renders as UTC instead of failing: the clock is the
/// least important thing on the card, and a push without it is better than no
/// push at all.
fn local_time(timestamp: i64) -> String {
    use chrono::TimeZone as _;

    // One step from the Unix timestamp to local time; the trait has to be in
    // scope for `timestamp_opt`.
    match chrono::Local.timestamp_opt(timestamp, 0) {
        chrono::LocalResult::Single(local) => local.format("%Y-%m-%d %H:%M:%S").to_string(),
        // An ambiguous or out-of-range instant is not worth failing a push over.
        _ => "unknown time".to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The same construction checked against `openssl`, with a throwaway secret.
    ///
    /// A real secret must never appear in a test: this file is committed.
    #[test]
    fn signing_matches_the_openssl_construction() {
        assert_eq!(
            sign(1789983752, "test-secret-for-verification"),
            "GCQf4EmTNcjcLjklRZsDr33eoSohr+UaVdWGZAHvnsw="
        );
    }

    /// The inverted key is what makes it Feishu's scheme rather than the usual one.
    #[test]
    fn signing_is_not_the_conventional_hmac() {
        assert_ne!(
            sign(1789983752, "test-secret-for-verification"),
            // HMAC-SHA256(key = secret, message = timestamp)
            "omFeWNsIjY8/f+piLsYv+FXde08ZYbPYTUJ1204jdDc="
        );
    }

    #[test]
    fn an_accepted_answer_is_a_zero_code() {
        let answer =
            r#"{"StatusCode":0,"StatusMessage":"success","code":0,"data":{},"msg":"success"}"#;
        assert_eq!(accepted(answer), Outcome::Sent);
    }

    /// Captured from the live bot: a rejected message answers 200, so the body is
    /// the only place the refusal is visible.
    #[test]
    fn rejections_are_read_from_the_body_not_the_status() {
        let answer = r#"{"code":19001,"data":{},"msg":"param invalid: incoming webhook access token invalid"}"#;
        assert_eq!(
            accepted(answer),
            Outcome::Rejected {
                code: 19001,
                message: "param invalid: incoming webhook access token invalid".to_owned(),
            }
        );
    }

    #[test]
    fn a_signature_refusal_names_the_timestamp_too() {
        let answer = r#"{"code":19021,"data":{},"msg":"sign match fail or timestamp is not within one hour from current time"}"#;
        let outcome = accepted(answer);
        let Outcome::Rejected { code, message } = outcome else {
            panic!("expected a rejection");
        };
        assert_eq!(code, 19021);
        assert!(message.contains("clock more than an hour off"));
    }

    #[test]
    fn a_body_that_is_not_an_answer_is_a_failure() {
        assert!(matches!(
            accepted("<html>gateway</html>"),
            Outcome::Failed(_)
        ));
    }

    #[test]
    fn an_unsigned_body_carries_no_signature_fields() {
        let push = Push {
            title: "pi finished".to_owned(),
            project: "herdr".to_owned(),
            agent: "pi".to_owned(),
            state: "finished".to_owned(),
            summary: "done".to_owned(),
            attention: false,
            link: None,
        };
        let value = body(&push, 1789983752, None);
        assert!(value.get("sign").is_none());
        assert!(value.get("timestamp").is_none());
        assert_eq!(value["msg_type"], "interactive");
        assert_eq!(value["card"]["header"]["template"], "green");
    }

    #[test]
    fn a_signed_body_puts_the_pair_at_the_top_level() {
        let push = Push {
            title: "pi needs attention".to_owned(),
            project: "herdr".to_owned(),
            agent: "pi".to_owned(),
            state: "needs attention".to_owned(),
            summary: "waiting".to_owned(),
            attention: true,
            link: None,
        };
        let value = body(&push, 1789983752, Some("sig"));
        assert_eq!(value["timestamp"], "1789983752");
        assert_eq!(value["sign"], "sig");
        assert_eq!(value["card"]["header"]["template"], "orange");
    }
}

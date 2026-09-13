//! Wire protocol between the browser UI and the web gateway.
//!
//! This is deliberately separate from `crate::protocol` (the private
//! server/client terminal format). The browser speaks the public JSON API, so
//! this protocol only carries authentication, session selection, and
//! passthrough of API requests, responses, and subscription events.
//!
//! It is versioned independently: the gateway advertises
//! [`PROTOCOL_VERSION`] on connect and rejects a mismatched client, so a
//! cached page never talks to an incompatible gateway.

use serde::{Deserialize, Serialize};

/// Version of the browser-facing protocol.
///
/// Bump only for incompatible changes. The page is cached by browsers, so the
/// gateway should stay tolerant of older clients for as long as practical.
pub(crate) const PROTOCOL_VERSION: u32 = 2;

/// Messages sent from the browser to the gateway.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum ClientMessage {
    /// Authenticate this connection. Must be the first message.
    Auth {
        key: String,
        #[serde(default)]
        protocol: Option<u32>,
    },
    /// List known sessions.
    SessionsList,
    /// Bind this connection to a session, starting its server if needed.
    UseSession { name: String },
    /// Forward one API request to the bound session.
    Api {
        id: String,
        method: String,
        #[serde(default)]
        params: serde_json::Value,
    },
    /// Start a subscription on the bound session.
    Subscribe {
        id: String,
        subscriptions: Vec<serde_json::Value>,
    },
    /// Stop a subscription started earlier.
    Unsubscribe { id: String },
}

/// One Herdr session as presented to the browser.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct SessionSummary {
    pub name: String,
    pub default: bool,
    pub running: bool,
}

/// Messages sent from the gateway to the browser.
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum ServerMessage {
    /// Handshake result.
    Hello { protocol: u32, authenticated: bool },
    /// Session list response.
    Sessions { items: Vec<SessionSummary> },
    /// The connection is now bound to a session and its server is running.
    SessionReady { name: String },
    /// Result of an [`ClientMessage::Api`] request.
    ///
    /// `result` carries the API's own response envelope unchanged so the
    /// browser observes exactly what any other API client sees.
    ApiResult {
        id: String,
        result: serde_json::Value,
    },
    /// One subscription event, or the subscription's opening acknowledgment.
    Event {
        id: String,
        payload: serde_json::Value,
    },
    /// A subscription ended; the browser may re-subscribe.
    EventClosed { id: String, reason: String },
    /// Request failed at the gateway layer (not an API error envelope).
    Error { message: String },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_frame_without_protocol_parses() {
        let parsed: ClientMessage =
            serde_json::from_str(r#"{"type":"auth","key":"secret-value"}"#).unwrap();
        assert!(matches!(parsed, ClientMessage::Auth { protocol: None, .. }));
    }

    #[test]
    fn api_frame_parses_with_typed_params() {
        let parsed: ClientMessage = serde_json::from_str(
            r#"{"type":"api","id":"a1","method":"pane.read","params":{"pane_id":"w1:p1"}}"#,
        )
        .unwrap();
        match parsed {
            ClientMessage::Api { id, method, params } => {
                assert_eq!(id, "a1");
                assert_eq!(method, "pane.read");
                assert_eq!(params["pane_id"], "w1:p1");
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn api_frame_allows_missing_params() {
        let parsed: ClientMessage =
            serde_json::from_str(r#"{"type":"api","id":"a2","method":"agent.list"}"#).unwrap();
        assert!(matches!(parsed, ClientMessage::Api { .. }));
    }

    #[test]
    fn subscribe_frame_parses() {
        let parsed: ClientMessage = serde_json::from_str(
            r#"{"type":"subscribe","id":"s1","subscriptions":[{"type":"pane.agent_status_changed"}]}"#,
        )
        .unwrap();
        match parsed {
            ClientMessage::Subscribe { id, subscriptions } => {
                assert_eq!(id, "s1");
                assert_eq!(subscriptions.len(), 1);
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn api_result_serializes_with_type_tag() {
        let message = ServerMessage::ApiResult {
            id: "a1".to_string(),
            result: serde_json::json!({"ok": true}),
        };
        let json = serde_json::to_string(&message).unwrap();
        assert!(json.contains(r#""type":"api_result""#), "{json}");
        assert!(json.contains(r#""id":"a1""#), "{json}");
    }

    #[test]
    fn session_ready_serializes_with_type_tag() {
        let message = ServerMessage::SessionReady {
            name: "default".to_string(),
        };
        assert_eq!(
            serde_json::to_string(&message).unwrap(),
            r#"{"type":"session_ready","name":"default"}"#
        );
    }
}

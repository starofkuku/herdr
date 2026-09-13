//! Wire protocol between the browser UI and the web gateway.
//!
//! This is deliberately separate from `crate::protocol` (the private
//! server/client wire format). The browser only ever speaks this JSON
//! protocol, so changes to `PROTOCOL_VERSION` never break a deployed page.
//!
//! The protocol is versioned: the gateway advertises [`PROTOCOL_VERSION`] on
//! connect, clients may send `protocol` on their first frame, and the gateway
//! rejects a mismatched major version instead of misbehaving.

use serde::{Deserialize, Serialize};

/// Version of the browser-facing JSON protocol.
///
/// Bump only for incompatible changes, and keep the gateway tolerant of older
/// clients for as long as practical: the page is cached by browsers.
pub(crate) const PROTOCOL_VERSION: u32 = 1;

/// One Herdr session as presented to the browser.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct SessionSummary {
    pub name: String,
    pub default: bool,
    pub running: bool,
}

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
    /// Attach to a session, creating it if it does not exist.
    SessionOpen {
        name: String,
        #[serde(default)]
        cols: Option<u16>,
        #[serde(default)]
        rows: Option<u16>,
    },
    /// Terminal input. `data` is base64-encoded bytes.
    Input { data: String },
    /// Viewport resize.
    Resize { cols: u16, rows: u16 },
    /// Detach from the current session but keep the connection for reuse.
    SessionClose,
}

/// Messages sent from the gateway to the browser.
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum ServerMessage {
    /// Handshake result.
    Hello {
        protocol: u32,
        /// False when no key is configured or the key was rejected.
        authenticated: bool,
    },
    /// Session list response.
    Sessions { items: Vec<SessionSummary> },
    /// A session attachment started. Frames follow.
    Opened { name: String },
    /// Terminal output. `data` is base64-encoded ANSI bytes.
    Frame {
        seq: u64,
        cols: u16,
        rows: u16,
        full: bool,
        data: String,
    },
    /// The attachment ended.
    Closed { reason: Option<String> },
    /// Host mouse reporting should be enabled or disabled.
    MouseMode { enabled: bool },
    /// Request failed or the key was rejected.
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
    fn session_open_defaults_sizes() {
        let parsed: ClientMessage =
            serde_json::from_str(r#"{"type":"session_open","name":"main"}"#).unwrap();
        match parsed {
            ClientMessage::SessionOpen { name, cols, rows } => {
                assert_eq!(name, "main");
                assert_eq!(cols, None);
                assert_eq!(rows, None);
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn frame_serializes_with_type_tag() {
        let message = ServerMessage::Closed { reason: None };
        let json = serde_json::to_string(&message).unwrap();
        assert_eq!(json, r#"{"type":"closed","reason":null}"#);
    }

    #[test]
    fn mouse_mode_serializes_with_type_tag() {
        let message = ServerMessage::MouseMode { enabled: true };
        let json = serde_json::to_string(&message).unwrap();
        assert_eq!(json, r#"{"type":"mouse_mode","enabled":true}"#);
    }
}

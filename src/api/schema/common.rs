use serde::{Deserialize, Serialize};

pub(super) fn metadata_token_patch_schema(
    _generator: &mut schemars::SchemaGenerator,
) -> schemars::Schema {
    schemars::json_schema!({
        "type": "object",
        "maxProperties": 16,
        "propertyNames": { "pattern": "^[A-Za-z0-9_-]{1,32}$" },
        "additionalProperties": { "type": ["string", "null"] }
    })
}

pub(super) fn metadata_token_values_schema(
    _generator: &mut schemars::SchemaGenerator,
) -> schemars::Schema {
    schemars::json_schema!({
        "type": "object",
        "maxProperties": 32,
        "propertyNames": { "pattern": "^[A-Za-z0-9_-]{1,32}$" },
        "additionalProperties": { "type": "string" }
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema, Default)]
pub struct EmptyParams {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct WorkspaceTarget {
    pub workspace_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct PaneTarget {
    pub pane_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct TabTarget {
    pub tab_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct AgentTarget {
    pub target: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct ClientWindowTitleSetParams {
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SplitDirection {
    Right,
    Down,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ReadSource {
    Visible,
    Recent,
    RecentUnwrapped,
    Detection,
}

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema, Default,
)]
#[serde(rename_all = "snake_case")]
pub enum ReadFormat {
    #[default]
    Text,
    Ansi,
}

/// Which notification settings to write.
///
/// Every field is optional and only the ones present are written, so a client
/// toggling one switch cannot clobber the rest. The surface is deliberately this
/// small: these are the settings a reader would reasonably want from a phone,
/// and the keys left out decide where files land and what an agent can run.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema, Default)]
pub struct ConfigNotificationSetParams {
    /// One of `off`, `herdr`, `terminal`, `system`. A string rather than the enum
    /// because the enum has no JSON schema, and the value is validated when it is
    /// parsed on the way in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub toast_delivery: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub toast_delay_seconds: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bell_enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sound_enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub feishu_enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub feishu_url: Option<String>,
    /// A new signing key. Absent leaves the stored one alone, which is what lets
    /// the field be shown empty while a secret is in fact configured.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub feishu_secret: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub feishu_delay_seconds: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct NotificationShowParams {
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub position: Option<crate::config::ToastHerdrPosition>,
    #[serde(default, skip_serializing_if = "NotificationShowSound::is_none")]
    pub sound: NotificationShowSound,
}

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema, Default,
)]
#[serde(rename_all = "snake_case")]
pub enum NotificationShowSound {
    #[default]
    None,
    Done,
    Request,
}

impl NotificationShowSound {
    pub fn is_none(&self) -> bool {
        matches!(self, Self::None)
    }

    pub fn to_sound(self) -> Option<crate::sound::Sound> {
        match self {
            Self::None => None,
            Self::Done => Some(crate::sound::Sound::Done),
            Self::Request => Some(crate::sound::Sound::Request),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum NotificationShowReason {
    Shown,
    Disabled,
    RateLimited,
    NoForegroundClient,
    Busy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ClientWindowTitleReason {
    Set,
    Cleared,
    NoForegroundClient,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PaneAgentState {
    Idle,
    Working,
    Blocked,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AgentStatus {
    Idle,
    Working,
    Blocked,
    Done,
    Unknown,
}

pub(crate) fn default_true() -> bool {
    true
}

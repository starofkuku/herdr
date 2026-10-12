//! `schedule.*` — prompts sent to a pane at a wall-clock time.
//!
//! The server owns these because it is the part that is always running and
//! always holds the panes: a schedule has to outlive the agent it talks to
//! (which may be crashed or between sessions) and the client that made it
//! (which may be closed). See `src/prompt_schedule.rs` for the model.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct ScheduleCreateParams {
    pub pane_id: String,
    /// When to send it, in local time: a full date (`YYYY-MM-DD HH:MM[:SS]` or
    /// with a `T` separator), or a clock time (`HH:MM[:SS]`) for the next
    /// occurrence — today, or tomorrow once it has passed.
    pub at: String,
    /// The text to send, written to the pane's terminal exactly as a typed
    /// message would be.
    pub message: String,
}

/// What a schedule came to. Only `pending` acts; the rest are a record, kept
/// so the list can say what happened instead of quietly forgetting it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum PromptScheduleStatus {
    Pending,
    Fired,
    /// The time came and went without the prompt being sent — the server was
    /// not running, or the pane was gone. Recorded, never retried: the moment
    /// was the point.
    Missed,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct PromptScheduleInfo {
    pub id: String,
    /// The pane's public id as it was when the schedule was made. Shown as it
    /// was: if the pane has since closed, resolving this name finds nothing,
    /// which is itself the answer.
    pub pane_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    /// When the prompt is due, local time, `YYYY-MM-DD HH:MM:SS`.
    pub due: String,
    pub message: String,
    pub status: PromptScheduleStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct ScheduleCancelParams {
    pub schedule_id: String,
}

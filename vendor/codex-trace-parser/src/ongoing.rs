use super::turn::{CodexTurn, TurnStatus};

/// Check if a session is currently ongoing.
pub fn is_session_ongoing(turns: &[CodexTurn]) -> bool {
    turns
        .last()
        .map(|t| t.status == TurnStatus::Ongoing)
        .unwrap_or(false)
}

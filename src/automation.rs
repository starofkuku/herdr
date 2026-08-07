//! Small, server-owned automation controllers.
//!
//! These controllers keep retry policy separate from terminal rendering and
//! from the pure `AppState`. They are driven by observed runtime events and
//! are intentionally conservative about duplicate input.

use std::collections::HashMap;

use crate::layout::PaneId;

/// Codex's user-facing capacity error. Keep this exact because other blocked
/// prompts must never receive an unsolicited answer.
pub const CODEX_CAPACITY_ERROR: &str =
    "Selected model is at capacity. Please try a different model.";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct RetryAttempt {
    /// A stable key for the currently visible capacity-error occurrence.
    ///
    /// The key deliberately ends at the error text. Herdr's own echoed input
    /// appears after the error and must not be mistaken for a new upstream
    /// response. A later upstream response appends another occurrence, which
    /// changes the prefix and therefore the key.
    occurrence_key: u64,
    attempts: i32,
}

#[derive(Debug, Default)]
pub(crate) struct CodexCapacityRetryController {
    attempts: HashMap<PaneId, RetryAttempt>,
}

impl CodexCapacityRetryController {
    /// Clear the occurrence state when the capacity message is no longer
    /// visible (or when the pane is no longer Codex).
    pub(crate) fn clear(&mut self, pane_id: PaneId) {
        self.attempts.remove(&pane_id);
    }

    pub(crate) fn clear_all(&mut self) {
        self.attempts.clear();
    }

    /// Return whether a reply may be sent for this occurrence. The attempt is
    /// committed only after the caller successfully writes the bytes to the
    /// pane runtime.
    pub(crate) fn can_attempt(
        &self,
        pane_id: PaneId,
        occurrence_key: u64,
        max_retries: i32,
    ) -> bool {
        if max_retries == 0 || max_retries < -1 {
            return false;
        }
        let Some(previous) = self.attempts.get(&pane_id) else {
            return true;
        };
        if previous.occurrence_key != occurrence_key {
            return max_retries == -1 || previous.attempts < max_retries;
        }
        // A capacity error occurrence is consumed by one automatic reply.
        // `-1` permits every later occurrence, but never a stable refresh of
        // the same one.
        false
    }

    pub(crate) fn record_attempt(&mut self, pane_id: PaneId, occurrence_key: u64) {
        let entry = self.attempts.entry(pane_id).or_insert(RetryAttempt {
            occurrence_key,
            attempts: 0,
        });
        if entry.occurrence_key != occurrence_key {
            *entry = RetryAttempt {
                occurrence_key,
                attempts: 0,
            };
        }
        entry.attempts = entry.attempts.saturating_add(1);
    }

    #[cfg(test)]
    pub(crate) fn attempts(&self, pane_id: PaneId) -> i32 {
        self.attempts
            .get(&pane_id)
            .map_or(0, |state| state.attempts)
    }
}

/// Build a stable identity for the currently visible capacity-error
/// occurrence. The prefix through the end of the last matching error is used
/// so input echoed after the error does not retrigger automation, while a new
/// upstream response (a later matching error) does.
pub(crate) fn codex_capacity_occurrence_key(detection_text: &str) -> Option<u64> {
    let error = CODEX_CAPACITY_ERROR;
    let end = detection_text.rfind(error)?.saturating_add(error.len());
    let occurrence = detection_text.get(..end)?.trim_end();

    // `DefaultHasher` is sufficient here: this key is only an in-memory
    // occurrence token and is never persisted or exposed as a security value.
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    occurrence.hash(&mut hasher);
    Some(hasher.finish())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_retry_allows_one_attempt() {
        let pane = PaneId::from_raw(1);
        let controller = CodexCapacityRetryController::default();
        assert!(controller.can_attempt(pane, 1, 7));
    }

    #[test]
    fn max_retries_zero_and_other_negative_values_disable() {
        let pane = PaneId::from_raw(1);
        let controller = CodexCapacityRetryController::default();
        assert!(!controller.can_attempt(pane, 7, 0));
        assert!(!controller.can_attempt(pane, 7, -2));
    }

    #[test]
    fn finite_attempts_stop_at_limit() {
        let pane = PaneId::from_raw(1);
        let mut controller = CodexCapacityRetryController::default();
        controller.record_attempt(pane, 7);
        assert!(!controller.can_attempt(pane, 7, 1));
        assert_eq!(controller.attempts(pane), 1);
    }

    #[test]
    fn stable_occurrence_is_not_retried_even_when_unlimited() {
        let pane = PaneId::from_raw(1);
        let mut controller = CodexCapacityRetryController::default();
        controller.record_attempt(pane, 7);
        assert!(!controller.can_attempt(pane, 7, -1));
        assert!(!controller.can_attempt(pane, 7, -1));
    }

    #[test]
    fn clear_rearms_a_new_occurrence() {
        let pane = PaneId::from_raw(1);
        let mut controller = CodexCapacityRetryController::default();
        controller.record_attempt(pane, 7);
        controller.clear(pane);
        assert!(controller.can_attempt(pane, 7, 1));
    }

    #[test]
    fn a_new_occurrence_rearms_without_clearing_the_pane() {
        let pane = PaneId::from_raw(1);
        let mut controller = CodexCapacityRetryController::default();
        controller.record_attempt(pane, 7);
        assert!(controller.can_attempt(pane, 8, -1));
    }

    #[test]
    fn occurrence_key_ignores_text_after_the_error() {
        let first = format!("output\n{CODEX_CAPACITY_ERROR}\n继续");
        let second = format!("output\n{CODEX_CAPACITY_ERROR}\n继续\nmore echo");
        assert_eq!(
            codex_capacity_occurrence_key(&first),
            codex_capacity_occurrence_key(&second)
        );
    }

    #[test]
    fn occurrence_key_changes_for_a_later_upstream_error() {
        let first = format!("output\n{CODEX_CAPACITY_ERROR}\n继续");
        let second = format!("output\n{CODEX_CAPACITY_ERROR}\n继续\nreply\n{CODEX_CAPACITY_ERROR}");
        assert_ne!(
            codex_capacity_occurrence_key(&first),
            codex_capacity_occurrence_key(&second)
        );
    }
}

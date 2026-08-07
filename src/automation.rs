//! Small, server-owned automation controllers.
//!
//! These controllers keep retry policy separate from terminal rendering and
//! from the pure `AppState`. They are driven by observed runtime events and
//! are intentionally conservative about duplicate input.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use crate::layout::PaneId;

/// Codex's user-facing capacity error. Keep this exact because other blocked
/// prompts must never receive an unsolicited answer.
pub const CODEX_CAPACITY_ERROR: &str =
    "Selected model is at capacity. Please try a different model.";

/// Minimum spacing between automatic replies for one pane. Detection emits a
/// stable blocker refresh periodically; without a debounce, infinite retries
/// would flood the agent input queue.
const RETRY_COOLDOWN: Duration = Duration::from_secs(1);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct RetryAttempt {
    attempts: i32,
    last_attempt_at: Option<Instant>,
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

    /// Return whether a reply may be sent now. The attempt is committed only
    /// after the caller successfully writes the bytes to the pane runtime.
    pub(crate) fn can_attempt(&self, pane_id: PaneId, max_retries: i32, now: Instant) -> bool {
        if max_retries == 0 || max_retries < -1 {
            return false;
        }
        let Some(previous) = self.attempts.get(&pane_id) else {
            return true;
        };
        if max_retries != -1 && previous.attempts >= max_retries {
            return false;
        }
        previous
            .last_attempt_at
            .is_none_or(|last| now.saturating_duration_since(last) >= RETRY_COOLDOWN)
    }

    pub(crate) fn record_attempt(&mut self, pane_id: PaneId, now: Instant) {
        let entry = self.attempts.entry(pane_id).or_insert(RetryAttempt {
            attempts: 0,
            last_attempt_at: None,
        });
        entry.attempts = entry.attempts.saturating_add(1);
        entry.last_attempt_at = Some(now);
    }

    #[cfg(test)]
    pub(crate) fn attempts(&self, pane_id: PaneId) -> i32 {
        self.attempts
            .get(&pane_id)
            .map_or(0, |state| state.attempts)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_retry_allows_one_attempt() {
        let pane = PaneId::from_raw(1);
        let controller = CodexCapacityRetryController::default();
        assert!(controller.can_attempt(pane, 1, Instant::now()));
    }

    #[test]
    fn max_retries_zero_and_other_negative_values_disable() {
        let pane = PaneId::from_raw(1);
        let controller = CodexCapacityRetryController::default();
        assert!(!controller.can_attempt(pane, 0, Instant::now()));
        assert!(!controller.can_attempt(pane, -2, Instant::now()));
    }

    #[test]
    fn finite_attempts_stop_at_limit() {
        let pane = PaneId::from_raw(1);
        let now = Instant::now();
        let mut controller = CodexCapacityRetryController::default();
        controller.record_attempt(pane, now - RETRY_COOLDOWN);
        assert!(!controller.can_attempt(pane, 1, now));
        assert_eq!(controller.attempts(pane), 1);
    }

    #[test]
    fn infinite_attempts_are_debounced_and_rearmed_after_cooldown() {
        let pane = PaneId::from_raw(1);
        let now = Instant::now();
        let mut controller = CodexCapacityRetryController::default();
        controller.record_attempt(pane, now);
        assert!(!controller.can_attempt(pane, -1, now));
        assert!(controller.can_attempt(pane, -1, now + RETRY_COOLDOWN));
    }

    #[test]
    fn clear_rearms_a_new_occurrence() {
        let pane = PaneId::from_raw(1);
        let now = Instant::now();
        let mut controller = CodexCapacityRetryController::default();
        controller.record_attempt(pane, now);
        controller.clear(pane);
        assert!(controller.can_attempt(pane, 1, now));
    }
}

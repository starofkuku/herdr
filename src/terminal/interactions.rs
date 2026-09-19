use std::time::{Duration, Instant};

use crate::api::schema::{PaneInteractionAnswer, PaneInteractionRequest};

/// How long a withdrawn request's sequence is remembered.
///
/// A sequence is kept after the request goes away so a late or replayed report
/// from the agent cannot resurrect a question the user already answered. The
/// same reasoning as `PaneDiagnostics`: monotonic sequences are what make an
/// out-of-order arrival harmless.
const MAX_INTERACTION_SEQUENCE_KEYS: usize = 32;

#[derive(Debug, Clone)]
struct PaneInteractionRecord {
    request: PaneInteractionRequest,
    expires_at: Option<Instant>,
}

/// The deadline a republished request should keep.
///
/// A refresh may only ever extend the wait, never shorten it: the integration is
/// renewing its own question, so taking a smaller value would expire a prompt
/// the user is still reading. `None` means "no deadline", which stays unbounded.
fn later_deadline(current: Option<Instant>, renewed: Option<Instant>) -> Option<Instant> {
    match (current, renewed) {
        (None, _) => None,
        (Some(_), None) => current,
        (Some(current), Some(renewed)) => Some(current.max(renewed)),
    }
}

/// The question a pane is waiting on, if any.
///
/// One at a time by construction: an agent that asks something new has moved on
/// from the previous question, so a replacement supersedes rather than queues.
/// Queuing would leave stale questions answerable long after the agent stopped
/// caring about them.
#[derive(Debug, Default)]
pub(crate) struct PaneInteractions {
    active: Option<PaneInteractionRecord>,
    /// Highest sequence accepted per `(source, request_id)`.
    sequences: std::collections::HashMap<(String, String), u64>,
    /// Answers waiting to be collected by the integration that asked.
    pending_answers: std::collections::HashMap<(String, String), Vec<PaneInteractionAnswer>>,
}

impl PaneInteractions {
    /// Registers or replaces the pane's pending question.
    ///
    /// Returns whether the visible request changed. A stale sequence is ignored,
    /// which is what keeps a report delivered out of order from overwriting the
    /// question the user is currently looking at.
    pub(crate) fn report(
        &mut self,
        request: PaneInteractionRequest,
        seq: Option<u64>,
        ttl: Option<Duration>,
        now: Instant,
    ) -> Result<bool, PaneInteractionError> {
        let key = (request.source.clone(), request.request_id.clone());
        if !self.sequence_is_fresh(&key, seq) {
            return Ok(false);
        }
        self.accept_sequence(&key, seq)?;

        let expires_at = ttl.and_then(|ttl| now.checked_add(ttl));
        let changed = self
            .active
            .as_ref()
            .is_none_or(|record| record.request != request);
        // A republish of the question the pane is already waiting on refreshes
        // its deadline instead of restarting the wait. An integration that waits
        // for an answer polls by republishing, so without this a prompt the user
        // is still reading would expire underneath them.
        let expires_at = match self.active.as_ref() {
            Some(record) if record.request == request => {
                later_deadline(record.expires_at, expires_at)
            }
            _ => expires_at,
        };
        // A new question replaces the old one, and any answer queued for the old
        // one is dropped with it: it can no longer be applied to anything.
        if changed {
            if let Some(previous) = self.active.take() {
                self.pending_answers
                    .remove(&(previous.request.source, previous.request.request_id));
            }
        }
        self.active = Some(PaneInteractionRecord {
            request,
            expires_at,
        });
        Ok(changed)
    }

    /// Withdraws the pending question.
    ///
    /// `request_id` is required so a client clearing a question it saw cannot
    /// accidentally clear a newer one that replaced it in the meantime.
    pub(crate) fn clear(
        &mut self,
        source: &str,
        request_id: &str,
        seq: Option<u64>,
    ) -> Result<bool, PaneInteractionError> {
        let key = (source.to_string(), request_id.to_string());
        if !self.sequence_is_fresh(&key, seq) {
            return Ok(false);
        }
        self.accept_sequence(&key, seq)?;
        self.pending_answers.remove(&key);
        let cleared = self.active.as_ref().is_some_and(|record| {
            record.request.source == source && record.request.request_id == request_id
        });
        if cleared {
            self.active = None;
        }
        Ok(cleared)
    }

    pub(crate) fn active(&self, now: Instant) -> Option<&PaneInteractionRequest> {
        let record = self.active.as_ref()?;
        record
            .expires_at
            .is_none_or(|expires_at| expires_at > now)
            .then_some(&record.request)
    }

    /// Records an answer for the integration to collect.
    ///
    /// The answer is addressed by `request_id`, so an answer for a question that
    /// already expired or was replaced is rejected instead of being applied to
    /// whatever is pending now. That is the failure mode worth preventing: the
    /// user answering one prompt and the agent receiving it as an answer to a
    /// different one.
    ///
    /// Answering withdraws the request from `active` immediately, because the
    /// question is settled from the reader's point of view and the UI must stop
    /// offering it. The queued answer is kept until the integration collects it:
    /// the agent has not consumed it yet, so discarding it here would lose the
    /// user's choice.
    pub(crate) fn answer(
        &mut self,
        request_id: &str,
        answers: Vec<PaneInteractionAnswer>,
        now: Instant,
    ) -> Result<String, PaneInteractionError> {
        let Some(record) = self.active.as_ref() else {
            return Err(PaneInteractionError::NoPendingRequest);
        };
        if record.request.request_id != request_id {
            return Err(PaneInteractionError::RequestMismatch);
        }
        if record
            .expires_at
            .is_some_and(|expires_at| expires_at <= now)
        {
            return Err(PaneInteractionError::Expired);
        }
        let source = record.request.source.clone();
        self.pending_answers
            .insert((source.clone(), request_id.to_string()), answers);
        self.active = None;
        Ok(source)
    }

    /// Takes the answer queued for `(source, request_id)`, if any.
    ///
    /// Taking clears it, so an integration polls until it gets an answer rather
    /// than re-applying one it already handled.
    pub(crate) fn take_answer(
        &mut self,
        source: &str,
        request_id: &str,
    ) -> Option<Vec<PaneInteractionAnswer>> {
        self.pending_answers
            .remove(&(source.to_string(), request_id.to_string()))
    }

    /// Whether this exact request is still the pane's pending question.
    ///
    /// This is what lets an integration waiting on an answer tell "the user has
    /// not answered yet" (`pending`, no answers) from "the wait is over" (not
    /// pending: the request was answered, withdrawn, or expired). Without it a
    /// poller cannot know when to stop waiting and would hold the agent back.
    pub(crate) fn is_pending(&self, source: &str, request_id: &str) -> bool {
        self.active.as_ref().is_some_and(|record| {
            record.request.source == source && record.request.request_id == request_id
        })
    }

    pub(crate) fn expire_at(&mut self, now: Instant) -> bool {
        let expired = self.active.as_ref().is_some_and(|record| {
            record
                .expires_at
                .is_some_and(|expires_at| expires_at <= now)
        });
        if expired {
            if let Some(record) = self.active.take() {
                self.pending_answers
                    .remove(&(record.request.source, record.request.request_id));
            }
        }
        expired
    }

    pub(crate) fn next_expiry(&self) -> Option<Instant> {
        self.active.as_ref().and_then(|record| record.expires_at)
    }

    fn sequence_is_fresh(&self, key: &(String, String), seq: Option<u64>) -> bool {
        match (self.sequences.get(key), seq) {
            (Some(previous), Some(seq)) => seq > *previous,
            (Some(_), None) => false,
            _ => true,
        }
    }

    fn accept_sequence(
        &mut self,
        key: &(String, String),
        seq: Option<u64>,
    ) -> Result<(), PaneInteractionError> {
        let Some(seq) = seq else {
            return Ok(());
        };
        if !self.sequences.contains_key(key)
            && self.sequences.len() >= MAX_INTERACTION_SEQUENCE_KEYS
        {
            return Err(PaneInteractionError::SequenceLimit);
        }
        self.sequences.insert(key.clone(), seq);
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PaneInteractionError {
    /// Nothing is pending, so there is nothing to answer.
    NoPendingRequest,
    /// The answer names a different request than the pending one.
    RequestMismatch,
    /// The pending request's deadline passed.
    Expired,
    /// Too many sequence sources tracked for this pane.
    SequenceLimit,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::schema::{PaneInteractionKind, PaneInteractionQuestion};

    fn request(id: &str, title: &str) -> PaneInteractionRequest {
        PaneInteractionRequest {
            source: "test.agent".into(),
            request_id: id.into(),
            kind: PaneInteractionKind::Question,
            title: Some(title.into()),
            summary: None,
            questions: vec![PaneInteractionQuestion {
                id: "q1".into(),
                header: None,
                question: "Pick one".into(),
                multi_select: false,
                allow_custom: false,
                options: Vec::new(),
            }],
            created_unix_ms: 1,
        }
    }

    fn answer(option: &str) -> PaneInteractionAnswer {
        PaneInteractionAnswer {
            question_id: "q1".into(),
            option_ids: vec![option.into()],
            text: None,
        }
    }

    #[test]
    fn stale_sequence_does_not_replace_the_pending_request() {
        let now = Instant::now();
        let mut interactions = PaneInteractions::default();
        assert!(interactions
            .report(request("r1", "first"), Some(10), None, now)
            .unwrap());
        // A lower sequence is a replay of an older report and must not win.
        assert!(!interactions
            .report(request("r1", "stale"), Some(9), None, now)
            .unwrap());
        assert_eq!(
            interactions.active(now).unwrap().title.as_deref(),
            Some("first")
        );
    }

    #[test]
    fn a_new_request_supersedes_the_previous_one() {
        let now = Instant::now();
        let mut interactions = PaneInteractions::default();
        interactions
            .report(request("r1", "first"), None, None, now)
            .unwrap();
        interactions
            .report(request("r2", "second"), None, None, now)
            .unwrap();
        assert_eq!(interactions.active(now).unwrap().request_id, "r2");
    }

    #[test]
    fn an_answer_is_visible_to_a_poller_before_it_is_collected() {
        let now = Instant::now();
        let mut interactions = PaneInteractions::default();
        interactions
            .report(request("r1", "first"), None, None, now)
            .unwrap();
        // An integration polls while it waits. Before an answer arrives the
        // question is still pending, which is what tells the poller to keep
        // waiting rather than give up.
        assert!(interactions.is_pending("test.agent", "r1"));
        assert!(interactions.take_answer("test.agent", "r1").is_none());
        interactions.answer("r1", vec![answer("a")], now).unwrap();
        // Answering withdraws the question, so the poll that collects the answer
        // also sees that the wait is over.
        assert!(!interactions.is_pending("test.agent", "r1"));
        assert!(interactions.take_answer("test.agent", "r1").is_some());
        // And collecting is one-shot, so the wait cannot re-read it forever.
        assert!(interactions.take_answer("test.agent", "r1").is_none());
    }

    #[test]
    fn republishing_the_pending_question_refreshes_its_deadline() {
        let now = Instant::now();
        let mut interactions = PaneInteractions::default();
        let ttl = Some(Duration::from_secs(10));
        interactions
            .report(request("r1", "first"), None, ttl, now)
            .unwrap();
        // An integration waiting for an answer republishes its request as it
        // polls. The user is still reading the same prompt, so the deadline must
        // move with it rather than expire the question underneath them.
        let later = now + Duration::from_secs(9);
        assert!(!interactions
            .report(request("r1", "first"), None, ttl, later)
            .unwrap());
        let after_original_expiry = now + Duration::from_secs(12);
        assert!(interactions.active(after_original_expiry).is_some());
    }

    #[test]
    fn republishing_does_not_keep_an_unanswered_question_alive_forever() {
        let now = Instant::now();
        let mut interactions = PaneInteractions::default();
        // No ttl is an unbounded wait, which is the documented behaviour for a
        // request whose agent has no deadline of its own.
        interactions
            .report(request("r1", "first"), None, None, now)
            .unwrap();
        let much_later = now + Duration::from_secs(86_400);
        assert!(!interactions
            .report(request("r1", "first"), None, None, much_later)
            .unwrap());
        assert!(interactions.active(much_later).is_some());
    }

    #[test]
    fn a_replaced_question_is_not_the_pending_one() {
        let now = Instant::now();
        let mut interactions = PaneInteractions::default();
        interactions
            .report(request("r1", "first"), None, None, now)
            .unwrap();
        interactions
            .report(request("r2", "second"), None, None, now)
            .unwrap();
        // The first poller must learn its question is gone, so it stops waiting
        // and hands the decision back instead of blocking the agent forever.
        assert!(!interactions.is_pending("test.agent", "r1"));
        assert!(interactions.is_pending("test.agent", "r2"));
    }

    #[test]
    fn a_withdrawn_question_is_not_pending() {
        let now = Instant::now();
        let mut interactions = PaneInteractions::default();
        interactions
            .report(request("r1", "first"), None, None, now)
            .unwrap();
        interactions.clear("test.agent", "r1", None).unwrap();
        assert!(!interactions.is_pending("test.agent", "r1"));
    }

    #[test]
    fn an_expired_question_is_not_pending() {
        let now = Instant::now();
        let mut interactions = PaneInteractions::default();
        interactions
            .report(
                request("r1", "first"),
                None,
                Some(Duration::from_secs(1)),
                now,
            )
            .unwrap();
        assert!(interactions.is_pending("test.agent", "r1"));
        interactions.expire_at(now + Duration::from_secs(2));
        assert!(!interactions.is_pending("test.agent", "r1"));
    }

    #[test]
    fn answering_a_superseded_request_is_rejected() {
        let now = Instant::now();
        let mut interactions = PaneInteractions::default();
        interactions
            .report(request("r1", "first"), None, None, now)
            .unwrap();
        interactions
            .report(request("r2", "second"), None, None, now)
            .unwrap();
        // The user answered the question that is no longer pending. Applying it
        // to `r2` would answer a different question than they saw.
        assert_eq!(
            interactions.answer("r1", vec![answer("a")], now),
            Err(PaneInteractionError::RequestMismatch)
        );
    }

    #[test]
    fn answering_with_nothing_pending_is_rejected() {
        let now = Instant::now();
        let mut interactions = PaneInteractions::default();
        assert_eq!(
            interactions.answer("r1", vec![answer("a")], now),
            Err(PaneInteractionError::NoPendingRequest)
        );
    }

    #[test]
    fn an_expired_request_cannot_be_answered() {
        let now = Instant::now();
        let mut interactions = PaneInteractions::default();
        interactions
            .report(
                request("r1", "first"),
                None,
                Some(Duration::from_secs(1)),
                now,
            )
            .unwrap();
        let later = now + Duration::from_secs(1);
        assert_eq!(
            interactions.answer("r1", vec![answer("a")], later),
            Err(PaneInteractionError::Expired)
        );
        assert!(interactions.expire_at(later));
        assert!(interactions.active(later).is_none());
    }

    #[test]
    fn an_answer_is_collected_once() {
        let now = Instant::now();
        let mut interactions = PaneInteractions::default();
        interactions
            .report(request("r1", "first"), None, None, now)
            .unwrap();
        interactions.answer("r1", vec![answer("a")], now).unwrap();
        let taken = interactions.take_answer("test.agent", "r1");
        assert_eq!(taken.map(|a| a.len()), Some(1));
        // Collecting clears it, so an integration polling cannot re-apply it.
        assert!(interactions.take_answer("test.agent", "r1").is_none());
    }

    #[test]
    fn answering_withdraws_the_question_but_keeps_the_answer() {
        let now = Instant::now();
        let mut interactions = PaneInteractions::default();
        interactions
            .report(request("r1", "first"), None, None, now)
            .unwrap();
        interactions.answer("r1", vec![answer("a")], now).unwrap();
        // The UI must stop offering a settled question immediately, without
        // waiting for the agent to collect the answer.
        assert!(interactions.active(now).is_none());
        // And the choice is still deliverable afterwards.
        assert_eq!(
            interactions
                .take_answer("test.agent", "r1")
                .map(|a| a.len()),
            Some(1)
        );
    }

    #[test]
    fn clearing_drops_a_queued_answer_so_it_cannot_answer_a_later_request() {
        let now = Instant::now();
        let mut interactions = PaneInteractions::default();
        interactions
            .report(request("r1", "first"), None, None, now)
            .unwrap();
        interactions.answer("r1", vec![answer("a")], now).unwrap();
        // Answering already withdrew the question, so `clear` finds nothing to
        // clear.
        assert!(!interactions.clear("test.agent", "r1", None).unwrap());
        assert!(interactions.active(now).is_none());
        // The withdrawal also discards the queued answer. Keeping it would let it
        // be collected for a later question that happens to reuse the id, which
        // is the same class of mistake as answering the wrong prompt.
        assert!(interactions.take_answer("test.agent", "r1").is_none());
    }

    #[test]
    fn a_queued_answer_is_not_delivered_to_a_reused_request_id() {
        let now = Instant::now();
        let mut interactions = PaneInteractions::default();
        interactions
            .report(request("r1", "first"), None, None, now)
            .unwrap();
        interactions.answer("r1", vec![answer("a")], now).unwrap();
        interactions.clear("test.agent", "r1", None).unwrap();
        // The agent asks something new under the same id.
        interactions
            .report(request("r1", "second"), None, None, now)
            .unwrap();
        // The old answer must not surface as the answer to the new question.
        assert!(interactions.take_answer("test.agent", "r1").is_none());
    }

    #[test]
    fn clearing_a_different_request_leaves_the_pending_one_alone() {
        let now = Instant::now();
        let mut interactions = PaneInteractions::default();
        interactions
            .report(request("r1", "first"), None, None, now)
            .unwrap();
        assert!(!interactions.clear("test.agent", "other", None).unwrap());
        assert_eq!(interactions.active(now).unwrap().request_id, "r1");
    }

    #[test]
    fn polling_for_an_answer_before_one_exists_changes_nothing() {
        let now = Instant::now();
        let mut interactions = PaneInteractions::default();
        interactions
            .report(request("r1", "first"), None, None, now)
            .unwrap();
        // An integration polls while it waits. An empty poll must not consume
        // the question, or the first poll would withdraw it before the user
        // could answer at all.
        assert!(interactions.take_answer("test.agent", "r1").is_none());
        assert!(interactions.active(now).is_some());
        // And a later answer is still deliverable.
        interactions.answer("r1", vec![answer("a")], now).unwrap();
        assert_eq!(
            interactions
                .take_answer("test.agent", "r1")
                .map(|a| a.len()),
            Some(1)
        );
    }

    #[test]
    fn a_stale_sequence_cannot_resurrect_a_cleared_request() {
        let now = Instant::now();
        let mut interactions = PaneInteractions::default();
        interactions
            .report(request("r1", "first"), Some(10), None, now)
            .unwrap();
        interactions.clear("test.agent", "r1", Some(11)).unwrap();
        // The agent replays its old report; the user already dealt with it.
        assert!(!interactions
            .report(request("r1", "first"), Some(10), None, now)
            .unwrap());
        assert!(interactions.active(now).is_none());
    }
}

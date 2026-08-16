use std::collections::HashMap;
use std::time::{Duration, Instant};

use crate::api::schema::PaneDiagnosticInfo;

pub(crate) const MAX_PANE_DIAGNOSTICS: usize = 8;
const MAX_DIAGNOSTIC_SEQUENCE_KEYS: usize = 32;

#[derive(Debug, Clone)]
struct PaneDiagnosticRecord {
    info: PaneDiagnosticInfo,
    expires_at: Option<Instant>,
}

#[derive(Debug, Default)]
pub(crate) struct PaneDiagnostics {
    records: HashMap<(String, String), PaneDiagnosticRecord>,
    sequences: HashMap<(String, String), u64>,
}

impl PaneDiagnostics {
    pub(crate) fn report(
        &mut self,
        info: PaneDiagnosticInfo,
        seq: Option<u64>,
        ttl: Option<Duration>,
        now: Instant,
    ) -> Result<bool, PaneDiagnosticReportError> {
        let key = (info.source.clone(), info.diagnostic_id.clone());
        if !self.sequence_is_fresh(&key, seq) {
            return Ok(false);
        }
        if !self.records.contains_key(&key) && self.records.len() >= MAX_PANE_DIAGNOSTICS {
            return Err(PaneDiagnosticReportError::RecordLimit);
        }
        self.accept_sequence(&key, seq)?;
        let expires_at = ttl.and_then(|ttl| now.checked_add(ttl));
        let changed = self
            .records
            .get(&key)
            .is_none_or(|record| record.info != info);
        self.records
            .insert(key, PaneDiagnosticRecord { info, expires_at });
        Ok(changed)
    }

    pub(crate) fn clear(
        &mut self,
        source: &str,
        diagnostic_id: &str,
        seq: Option<u64>,
    ) -> Result<bool, PaneDiagnosticReportError> {
        let key = (source.to_string(), diagnostic_id.to_string());
        if !self.sequence_is_fresh(&key, seq) {
            return Ok(false);
        }
        self.accept_sequence(&key, seq)?;
        Ok(self.records.remove(&key).is_some())
    }

    pub(crate) fn active(&self, now: Instant) -> Vec<PaneDiagnosticInfo> {
        let mut diagnostics = self
            .records
            .values()
            .filter(|record| record.expires_at.is_none_or(|expires_at| expires_at > now))
            .map(|record| record.info.clone())
            .collect::<Vec<_>>();
        diagnostics.sort_by(|a, b| {
            b.updated_unix_ms
                .cmp(&a.updated_unix_ms)
                .then_with(|| a.source.cmp(&b.source))
                .then_with(|| a.diagnostic_id.cmp(&b.diagnostic_id))
        });
        diagnostics
    }

    pub(crate) fn get(
        &self,
        source: &str,
        diagnostic_id: &str,
        now: Instant,
    ) -> Option<&PaneDiagnosticInfo> {
        let record = self
            .records
            .get(&(source.to_string(), diagnostic_id.to_string()))?;
        record
            .expires_at
            .is_none_or(|expires_at| expires_at > now)
            .then_some(&record.info)
    }

    pub(crate) fn expire_at(&mut self, now: Instant) -> bool {
        let previous_len = self.records.len();
        self.records
            .retain(|_, record| record.expires_at.is_none_or(|expires_at| expires_at > now));
        previous_len != self.records.len()
    }

    pub(crate) fn next_expiry(&self) -> Option<Instant> {
        self.records
            .values()
            .filter_map(|record| record.expires_at)
            .min()
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
    ) -> Result<(), PaneDiagnosticReportError> {
        let Some(seq) = seq else {
            return Ok(());
        };
        if !self.sequences.contains_key(key) && self.sequences.len() >= MAX_DIAGNOSTIC_SEQUENCE_KEYS
        {
            return Err(PaneDiagnosticReportError::SequenceLimit);
        }
        self.sequences.insert(key.clone(), seq);
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PaneDiagnosticReportError {
    RecordLimit,
    SequenceLimit,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::schema::PaneDiagnosticSeverity;

    fn diagnostic(state: &str, updated_unix_ms: u64) -> PaneDiagnosticInfo {
        PaneDiagnosticInfo {
            source: "test.monitor".into(),
            diagnostic_id: "activity".into(),
            severity: PaneDiagnosticSeverity::Info,
            state: state.into(),
            title: "Agent activity".into(),
            summary: state.into(),
            fields: Vec::new(),
            session_id: None,
            episode_id: None,
            last_activity_unix_ms: None,
            updated_unix_ms,
        }
    }

    #[test]
    fn stale_sequence_does_not_replace_or_resurrect_diagnostic() {
        let now = Instant::now();
        let mut diagnostics = PaneDiagnostics::default();
        assert!(diagnostics
            .report(diagnostic("working", 1), Some(10), None, now)
            .unwrap());
        assert!(!diagnostics
            .report(diagnostic("stale", 2), Some(9), None, now)
            .unwrap());
        assert_eq!(diagnostics.active(now)[0].state, "working");
        assert!(diagnostics
            .clear("test.monitor", "activity", Some(11))
            .unwrap());
        assert!(!diagnostics
            .report(diagnostic("stale", 3), Some(10), None, now)
            .unwrap());
        assert!(!diagnostics
            .report(diagnostic("unsequenced", 4), None, None, now)
            .unwrap());
        assert!(diagnostics.active(now).is_empty());
    }

    #[test]
    fn expiry_removes_diagnostic_without_touching_other_state() {
        let now = Instant::now();
        let mut diagnostics = PaneDiagnostics::default();
        diagnostics
            .report(
                diagnostic("working", 1),
                Some(1),
                Some(Duration::from_secs(1)),
                now,
            )
            .unwrap();
        assert!(!diagnostics.active(now).is_empty());
        assert!(diagnostics.expire_at(now + Duration::from_secs(1)));
        assert!(diagnostics.active(now + Duration::from_secs(1)).is_empty());
    }
}

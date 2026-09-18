//! Small LRU cache for parsed agent transcripts.
//!
//! Parsing a transcript is fast enough to do synchronously (tens of milliseconds
//! for a multi-megabyte file), but a paging client re-reads the same file
//! repeatedly, and the parser exposes an incremental handle that makes repeat
//! reads nearly free. This keeps those handles around, keyed by transcript path.
//!
//! Eviction is by least-recent use, so paging through one conversation never
//! evicts the file being paged.

use std::collections::HashMap;

/// Parsed transcript handle, advanced by the caller after a filesystem change.
pub(crate) type SessionEntry = codex_trace_parser::session::SessionHandle;

/// An LRU map from transcript path to its parsed handle.
pub(crate) struct SessionCache<T> {
    capacity: usize,
    /// Monotonic counter used as a recency stamp; larger means more recent.
    tick: u64,
    entries: HashMap<String, (u64, T)>,
}

impl<T> SessionCache<T> {
    pub(crate) fn new(capacity: usize) -> Self {
        Self {
            capacity: capacity.max(1),
            tick: 0,
            entries: HashMap::new(),
        }
    }

    /// Returns the cached entry for `key`, marking it as most recently used.
    pub(crate) fn get_mut(&mut self, key: &str) -> Option<&mut T> {
        self.tick += 1;
        let tick = self.tick;
        let entry = self.entries.get_mut(key)?;
        entry.0 = tick;
        Some(&mut entry.1)
    }

    /// Inserts an entry, evicting the least recently used one when full.
    pub(crate) fn insert(&mut self, key: String, value: T) {
        self.tick += 1;
        let tick = self.tick;
        self.entries.insert(key, (tick, value));
        while self.entries.len() > self.capacity {
            let Some(oldest) = self
                .entries
                .iter()
                .min_by_key(|(_, (stamp, _))| *stamp)
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            self.entries.remove(&oldest);
        }
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.entries.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn evicts_least_recently_used() {
        let mut cache = SessionCache::new(2);
        cache.insert("a".into(), 1);
        cache.insert("b".into(), 2);
        // Touching `a` makes `b` the eviction candidate.
        assert_eq!(cache.get_mut("a"), Some(&mut 1));
        cache.insert("c".into(), 3);

        assert!(cache.get_mut("b").is_none(), "b should have been evicted");
        assert_eq!(cache.get_mut("a"), Some(&mut 1));
        assert_eq!(cache.get_mut("c"), Some(&mut 3));
        assert_eq!(cache.len(), 2);
    }

    #[test]
    fn reinserting_a_key_updates_instead_of_growing() {
        let mut cache = SessionCache::new(2);
        cache.insert("a".into(), 1);
        cache.insert("a".into(), 9);
        assert_eq!(cache.len(), 1);
        assert_eq!(cache.get_mut("a"), Some(&mut 9));
    }

    #[test]
    fn capacity_is_never_zero() {
        let mut cache = SessionCache::new(0);
        cache.insert("a".into(), 1);
        cache.insert("b".into(), 2);
        assert_eq!(cache.len(), 1);
    }
}

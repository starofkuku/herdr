use std::collections::HashMap;
use std::path::Path;
use std::time::SystemTime;

use super::discover::{discover_sessions, CodexSessionInfo};

#[derive(Debug, Clone)]
struct CacheEntry {
    mtime: SystemTime,
    size: u64,
    info: CodexSessionInfo,
}

/// Session metadata cache — avoids re-scanning unchanged files.
pub struct SessionCache {
    entries: HashMap<String, CacheEntry>,
}

impl Default for SessionCache {
    fn default() -> Self {
        Self::new()
    }
}

impl SessionCache {
    pub fn new() -> Self {
        Self {
            entries: HashMap::new(),
        }
    }

    /// Discover sessions under `sessions_dir`, using cached results for unchanged files.
    pub fn discover(&mut self, sessions_dir: &Path) -> Result<Vec<CodexSessionInfo>, String> {
        let fresh = discover_sessions(sessions_dir)?;
        let mut result = Vec::new();

        for info in fresh {
            let path = info.path.clone();
            let meta = std::fs::metadata(&path).ok();
            let mtime = meta.as_ref().and_then(|m| m.modified().ok());
            let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);

            if let (Some(mt), size) = (mtime, size) {
                // Check if cached entry is still fresh
                if let Some(cached) = self.entries.get(&path) {
                    if cached.mtime == mt && cached.size == size {
                        result.push(cached.info.clone());
                        continue;
                    }
                }
                self.entries.insert(
                    path,
                    CacheEntry {
                        mtime: mt,
                        size,
                        info: info.clone(),
                    },
                );
            }

            result.push(info);
        }

        Ok(result)
    }
}

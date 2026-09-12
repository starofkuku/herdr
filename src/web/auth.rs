//! Authentication for the web gateway.
//!
//! The gateway is fail-closed: without a configured key it does not listen at
//! all. A key grants full control of every Herdr session this user can reach,
//! so it is treated as a shell-grade credential.

use std::path::Path;

/// Environment variable holding the gateway key.
pub const WEB_KEY_ENV_VAR: &str = "HERDR_WEB_KEY";

/// Optional file holding the gateway key (must not be world readable).
pub const WEB_KEY_FILE_ENV_VAR: &str = "HERDR_WEB_KEY_FILE";

/// Minimum accepted key length. Shorter keys are rejected so a weak key cannot
/// be brute-forced remotely.
pub const MIN_KEY_LEN: usize = 16;

/// A validated gateway key.
#[derive(Clone)]
pub(crate) struct WebKey {
    secret: String,
}

impl std::fmt::Debug for WebKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Never let a key reach a log line.
        f.write_str("WebKey(<redacted>)")
    }
}

/// Why the gateway cannot start.
#[derive(Debug)]
pub(crate) enum KeyError {
    /// No key source was configured. The gateway stays disabled.
    Missing,
    /// A key source was configured but the value is unusable.
    Invalid(String),
}

impl std::fmt::Display for KeyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Missing => {
                f.write_str("no web key configured; set HERDR_WEB_KEY to enable the web gateway")
            }
            Self::Invalid(reason) => write!(f, "invalid web key: {reason}"),
        }
    }
}

impl WebKey {
    /// Loads the key from the environment, then from a key file.
    pub(crate) fn load() -> Result<Self, KeyError> {
        if let Ok(value) = std::env::var(WEB_KEY_ENV_VAR) {
            return Self::from_str(value.trim());
        }

        let Ok(path) = std::env::var(WEB_KEY_FILE_ENV_VAR) else {
            return Err(KeyError::Missing);
        };

        let path = Path::new(path.trim());
        let contents = std::fs::read_to_string(path)
            .map_err(|err| KeyError::Invalid(format!("cannot read {}: {err}", path.display())))?;
        Self::from_str(contents.trim())
    }

    fn from_str(value: &str) -> Result<Self, KeyError> {
        if value.is_empty() {
            return Err(KeyError::Invalid("key is empty".to_string()));
        }
        if value.len() < MIN_KEY_LEN {
            return Err(KeyError::Invalid(format!(
                "key must be at least {MIN_KEY_LEN} characters"
            )));
        }
        Ok(Self {
            secret: value.to_string(),
        })
    }

    /// Constant-time comparison so verification does not leak the key prefix.
    pub(crate) fn verify(&self, candidate: &str) -> bool {
        let expected = self.secret.as_bytes();
        let actual = candidate.as_bytes();

        // Length is not secret; only compare when it matches so the loop below
        // always sees equal-length inputs.
        if expected.len() != actual.len() {
            return false;
        }

        let mut diff = 0u8;
        for (a, b) in expected.iter().zip(actual.iter()) {
            diff |= a ^ b;
        }
        diff == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_short_keys() {
        assert!(matches!(
            WebKey::from_str("short"),
            Err(KeyError::Invalid(_))
        ));
    }

    #[test]
    fn rejects_empty_keys() {
        assert!(matches!(WebKey::from_str(""), Err(KeyError::Invalid(_))));
    }

    #[test]
    fn accepts_long_keys() {
        assert!(WebKey::from_str("0123456789abcdef").is_ok());
    }

    #[test]
    fn verify_accepts_exact_match_only() {
        let key = WebKey::from_str("0123456789abcdef").unwrap();
        assert!(key.verify("0123456789abcdef"));
        assert!(!key.verify("0123456789abcde"));
        assert!(!key.verify("0123456789abcdeg"));
        assert!(!key.verify(""));
    }

    #[test]
    fn debug_does_not_leak_secret() {
        let key = WebKey::from_str("super-secret-key-value").unwrap();
        let rendered = format!("{key:?}");
        assert!(!rendered.contains("super-secret"));
    }
}

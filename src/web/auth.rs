//! Authentication for the web gateway.
//!
//! The gateway is fail-closed: without a configured key it does not listen at
//! all. A key grants full control of every Herdr session this user can reach,
//! so it is treated as a shell-grade credential.

use std::path::{Path, PathBuf};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt as _;

/// Environment variable holding the gateway key.
pub const WEB_KEY_ENV_VAR: &str = "HERDR_WEB_KEY";

/// Optional file holding the gateway key (must not be group/world readable).
pub const WEB_KEY_FILE_ENV_VAR: &str = "HERDR_WEB_KEY_FILE";

/// Minimum accepted key length. Shorter keys are rejected so a weak key cannot
/// be brute-forced remotely.
pub const MIN_KEY_LEN: usize = 16;

/// Rendered in place of a key so a diagnostic never echoes the secret.
pub const REDACTED: &str = "<redacted>";

/// A validated gateway key.
#[derive(Clone)]
pub(crate) struct WebKey {
    secret: String,
    /// Where the key came from, for diagnostics that must not leak the value.
    source: KeySource,
}

/// Where a key was loaded from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum KeySource {
    Environment,
    File(PathBuf),
    ConfigFile(PathBuf),
}

impl std::fmt::Display for KeySource {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Environment => write!(f, "{}", WEB_KEY_ENV_VAR),
            Self::File(path) => write!(f, "{} ({})", WEB_KEY_FILE_ENV_VAR, path.display()),
            Self::ConfigFile(path) => write!(f, "[web] key in {}", path.display()),
        }
    }
}

impl std::fmt::Debug for WebKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Never let a key reach a log line.
        write!(f, "WebKey({}, from {})", REDACTED, self.source)
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
                f.write_str("no web key configured; set [web] key in config.toml, or HERDR_WEB_KEY")
            }
            Self::Invalid(reason) => write!(f, "invalid web key: {reason}"),
        }
    }
}

impl WebKey {
    /// Loads the key from the environment, then a key file, then the config
    /// file.
    ///
    /// `config_key` and `config_path` come from the loaded config so this does
    /// not re-read the file.
    pub(crate) fn load(
        config_key: Option<&str>,
        config_path: Option<&Path>,
    ) -> Result<Self, KeyError> {
        if let Ok(value) = std::env::var(WEB_KEY_ENV_VAR) {
            return Self::validated(value.trim(), KeySource::Environment);
        }

        if let Ok(path) = std::env::var(WEB_KEY_FILE_ENV_VAR) {
            let path = PathBuf::from(path.trim());
            let contents = std::fs::read_to_string(&path).map_err(|err| {
                KeyError::Invalid(format!("cannot read {}: {err}", path.display()))
            })?;
            ensure_private_file(&path, "web key file")?;
            return Self::validated(contents.trim(), KeySource::File(path));
        }

        let Some(raw) = config_key else {
            return Err(KeyError::Missing);
        };

        // A key in a shared config file is only as private as the file. Check
        // permissions before trusting it, since the gateway exposes shells.
        let source_path = config_path.unwrap_or_else(|| Path::new("config.toml"));
        ensure_private_file(source_path, "config file holding [web] key")?;
        Self::validated(raw.trim(), KeySource::ConfigFile(source_path.to_path_buf()))
    }

    fn validated(value: &str, source: KeySource) -> Result<Self, KeyError> {
        if value.is_empty() {
            return Err(KeyError::Invalid(format!("key from {source} is empty")));
        }
        if value.len() < MIN_KEY_LEN {
            return Err(KeyError::Invalid(format!(
                "key from {source} must be at least {MIN_KEY_LEN} characters"
            )));
        }
        Ok(Self {
            secret: value.to_string(),
            source,
        })
    }

    /// Where the key came from, without revealing it.
    pub(crate) fn source(&self) -> &KeySource {
        &self.source
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

/// Rejects a key file that other users can read.
///
/// On Unix this checks the mode bits. Windows ACLs are not inspected here, so
/// the check is a no-op there.
fn ensure_private_file(path: &Path, what: &str) -> Result<(), KeyError> {
    #[cfg(unix)]
    {
        let metadata = std::fs::metadata(path)
            .map_err(|err| KeyError::Invalid(format!("cannot stat {}: {err}", path.display())))?;
        let mode = metadata.permissions().mode();
        // Group or other bits would expose the key to another account.
        if mode & 0o077 != 0 {
            return Err(KeyError::Invalid(format!(
                "{what} {} is readable by other users (mode {:03o}); run: chmod 600 {}",
                path.display(),
                mode & 0o777,
                path.display()
            )));
        }
    }

    #[cfg(not(unix))]
    {
        let _ = (path, what);
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_short_keys() {
        assert!(matches!(
            WebKey::validated("short", KeySource::Environment),
            Err(KeyError::Invalid(_))
        ));
    }

    #[test]
    fn rejects_empty_keys() {
        assert!(matches!(
            WebKey::validated("", KeySource::Environment),
            Err(KeyError::Invalid(_))
        ));
    }

    #[test]
    fn accepts_long_keys() {
        assert!(WebKey::validated("0123456789abcdef", KeySource::Environment).is_ok());
    }

    #[test]
    fn verify_accepts_exact_match_only() {
        let key = WebKey::validated("0123456789abcdef", KeySource::Environment).unwrap();
        assert!(key.verify("0123456789abcdef"));
        assert!(!key.verify("0123456789abcde"));
        assert!(!key.verify("0123456789abcdeg"));
        assert!(!key.verify(""));
    }

    #[test]
    fn debug_does_not_leak_secret() {
        let key = WebKey::validated("super-secret-key-value", KeySource::Environment).unwrap();
        let rendered = format!("{key:?}");
        assert!(!rendered.contains("super-secret"));
        assert!(rendered.contains(REDACTED));
    }

    #[test]
    fn missing_key_reports_all_sources() {
        let err = WebKey::load(None, None).unwrap_err();
        assert!(matches!(err, KeyError::Missing));
        let message = err.to_string();
        assert!(message.contains("[web] key"));
        assert!(message.contains(WEB_KEY_ENV_VAR));
    }

    #[test]
    fn config_key_is_used_when_no_env_is_set() {
        let dir = std::env::temp_dir().join(format!("herdr-webkey-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config.toml");
        std::fs::write(&path, "[web]\nkey = \"0123456789abcdef\"\n").unwrap();
        #[cfg(unix)]
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();

        let key = WebKey::load(Some("0123456789abcdef"), Some(&path)).unwrap();
        assert_eq!(key.source(), &KeySource::ConfigFile(path.clone()));
        assert!(key.verify("0123456789abcdef"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn config_key_is_rejected_when_file_is_world_readable() {
        let dir = std::env::temp_dir().join(format!("herdr-webkey-bad-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config.toml");
        std::fs::write(&path, "[web]\nkey = \"0123456789abcdef\"\n").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();

        let err = WebKey::load(Some("0123456789abcdef"), Some(&path)).unwrap_err();
        let message = err.to_string();
        assert!(message.contains("readable by other users"), "{message}");
        assert!(
            !message.contains("0123456789abcdef"),
            "must not echo the key"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn group_readable_config_key_is_rejected() {
        let dir = std::env::temp_dir().join(format!("herdr-webkey-grp-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config.toml");
        std::fs::write(&path, "x").unwrap();
        // 0660 exposes the key to the file's group.
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o660)).unwrap();

        let err = WebKey::load(Some("0123456789abcdef"), Some(&path)).unwrap_err();
        assert!(err.to_string().contains("readable by other users"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn owner_only_config_key_is_accepted() {
        for mode in [0o600, 0o400] {
            let dir = std::env::temp_dir()
                .join(format!("herdr-webkey-ok-{}-{mode:o}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            let path = dir.join("config.toml");
            std::fs::write(&path, "x").unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode)).unwrap();

            assert!(
                WebKey::load(Some("0123456789abcdef"), Some(&path)).is_ok(),
                "mode {mode:o} should be accepted"
            );

            let _ = std::fs::remove_dir_all(&dir);
        }
    }
}

//! Downloads the web UI, which is published separately from the binary.
//!
//! `herdr web` serves the page from `[web] static_dir` at request time, so
//! updating it is a file replacement rather than a binary swap. The page is
//! published on its own release, which means the UI can move ahead of, or
//! behind, the installed binary.
//!
//! The downloaded file carries a `herdr-web-ui version: <x.y.z>` marker, so
//! `--check` can report whether an update is available without writing anything.

use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::config::WebConfig;

/// Marker embedded in the built page by the frontend build.
///
/// Kept in sync with `web/vite.config.ts`, which injects it.
const VERSION_MARKER: &str = "herdr-web-ui version:";

/// Name of the file the gateway serves from `static_dir`.
const INDEX_FILE: &str = "index.html";

/// Outcome of a `herdr update web` run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WebUpdateOutcome {
    /// Downloaded and installed a page.
    Installed { version: Option<String> },
    /// Already current; nothing was written.
    UpToDate { version: Option<String> },
    /// Checked only; reported what is available.
    CheckOnly {
        current: Option<String>,
        available: Option<String>,
    },
}

/// Why an update could not be attempted, so the command can explain itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WebUpdateError {
    /// `[web] update_url` is unset.
    NoUpdateUrl,
    /// `[web] static_dir` is unset, so there is nowhere to install to.
    NoStaticDir,
    /// Anything else, already formatted for the user.
    Failed(String),
}

impl std::fmt::Display for WebUpdateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoUpdateUrl => write!(
                f,
                "no web UI update source configured; set [web] update_url in config.toml"
            ),
            Self::NoStaticDir => write!(
                f,
                "no web UI directory configured; set [web] static_dir in config.toml"
            ),
            Self::Failed(message) => write!(f, "{message}"),
        }
    }
}

/// Reads the `herdr-web-ui version:` marker from a page.
///
/// Returns `None` when the file is missing or carries no marker, which is the
/// case for pages built before the marker existed.
pub fn version_of(path: &Path) -> Option<String> {
    let html = fs::read_to_string(path).ok()?;
    parse_version_marker(&html)
}

/// Extracts the version from the marker comment.
fn parse_version_marker(html: &str) -> Option<String> {
    let start = html.find(VERSION_MARKER)? + VERSION_MARKER.len();
    let rest = html[start..].trim_start();
    // A version always starts with a digit. Requiring that keeps the `-->` that
    // closes the comment from being read as a version, since `-` is otherwise a
    // legal character.
    if !rest.starts_with(|c: char| c.is_ascii_digit()) {
        return None;
    }
    let version: String = rest
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '.' || *c == '-' || *c == '+')
        .collect();
    if version.is_empty() {
        None
    } else {
        Some(version)
    }
}

/// Downloads `url` into a temporary file and returns its contents.
fn download(url: &str) -> Result<String, WebUpdateError> {
    let tmp = std::env::temp_dir().join(format!(
        "herdr-web-ui-{}-{}.html",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));

    let status = Command::new("curl")
        .args(["-sfL", "--max-time", "60", "-o"])
        .arg(&tmp)
        .arg(url)
        .status()
        .map_err(|e| WebUpdateError::Failed(format!("download failed: {e}")))?;

    if !status.success() {
        let _ = fs::remove_file(&tmp);
        return Err(WebUpdateError::Failed(format!(
            "download failed from {url}"
        )));
    }

    let html = fs::read_to_string(&tmp).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        WebUpdateError::Failed(format!("downloaded file is not readable text: {e}"))
    })?;
    let _ = fs::remove_file(&tmp);
    Ok(html)
}

/// Rejects a download that is not a usable page.
///
/// Without this a proxy error page or a truncated transfer would be installed
/// over a working UI, and the gateway would then serve nothing.
fn validate(html: &str) -> Result<(), WebUpdateError> {
    if html.trim().is_empty() {
        return Err(WebUpdateError::Failed("downloaded file is empty".into()));
    }
    if !html.contains("<html") || !html.contains("</html>") {
        return Err(WebUpdateError::Failed(
            "downloaded file does not look like an HTML page".into(),
        ));
    }
    if !html.contains(VERSION_MARKER) {
        return Err(WebUpdateError::Failed(format!(
            "downloaded file has no '{VERSION_MARKER}' marker, so it is not a herdr web UI build"
        )));
    }
    Ok(())
}

/// Writes `html` over the served page atomically.
///
/// A partially written `index.html` would leave the gateway serving nothing, so
/// the new content lands in a sibling file first and is then renamed over the
/// old one, which is atomic on every platform herdr supports.
fn install(static_dir: &Path, html: &str) -> Result<(), WebUpdateError> {
    fs::create_dir_all(static_dir).map_err(|e| {
        WebUpdateError::Failed(format!("cannot create {}: {e}", static_dir.display()))
    })?;
    let target = static_dir.join(INDEX_FILE);
    let tmp = static_dir.join(format!(".{INDEX_FILE}.herdr-{}.tmp", std::process::id()));

    let mut file = fs::File::create(&tmp)
        .map_err(|e| WebUpdateError::Failed(format!("cannot write {}: {e}", tmp.display())))?;
    file.write_all(html.as_bytes())
        .map_err(|e| WebUpdateError::Failed(format!("cannot write {}: {e}", tmp.display())))?;
    file.sync_all()
        .map_err(|e| WebUpdateError::Failed(format!("cannot flush {}: {e}", tmp.display())))?;
    drop(file);

    fs::rename(&tmp, &target).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        WebUpdateError::Failed(format!("cannot replace {}: {e}", target.display()))
    })?;
    Ok(())
}

/// Runs the web UI update described by `[web]`.
///
/// `check_only` downloads and reports without writing, so a user can see what
/// is available before replacing a page that currently works.
pub fn update_web_ui(
    config: &WebConfig,
    check_only: bool,
) -> Result<WebUpdateOutcome, WebUpdateError> {
    let url = config
        .update_url
        .as_deref()
        .map(str::trim)
        .filter(|url| !url.is_empty())
        .ok_or(WebUpdateError::NoUpdateUrl)?;

    // `--check` needs somewhere to compare against; without a directory there is
    // no installed page, so the check would have nothing to say.
    let static_dir = config
        .static_dir
        .as_deref()
        .map(str::trim)
        .filter(|dir| !dir.is_empty())
        .ok_or(WebUpdateError::NoStaticDir)?;
    let static_dir = PathBuf::from(shellexpand_home(static_dir));

    let current = version_of(&static_dir.join(INDEX_FILE));

    let html = download(url)?;
    validate(&html)?;
    let available = parse_version_marker(&html);

    if check_only {
        return Ok(WebUpdateOutcome::CheckOnly { current, available });
    }

    // Only skip when both sides declare a version and they match; otherwise an
    // unmarked local page (older build, or hand-edited) is refreshed.
    if let (Some(current), Some(available)) = (&current, &available) {
        if current == available {
            return Ok(WebUpdateOutcome::UpToDate {
                version: Some(available.clone()),
            });
        }
    }

    install(&static_dir, &html)?;
    Ok(WebUpdateOutcome::Installed { version: available })
}

/// Expands a leading `~`, which config values commonly use.
fn shellexpand_home(path: &str) -> String {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home)
                .join(rest)
                .to_string_lossy()
                .into_owned();
        }
    }
    path.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page_with_version(version: &str) -> String {
        format!(
            "<!doctype html>\n<html>\n<head>\n<!-- {VERSION_MARKER} {version} -->\n</head>\n<body></body>\n</html>\n"
        )
    }

    #[test]
    fn marker_version_is_read() {
        assert_eq!(
            parse_version_marker(&page_with_version("0.7.21")),
            Some("0.7.21".to_string())
        );
    }

    #[test]
    fn missing_marker_is_none() {
        assert_eq!(parse_version_marker("<html></html>"), None);
    }

    #[test]
    fn marker_without_a_version_is_none() {
        assert_eq!(
            parse_version_marker("<html><head><!-- herdr-web-ui version: -->"),
            None
        );
    }

    /// The comment terminator must not be read as a version: `-` is legal in a
    /// version string, so an empty marker would otherwise yield `--`.
    #[test]
    fn comment_terminator_is_not_mistaken_for_a_version() {
        assert_eq!(parse_version_marker("<!-- herdr-web-ui version: -->"), None);
        assert_eq!(
            parse_version_marker("<!-- herdr-web-ui version: 1.0.0 -->"),
            Some("1.0.0".to_string())
        );
    }

    #[test]
    fn version_stops_at_whitespace() {
        let html = "<!-- herdr-web-ui version: 1.2.3 -->";
        assert_eq!(parse_version_marker(html), Some("1.2.3".to_string()));
    }

    #[test]
    fn validation_accepts_a_marked_page() {
        assert!(validate(&page_with_version("1.0.0")).is_ok());
    }

    #[test]
    fn validation_rejects_an_empty_download() {
        assert!(validate("").is_err());
        assert!(validate("   \n").is_err());
    }

    /// A proxy or captive portal returning an error page must not be installed.
    #[test]
    fn validation_rejects_a_non_page() {
        assert!(validate("Not Found").is_err());
        assert!(validate("{\"error\":\"nope\"}").is_err());
    }

    /// A page without the marker is not one of our builds, however HTML-like.
    #[test]
    fn validation_rejects_a_page_without_the_marker() {
        assert!(validate("<html><body>hello</body></html>").is_err());
    }

    #[test]
    fn install_replaces_the_page_atomically() {
        let dir = std::env::temp_dir().join(format!("herdr-web-ui-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let target = dir.join(INDEX_FILE);
        fs::write(&target, page_with_version("0.0.1")).unwrap();

        install(&dir, &page_with_version("0.9.9")).unwrap();

        assert_eq!(version_of(&target), Some("0.9.9".to_string()));
        // The temporary file must not be left behind.
        let leftovers: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "left temp files: {leftovers:?}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn version_of_missing_file_is_none() {
        assert_eq!(
            version_of(Path::new("/nonexistent/herdr-web-ui.html")),
            None
        );
    }

    #[test]
    fn missing_update_url_is_reported() {
        let config = WebConfig {
            update_url: None,
            static_dir: Some("/tmp/whatever".into()),
            ..WebConfig::default()
        };
        assert_eq!(
            update_web_ui(&config, true),
            Err(WebUpdateError::NoUpdateUrl)
        );
    }

    #[test]
    fn missing_static_dir_is_reported() {
        let config = WebConfig {
            update_url: Some("https://example.invalid/ui.html".into()),
            static_dir: None,
            ..WebConfig::default()
        };
        assert_eq!(
            update_web_ui(&config, true),
            Err(WebUpdateError::NoStaticDir)
        );
    }

    #[test]
    fn home_prefix_is_expanded() {
        let expanded = shellexpand_home("~/herdr-web");
        assert!(expanded.ends_with("/herdr-web"));
        assert!(!expanded.starts_with('~'));
        // An absolute path is left alone.
        assert_eq!(shellexpand_home("/opt/ui"), "/opt/ui");
    }
}

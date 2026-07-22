use std::fs;
use std::io::{self, Write as _};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::detect::Agent;

const STAGED_CLIPBOARD_IMAGE_MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);

pub(crate) struct StagedClipboardImage {
    pub(crate) path: PathBuf,
    pub(crate) paste_text: String,
}

/// How an agent consumes an image that Herdr staged on the remote host.
///
/// These are deliberately transport-level descriptions. The client still
/// owns clipboard access; the server only chooses the text token to paste
/// after it has received the image bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RemoteImagePasteTransport {
    /// The agent treats an absolute path as an image attachment.
    PastedPath,
    /// The agent requires an `@path` mention to attach the image.
    AtMention,
}

/// Returns the remote image-paste contract for agents with a documented,
/// path-based attachment interface.
///
/// Agents without a stable path contract are intentionally omitted. Their
/// original shortcut is forwarded unchanged so a local/native implementation
/// can handle it instead of receiving text that merely looks like a path.
pub(crate) fn remote_image_paste_transport(agent: Agent) -> Option<RemoteImagePasteTransport> {
    match agent {
        // Pi's interactive editor and CLI treat `@path` as a file/image attachment
        // (`pi @image.png "…"`). A bare path is just text and will not attach.
        Agent::Pi | Agent::Amp => Some(RemoteImagePasteTransport::AtMention),
        Agent::Claude
        | Agent::Codex
        | Agent::Cursor
        | Agent::Cline
        | Agent::Omp
        | Agent::Mastracode
        | Agent::OpenCode
        | Agent::GithubCopilot
        | Agent::Kiro
        | Agent::Droid
        | Agent::Grok
        | Agent::Hermes
        | Agent::Kilo
        | Agent::Qodercli
        | Agent::Maki => Some(RemoteImagePasteTransport::PastedPath),
        Agent::Gemini | Agent::Kimi | Agent::Devin | Agent::Antigravity => None,
    }
}

pub(crate) fn remote_image_paste_text(agent: Agent, path: &str) -> Option<String> {
    match remote_image_paste_transport(agent)? {
        RemoteImagePasteTransport::PastedPath => Some(path.to_owned()),
        RemoteImagePasteTransport::AtMention => Some(format!("@{path}")),
    }
}

pub(crate) fn stage(
    client_id: u64,
    extension: &str,
    data: &[u8],
) -> io::Result<StagedClipboardImage> {
    let extension = sanitize_extension(extension);
    let dir = ensure_staging_dir()?;
    cleanup_stale(&dir);

    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);

    for attempt in 0..100 {
        let path = dir.join(format!(
            "client-{client_id}-clipboard-{unique}-{attempt}.{extension}"
        ));
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        restrict_file_options(&mut options);
        let mut file = match options.open(&path) {
            Ok(file) => file,
            Err(err) if err.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(err) => return Err(err),
        };
        file.write_all(data)?;
        return Ok(StagedClipboardImage {
            paste_text: path.to_string_lossy().into_owned(),
            path,
        });
    }

    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "failed to allocate unique clipboard image staging path",
    ))
}

pub(crate) fn remove_files(paths: Vec<PathBuf>) {
    for path in paths {
        let _ = fs::remove_file(path);
    }
}

fn sanitize_extension(extension: &str) -> &'static str {
    if extension.eq_ignore_ascii_case("png") {
        "png"
    } else if extension.eq_ignore_ascii_case("jpg") || extension.eq_ignore_ascii_case("jpeg") {
        "jpg"
    } else if extension.eq_ignore_ascii_case("gif") {
        "gif"
    } else if extension.eq_ignore_ascii_case("webp") {
        "webp"
    } else if extension.eq_ignore_ascii_case("bmp") {
        "bmp"
    } else {
        "png"
    }
}

fn staging_dir() -> PathBuf {
    #[cfg(unix)]
    let user_id = unsafe { libc::geteuid() };
    #[cfg(windows)]
    let user_id = std::process::id();
    std::env::temp_dir().join(format!("herdr-clipboard-images-{user_id}"))
}

fn ensure_staging_dir() -> io::Result<PathBuf> {
    let dir = staging_dir();
    fs::create_dir_all(&dir)?;
    let metadata = fs::metadata(&dir)?;
    if !metadata.is_dir() {
        return Err(io::Error::other(format!(
            "clipboard image staging path is not a directory: {}",
            dir.display()
        )));
    }
    restrict_dir_permissions(&dir)?;
    Ok(dir)
}

#[cfg(unix)]
fn restrict_file_options(options: &mut fs::OpenOptions) {
    use std::os::unix::fs::OpenOptionsExt;

    options.mode(0o600);
}

#[cfg(windows)]
fn restrict_file_options(_options: &mut fs::OpenOptions) {}

#[cfg(unix)]
fn restrict_dir_permissions(dir: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;

    fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
}

#[cfg(windows)]
fn restrict_dir_permissions(_dir: &Path) -> io::Result<()> {
    Ok(())
}

fn cleanup_stale(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let Ok(modified) = metadata.modified() else {
            continue;
        };
        if modified.elapsed().unwrap_or_default() > STAGED_CLIPBOARD_IMAGE_MAX_AGE {
            let _ = fs::remove_file(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_extension_accepts_known_image_extensions() {
        assert_eq!(sanitize_extension("PNG"), "png");
        assert_eq!(sanitize_extension("jpeg"), "jpg");
        assert_eq!(sanitize_extension("webp"), "webp");
        assert_eq!(sanitize_extension("sh"), "png");
    }

    #[test]
    fn documented_path_agents_use_staged_path_transport() {
        for agent in [
            Agent::Claude,
            Agent::Codex,
            Agent::Cursor,
            Agent::Cline,
            Agent::Omp,
            Agent::Mastracode,
            Agent::OpenCode,
            Agent::GithubCopilot,
            Agent::Kiro,
            Agent::Droid,
            Agent::Grok,
            Agent::Hermes,
            Agent::Kilo,
            Agent::Qodercli,
            Agent::Maki,
        ] {
            assert_eq!(
                remote_image_paste_text(agent, "/tmp/image.png"),
                Some("/tmp/image.png".to_owned())
            );
        }
    }

    #[test]
    fn pi_and_amp_use_at_mention_and_unsupported_agents_fall_back() {
        for agent in [Agent::Pi, Agent::Amp] {
            assert_eq!(
                remote_image_paste_text(agent, "/tmp/image.png"),
                Some("@/tmp/image.png".to_owned())
            );
        }
        for agent in [Agent::Gemini, Agent::Kimi, Agent::Devin, Agent::Antigravity] {
            assert_eq!(remote_image_paste_text(agent, "/tmp/image.png"), None);
        }
    }
}

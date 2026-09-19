//! Staging for files uploaded from the web UI.
//!
//! The browser owns reading the file (paste, drag-and-drop, or a picker); the
//! server only writes the bytes it receives and reports where they landed. The
//! path is what the agent needs: an agent running on this host reads a file, it
//! cannot read the reader's clipboard.
//!
//! Files are written under the configured uploads directory with an
//! unguessable name and served from `/uploads/<id>.<ext>`. The directory is not
//! reachable by guessing, which matters because that route is unauthenticated:
//! the web UI serves it from the same origin, so a name that can be enumerated
//! would expose every upload to anyone on the network.

use std::fs;
use std::io::{self, Write as _};
use std::path::{Path, PathBuf};

/// Largest file the server will stage.
///
/// Matches the gateway's upload request limit, so a payload the browser can
/// send is one the server accepts rather than rejecting it at the far end.
pub(crate) const MAX_UPLOAD_BYTES: usize = 16 * 1024 * 1024;

/// Longest extension kept verbatim. Anything longer is not a real extension and
/// is replaced rather than trusted.
const MAX_EXTENSION_LEN: usize = 16;

/// Extension used when the name carries nothing usable.
const FALLBACK_EXTENSION: &str = "bin";

/// Extensions that must never be served for inline rendering.
///
/// `/uploads` shares an origin with the web UI and is not authenticated, so a
/// document the browser is willing to execute could run script in that origin
/// and read the gateway key. These are served as downloads instead, which stops
/// the browser rendering them regardless of what it guesses from the bytes.
pub(crate) const FORCE_DOWNLOAD_EXTENSIONS: &[&str] =
    &["html", "htm", "svg", "xhtml", "js", "mjs", "xml"];

/// Image extensions the UI can render, and the content type each is served as.
const IMAGE_CONTENT_TYPES: &[(&str, &str)] = &[
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("gif", "image/gif"),
    ("webp", "image/webp"),
    ("bmp", "image/bmp"),
];

/// One staged upload as the API reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct StagedUpload {
    /// Unguessable stem used in the served URL.
    pub(crate) id: String,
    /// Absolute path on this host, which is what an agent reads.
    pub(crate) path: PathBuf,
    /// Extension the file was stored under.
    pub(crate) extension: String,
    /// Bytes written.
    pub(crate) size: usize,
}

/// How a staged file should be served over HTTP.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct UploadServing {
    pub(crate) content_type: String,
    /// True when the browser must download rather than render it.
    pub(crate) attachment: bool,
    /// Whether the UI can show a preview for this file.
    pub(crate) is_image: bool,
}

/// Keeps the extension when it looks like one, otherwise falls back.
///
/// The result is used in a filename, so it is restricted to ASCII letters and
/// digits: a name arriving from the browser is untrusted input, and an
/// extension that can contain a separator or a dot would let it steer the write
/// outside the uploads directory.
pub(crate) fn sanitize_extension(extension: &str) -> String {
    let trimmed = extension.trim().trim_start_matches('.');
    if trimmed.is_empty() || trimmed.len() > MAX_EXTENSION_LEN {
        return FALLBACK_EXTENSION.to_string();
    }
    if !trimmed.chars().all(|ch| ch.is_ascii_alphanumeric()) {
        return FALLBACK_EXTENSION.to_string();
    }
    trimmed.to_ascii_lowercase()
}

/// Extension of a filename, or an empty string when it has none.
pub(crate) fn extension_of(name: &str) -> &str {
    // A leading dot is a hidden file, not an extension: `.bashrc` has none.
    match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() && !ext.is_empty() => ext,
        _ => "",
    }
}

/// Whether the browser must download this extension instead of rendering it.
pub(crate) fn must_force_download(extension: &str) -> bool {
    let ext = extension.to_ascii_lowercase();
    FORCE_DOWNLOAD_EXTENSIONS.contains(&ext.as_str())
}

/// Content type and disposition for a staged file.
pub(crate) fn serving_for(extension: &str) -> UploadServing {
    let ext = extension.to_ascii_lowercase();
    let image_type = IMAGE_CONTENT_TYPES
        .iter()
        .find(|(known, _)| *known == ext)
        .map(|(_, content_type)| *content_type);
    match image_type {
        Some(content_type) => UploadServing {
            content_type: content_type.to_string(),
            attachment: false,
            is_image: true,
        },
        None => UploadServing {
            content_type: "application/octet-stream".to_string(),
            attachment: true,
            is_image: false,
        },
    }
}

/// Where uploads live, derived from the configured directory.
///
/// Returns `None` when neither `uploads_dir` nor `static_dir` is set: without a
/// directory there is nowhere to write and nothing to serve.
pub(crate) fn uploads_dir(config: &crate::config::Config) -> Option<PathBuf> {
    if let Some(dir) = &config.web.uploads_dir {
        return Some(crate::web::expand_tilde(Path::new(dir)));
    }
    config
        .web
        .static_dir
        .as_deref()
        .map(|dir| crate::web::expand_tilde(Path::new(dir)).join("uploads"))
}

/// Writes bytes under `dir`, creating the directory when missing.
///
/// The name is generated rather than derived from the upload, so two uploads
/// with the same original name cannot collide and a caller cannot choose where
/// the file lands.
pub(crate) fn stage(dir: &Path, extension: &str, data: &[u8]) -> io::Result<StagedUpload> {
    if data.len() > MAX_UPLOAD_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("upload exceeds {MAX_UPLOAD_BYTES} bytes"),
        ));
    }

    let extension = sanitize_extension(extension);
    ensure_dir(dir)?;

    for _ in 0..100 {
        let id = random_id()?;
        let path = dir.join(format!("{id}.{extension}"));
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        restrict_file_options(&mut options);
        let mut file = match options.open(&path) {
            Ok(file) => file,
            Err(err) if err.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(err) => return Err(err),
        };
        file.write_all(data)?;
        return Ok(StagedUpload {
            id,
            path,
            extension,
            size: data.len(),
        });
    }

    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "failed to allocate a unique upload path",
    ))
}

/// 32 hex characters from the OS random source.
///
/// The served URL is the only thing protecting an upload, so this must not be
/// predictable: a counter or a timestamp would let anyone list what was sent.
fn random_id() -> io::Result<String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(io::Error::other)?;
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(out, "{byte:02x}");
    }
    Ok(out)
}

fn ensure_dir(dir: &Path) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    let metadata = fs::metadata(dir)?;
    if !metadata.is_dir() {
        return Err(io::Error::other(format!(
            "uploads path is not a directory: {}",
            dir.display()
        )));
    }
    restrict_dir_permissions(dir)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extension_is_kept_and_lowercased() {
        assert_eq!(sanitize_extension("PDF"), "pdf");
        assert_eq!(sanitize_extension(".tar"), "tar");
        assert_eq!(sanitize_extension("png"), "png");
    }

    #[test]
    fn unusable_extensions_fall_back_rather_than_steering_the_path() {
        assert_eq!(sanitize_extension(""), "bin");
        assert_eq!(sanitize_extension("."), "bin");
        // A separator or a dot would escape the uploads directory.
        assert_eq!(sanitize_extension("../etc/passwd"), "bin");
        assert_eq!(sanitize_extension("a/b"), "bin");
        assert_eq!(sanitize_extension("a.b"), "bin");
        assert_eq!(sanitize_extension(&"x".repeat(33)), "bin");
    }

    #[test]
    fn extension_of_ignores_hidden_files() {
        assert_eq!(extension_of("report.pdf"), "pdf");
        assert_eq!(extension_of("archive.tar.gz"), "gz");
        assert_eq!(extension_of(".bashrc"), "");
        assert_eq!(extension_of("noext"), "");
        assert_eq!(extension_of("trailing."), "");
    }

    #[test]
    fn documents_are_forced_to_download() {
        for ext in ["html", "htm", "svg", "xhtml", "js", "mjs", "xml"] {
            assert!(must_force_download(ext), "{ext} should force download");
            assert!(must_force_download(&ext.to_uppercase()));
        }
        assert!(!must_force_download("pdf"));
        assert!(!must_force_download("png"));
    }

    #[test]
    fn images_are_previewable_and_everything_else_downloads() {
        for ext in ["png", "jpg", "jpeg", "gif", "webp", "bmp"] {
            let serving = serving_for(ext);
            assert!(serving.is_image, "{ext} should preview");
            assert!(!serving.attachment);
            assert!(serving.content_type.starts_with("image/"));
        }

        for ext in ["pdf", "zip", "sh", "html"] {
            let serving = serving_for(ext);
            assert!(!serving.is_image, "{ext} is not an image");
            assert!(serving.attachment, "{ext} must download");
            assert_eq!(serving.content_type, "application/octet-stream");
        }
    }

    #[test]
    fn staging_writes_an_unguessable_name_and_keeps_the_extension() {
        let dir = std::env::temp_dir().join(format!("herdr-upload-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);

        let staged = stage(&dir, "pdf", b"hello").unwrap();
        assert_eq!(staged.extension, "pdf");
        assert_eq!(staged.size, 5);
        assert_eq!(staged.id.len(), 32);
        assert!(staged.id.chars().all(|ch| ch.is_ascii_hexdigit()));
        assert_eq!(fs::read(&staged.path).unwrap(), b"hello");
        assert!(staged.path.to_string_lossy().ends_with(".pdf"));

        // Two uploads of the same name must not collide.
        let second = stage(&dir, "pdf", b"world").unwrap();
        assert_ne!(staged.id, second.id);
        assert_eq!(fs::read(&second.path).unwrap(), b"world");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn staging_rejects_an_oversized_payload() {
        let dir = std::env::temp_dir().join(format!("herdr-upload-big-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);

        let too_big = vec![0u8; MAX_UPLOAD_BYTES + 1];
        let err = stage(&dir, "bin", &too_big).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn uploads_dir_prefers_the_explicit_setting() {
        let mut config = crate::config::Config::default();
        assert_eq!(uploads_dir(&config), None);

        config.web.static_dir = Some("/srv/web".into());
        assert_eq!(
            uploads_dir(&config),
            Some(PathBuf::from("/srv/web/uploads"))
        );

        config.web.uploads_dir = Some("/data/uploads".into());
        assert_eq!(uploads_dir(&config), Some(PathBuf::from("/data/uploads")));
    }
}

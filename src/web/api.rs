//! API passthrough for the web gateway.
//!
//! The gateway is a thin proxy: the browser sends the same JSON requests the
//! CLI and other API clients use, and the gateway forwards them to a session's
//! JSON API socket over a fresh connection.
//!
//! Each API connection serves exactly one request (except subscriptions, which
//! stream), so a connection is opened per forwarded request. Keeping the
//! browser on the public API means the UI never depends on the private
//! client/server wire format or its protocol version.

use std::io::{self, BufRead as _, Read, Write as _};
use std::path::{Path, PathBuf};

use tracing::{debug, warn};

/// Largest API response the gateway will forward.
///
/// `pane.read` on a long scrollback is the biggest realistic payload; anything
/// beyond this is treated as a runaway response rather than buffered forever.
const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;

/// Hard cap on a single request line from the browser.
const MAX_REQUEST_BYTES: usize = 256 * 1024;

/// Sends one API request and returns the raw JSON response line.
///
/// The response is passed through unchanged so the browser sees exactly what
/// the API produced, including error envelopes.
pub(crate) fn request(socket: &Path, request_line: &str) -> io::Result<String> {
    if request_line.len() > MAX_REQUEST_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "api request is too large",
        ));
    }

    let mut stream = crate::ipc::connect_local_stream(socket)?;
    stream.write_all(request_line.as_bytes())?;
    if !request_line.ends_with('\n') {
        stream.write_all(b"\n")?;
    }
    stream.flush()?;

    read_response_line(&mut stream)
}

/// Reads a single newline-terminated response line with a size cap.
fn read_response_line(stream: &mut impl Read) -> io::Result<String> {
    let mut reader = io::BufReader::new(stream);
    let mut line = String::new();
    let read = reader
        .by_ref()
        .take(MAX_RESPONSE_BYTES as u64)
        .read_line(&mut line)?;
    if read == 0 {
        return Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "api connection closed before responding",
        ));
    }
    if !line.ends_with('\n') && line.len() >= MAX_RESPONSE_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "api response is too large",
        ));
    }
    Ok(line)
}

/// Resolves the API socket for a session name.
///
/// The default session has no directory of its own, which is what
/// `api_socket_path_for(None)` already handles.
pub(crate) fn socket_for_session(name: Option<&str>) -> PathBuf {
    crate::session::api_socket_path_for(name)
}

/// Normalizes a session name from the browser into the API's representation.
///
/// `herdr` calls the unnamed session "default"; the API path for it is the
/// config directory itself, so it maps to `None`.
pub(crate) fn normalize_session(name: &str) -> Option<&str> {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed == crate::session::DEFAULT_SESSION_NAME {
        None
    } else {
        Some(trimmed)
    }
}

/// Lists known sessions from the same source `herdr session list` uses.
pub(crate) fn list_sessions() -> Vec<super::protocol::SessionSummary> {
    match crate::session::list_sessions() {
        Ok(sessions) => sessions
            .into_iter()
            .map(|session| super::protocol::SessionSummary {
                name: session.name,
                default: session.default,
                running: session.running,
            })
            .collect(),
        Err(err) => {
            warn!(err = %err, "failed to list sessions");
            Vec::new()
        }
    }
}

/// True when a socket accepts connections.
pub(crate) fn is_socket_listening(path: &Path) -> bool {
    if !path.exists() {
        return false;
    }
    crate::ipc::connect_local_stream(path).is_ok()
}

/// Ensures the session's server is running and returns its API socket path.
pub(crate) fn ensure_session_server(name: Option<&str>) -> io::Result<PathBuf> {
    let api_socket = socket_for_session(name);
    if is_socket_listening(&api_socket) {
        return Ok(api_socket);
    }

    spawn_session_server(name, &api_socket)?;
    Ok(api_socket)
}

/// Starts `herdr server` for a session as a detached daemon.
fn spawn_session_server(name: Option<&str>, api_socket: &Path) -> io::Result<()> {
    let exe = std::env::current_exe()?;

    let mut command = std::process::Command::new(exe);
    command
        .arg("server")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());

    match name {
        Some(name) => {
            command
                .env(crate::session::SESSION_ENV_VAR, name)
                .env_remove(crate::api::SOCKET_PATH_ENV_VAR)
                .env_remove("HERDR_CLIENT_SOCKET_PATH");
        }
        None => {
            command
                .env_remove(crate::session::SESSION_ENV_VAR)
                .env_remove(crate::api::SOCKET_PATH_ENV_VAR)
                .env_remove("HERDR_CLIENT_SOCKET_PATH");
        }
    }

    crate::platform::detach_server_daemon_command(&mut command);

    command.spawn().map_err(|err| {
        io::Error::new(err.kind(), format!("failed to start session server: {err}"))
    })?;

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while std::time::Instant::now() < deadline {
        if is_socket_listening(api_socket) {
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }

    Err(io::Error::new(
        io::ErrorKind::TimedOut,
        "timed out waiting for session server to start",
    ))
}

/// Streams a subscription, forwarding each response line to `on_line`.
///
/// Runs until the client disconnects or the server closes the stream.
pub(crate) fn subscribe(
    socket: &Path,
    request_line: &str,
    mut on_line: impl FnMut(&str) -> bool,
) -> io::Result<()> {
    let mut stream = crate::ipc::connect_local_stream(socket)?;
    stream.write_all(request_line.as_bytes())?;
    if !request_line.ends_with('\n') {
        stream.write_all(b"\n")?;
    }
    stream.flush()?;

    let reader = io::BufReader::new(stream);
    for line in reader.lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        if !on_line(&line) {
            debug!("subscription consumer stopped");
            return Ok(());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_maps_default_to_none() {
        assert_eq!(normalize_session("default"), None);
        assert_eq!(normalize_session("  "), None);
        assert_eq!(normalize_session("main"), Some("main"));
        assert_eq!(normalize_session(" main "), Some("main"));
    }

    #[test]
    fn default_session_socket_is_config_dir() {
        let path = socket_for_session(None);
        assert!(path.ends_with("herdr.sock"));
        let named = socket_for_session(Some("work"));
        assert!(named.to_string_lossy().contains("sessions"));
        assert_ne!(path, named);
    }
}

#[cfg(test)]
mod resolution_tests {
    use super::*;

    #[test]
    fn named_session_resolves_to_session_dir() {
        let path = socket_for_session(Some("main"));
        assert!(
            path.to_string_lossy().contains("/sessions/main/"),
            "named session must use its own directory, got {}",
            path.display()
        );
    }

    #[test]
    fn normalize_then_resolve_keeps_the_name() {
        // Regression guard: the gateway must not collapse a named session onto
        // the default path, which would read the wrong server.
        let normalized = normalize_session("main");
        assert_eq!(normalized, Some("main"));
        let path = socket_for_session(normalized);
        assert!(path.to_string_lossy().contains("/sessions/main/"));
    }
}

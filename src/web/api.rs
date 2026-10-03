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
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use interprocess::local_socket::traits::Stream as _;
use tracing::{debug, warn};

/// Largest API response the gateway will forward.
///
/// `pane.read` on a long scrollback is the biggest realistic payload; anything
/// beyond this is treated as a runaway response rather than buffered forever.
const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;

/// Hard cap on a single request line from the browser.
const MAX_REQUEST_BYTES: usize = 256 * 1024;

/// Cap for the one request that carries a file upload.
///
/// A file arrives base64-encoded inside the request line, so the default cap
/// would reject anything past roughly 190 KB of file: a single screenshot is
/// routinely larger. Only this method gets the raised limit; every other
/// request keeps the smaller cap so a large body stays a deliberate exception
/// rather than a general allowance.
const MAX_UPLOAD_REQUEST_BYTES: usize = 32 * 1024 * 1024;

/// The request line cap that applies to one method.
pub(crate) fn max_request_bytes_for(method: &str) -> usize {
    match method {
        "pane.stage_upload" => MAX_UPLOAD_REQUEST_BYTES,
        _ => MAX_REQUEST_BYTES,
    }
}

/// Sends one API request with an explicit request-line cap.
///
/// The response is passed through unchanged so the browser sees exactly what
/// the API produced, including error envelopes.
pub(crate) fn request_with_limit(
    socket: &Path,
    request_line: &str,
    max_bytes: usize,
) -> io::Result<String> {
    if request_line.len() > max_bytes {
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

/// How long a subscription read waits before checking whether it should stop.
///
/// The read has to time out for the stop flag to be observed at all: a read on a
/// quiet subscription blocks indefinitely, so a cancel that only set a flag
/// would be noticed whenever the next event happened to arrive — which for a
/// pane nobody is touching may be never. Short enough that cancelling feels
/// immediate, long enough that an idle subscription is not spinning.
const SUBSCRIPTION_READ_TIMEOUT: Duration = Duration::from_millis(200);

/// Streams a subscription, forwarding each response line to `on_line`.
///
/// Runs until the client disconnects, `should_stop` returns true, or the server
/// closes the stream.
///
/// The read timeout and the stop flag together are what make this cancellable.
/// A blocked read cannot be interrupted from outside — `JoinHandle::abort` does
/// nothing for a blocking task — so cancelling has to be cooperative: the read
/// returns empty-handed every `SUBSCRIPTION_READ_TIMEOUT`, and the caller's
/// flag is checked before waiting again. Without that, a subscription with no
/// traffic would hold its thread and its socket until the process exited, which
/// is how the gateway ran its file descriptors out.
pub(crate) fn subscribe(
    socket: &Path,
    request_line: &str,
    should_stop: &AtomicBool,
    mut on_line: impl FnMut(&str) -> bool,
) -> io::Result<()> {
    let mut stream = crate::ipc::connect_local_stream(socket)?;
    // Applied before the request is written so the very first read is bounded.
    stream.set_recv_timeout(Some(SUBSCRIPTION_READ_TIMEOUT))?;
    stream.write_all(request_line.as_bytes())?;
    if !request_line.ends_with('\n') {
        stream.write_all(b"\n")?;
    }
    stream.flush()?;

    let mut reader = io::BufReader::new(stream);
    loop {
        if should_stop.load(Ordering::Relaxed) {
            debug!("subscription cancelled");
            return Ok(());
        }

        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(0) => {
                // A clean EOF is the session server going away — a restart, a
                // stop — not an orderly end of the subscription from this
                // side. Returning it as an error is what makes the caller tell
                // the browser the stream closed; returning Ok here is how a
                // stopped server used to leave every web client with a
                // silently dead event stream that still-serving API requests
                // kept looking alive.
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "session server closed the subscription",
                ));
            }
            Ok(_) => {
                if line.trim().is_empty() {
                    continue;
                }
                if !on_line(&line) {
                    debug!("subscription consumer stopped");
                    return Ok(());
                }
            }
            // A wait with no data: expected, and the point of the timeout. The
            // stop flag is checked at the top of the loop.
            Err(err)
                if matches!(
                    err.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                ) =>
            {
                continue;
            }
            // A read that was interrupted partway through must not lose what it
            // already buffered: `read_line` keeps its partial line in `line` and
            // the next call appends to it, so continuing is safe.
            Err(err) if err.kind() == io::ErrorKind::Interrupted => continue,
            Err(err) => return Err(err),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A quiet subscription must still be cancellable.
    ///
    /// This is the regression that mattered: a subscription with no traffic sat
    /// in a blocking read forever, because cancelling only set a flag and nothing
    /// ever woke the read to observe it. The thread and its socket stayed alive,
    /// and enough of them exhausted the gateway's file descriptors.
    ///
    /// The listener here never sends a line, so the only way out is the stop flag
    /// plus the read timeout.
    #[test]
    fn a_subscription_with_no_traffic_stops_when_asked() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;

        let dir = std::env::temp_dir().join(format!(
            "herdr-web-subscribe-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let socket = dir.join("api.sock");

        let listener = crate::ipc::bind_local_listener(&socket).unwrap();

        // Accept the connection and then stay silent, which is what a subscription
        // to a pane nobody is touching looks like.
        let held = std::thread::spawn(move || {
            use interprocess::local_socket::traits::Listener as _;
            let mut stream = listener.accept().unwrap();
            let mut request = String::new();
            let _ = std::io::BufReader::new(&mut stream).read_line(&mut request);
            std::thread::sleep(std::time::Duration::from_secs(3));
        });

        let stop = Arc::new(AtomicBool::new(false));
        let stop_for_caller = Arc::clone(&stop);
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(300));
            stop_for_caller.store(true, Ordering::Relaxed);
        });

        let started = std::time::Instant::now();
        let result = subscribe(
            &socket,
            "{\"id\":\"sub\",\"method\":\"events.subscribe\"}\n",
            &stop,
            |_line| true,
        );

        assert!(result.is_ok(), "cancelling must return cleanly: {result:?}");
        assert!(
            started.elapsed() < std::time::Duration::from_secs(2),
            "cancelling must not wait for traffic: took {:?}",
            started.elapsed()
        );

        let _ = held.join();
        let _ = std::fs::remove_dir_all(&dir);
    }

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

    #[test]
    fn only_the_upload_method_gets_the_raised_request_cap() {
        // A screenshot base64-encoded is routinely larger than the default cap,
        // so the upload method has to be exempt from it.
        assert_eq!(
            max_request_bytes_for("pane.stage_upload"),
            MAX_UPLOAD_REQUEST_BYTES
        );
        // The raised cap is only useful if it is actually larger: a file that
        // fits the default cap does not need this method to be special.
        const { assert!(MAX_UPLOAD_REQUEST_BYTES > MAX_REQUEST_BYTES) };

        for method in ["pane.read", "pane.send_input", "session.snapshot", "ping"] {
            assert_eq!(
                max_request_bytes_for(method),
                MAX_REQUEST_BYTES,
                "{method} must keep the default cap"
            );
        }
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

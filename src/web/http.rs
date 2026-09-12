//! Minimal HTTP/1.1 static file serving for the web gateway.
//!
//! Only what the gateway needs: `GET`/`HEAD` for the built UI. Requests are
//! parsed with a hard size cap, and every resolved path is checked to stay
//! inside the configured root so a crafted request cannot read arbitrary files.

use std::io;
use std::path::{Component, Path, PathBuf};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

/// Cap on request headers. The gateway serves static assets only; no request
/// body is ever read, so a large header block is always abusive.
const MAX_HEADER_BYTES: usize = 16 * 1024;

/// A parsed request line plus the headers we care about.
#[derive(Debug)]
pub(crate) struct Request {
    pub method: String,
    pub target: String,
    pub origin: Option<String>,
    /// Raw header block (after the request line) for upgrade detection.
    headers: String,
}

impl Request {
    /// Returns true when the request is a WebSocket upgrade.
    pub fn is_upgrade(&self) -> bool {
        header_value(&self.headers, "upgrade").is_some_and(|v| v.eq_ignore_ascii_case("websocket"))
    }

    /// Returns the `Sec-WebSocket-Key` value, if present.
    pub fn websocket_key(&self) -> Option<&str> {
        header_value(&self.headers, "sec-websocket-key")
    }
}

fn header_value<'a>(headers: &'a str, name: &str) -> Option<&'a str> {
    headers.lines().find_map(|line| {
        let (key, value) = line.split_once(':')?;
        key.trim().eq_ignore_ascii_case(name).then(|| value.trim())
    })
}

/// Reads and parses the request head, leaving any extra bytes unconsumed.
///
/// Returns the parsed request and the raw bytes that follow the head, which
/// the WebSocket handshake may need.
pub(crate) async fn read_request(stream: &mut TcpStream) -> io::Result<(Request, Vec<u8>)> {
    let mut buf = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];

    let head_end = loop {
        if let Some(pos) = find_head_end(&buf) {
            break pos;
        }
        if buf.len() > MAX_HEADER_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "request headers too large",
            ));
        }
        let read = stream.read(&mut chunk).await?;
        if read == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "connection closed before request head",
            ));
        }
        buf.extend_from_slice(&chunk[..read]);
    };

    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
    let rest = buf[head_end + 4..].to_vec();

    let mut lines = head.lines();
    let request_line = lines.next().unwrap_or_default();
    // Everything after the request line is the header block.
    let headers: String = lines.collect::<Vec<_>>().join("\n");
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_string();
    let target = parts.next().unwrap_or_default().to_string();

    Ok((
        Request {
            method,
            target,
            origin: header_value(&headers, "origin").map(str::to_string),
            headers,
        },
        rest,
    ))
}

fn find_head_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n")
}

/// Maps a request target to a file under `root`.
///
/// Returns `None` for anything that escapes the root or is not a plain file
/// path. Directory requests fall back to `index.html`.
pub(crate) fn resolve_path(root: &Path, target: &str) -> Option<PathBuf> {
    let path = target.split(['?', '#']).next().unwrap_or(target);
    let decoded = percent_decode(path);

    // Reject traversal and absolute paths outright. Percent-decoding happens
    // first so an encoded `..` cannot slip through.
    let mut out = PathBuf::new();
    for component in Path::new(decoded.trim_start_matches('/')).components() {
        match component {
            Component::Normal(part) => out.push(part),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return None,
        }
    }

    if out.as_os_str().is_empty() {
        out.push("index.html");
    }

    let resolved = root.join(&out);
    if resolved.is_dir() {
        return Some(resolved.join("index.html"));
    }
    Some(resolved)
}

/// Decodes `%XX` escapes. Invalid escapes are kept literally.
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
            if let Some(value) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(value);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Best-effort content type for the assets a built UI ships.
pub(crate) fn content_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("html") => "text/html; charset=utf-8",
        Some("js") | Some("mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") | Some("map") => "application/json; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("ico") => "image/x-icon",
        Some("woff2") => "font/woff2",
        Some("woff") => "font/woff",
        Some("txt") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// Writes a small JSON or text response and closes the connection.
pub(crate) async fn write_simple(
    stream: &mut TcpStream,
    status: u16,
    content_type: &str,
    body: &str,
) -> io::Result<()> {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        413 => "Payload Too Large",
        426 => "Upgrade Required",
        500 => "Internal Server Error",
        _ => "Error",
    };
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\n\
         Content-Type: {content_type}\r\n\
         Content-Length: {len}\r\n\
         Cache-Control: no-store\r\n\
         Connection: close\r\n\
         \r\n{body}",
        len = body.len(),
    );
    stream.write_all(response.as_bytes()).await?;
    stream.flush().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_serves_index_for_root() {
        let resolved = resolve_path(Path::new("/srv/ui"), "/").unwrap();
        assert!(resolved.ends_with("index.html"));
    }

    #[test]
    fn resolve_keeps_plain_asset_paths() {
        let resolved = resolve_path(Path::new("/srv/ui"), "/assets/app.js").unwrap();
        assert!(resolved.ends_with("assets/app.js"));
    }

    #[test]
    fn resolve_strips_query_and_fragment() {
        let resolved = resolve_path(Path::new("/srv/ui"), "/app.js?v=2#top").unwrap();
        assert!(resolved.ends_with("app.js"));
    }

    #[test]
    fn resolve_rejects_parent_traversal() {
        assert!(resolve_path(Path::new("/srv/ui"), "/../etc/passwd").is_none());
        assert!(resolve_path(Path::new("/srv/ui"), "/assets/../../etc/passwd").is_none());
    }

    #[test]
    fn resolve_rejects_encoded_traversal() {
        assert!(resolve_path(Path::new("/srv/ui"), "/%2e%2e/etc/passwd").is_none());
        assert!(resolve_path(Path::new("/srv/ui"), "/assets/%2E%2E%2F%2E%2E/etc/passwd").is_none());
    }

    #[test]
    fn resolve_allows_dots_in_file_names() {
        let resolved = resolve_path(Path::new("/srv/ui"), "/app.min.js").unwrap();
        assert!(resolved.ends_with("app.min.js"));
    }

    #[test]
    fn content_type_covers_common_assets() {
        assert!(content_type(Path::new("a.html")).starts_with("text/html"));
        assert!(content_type(Path::new("a.js")).starts_with("text/javascript"));
        assert_eq!(content_type(Path::new("a.bin")), "application/octet-stream");
    }

    #[test]
    fn header_lookup_is_case_insensitive() {
        let headers = "Origin: https://example.com\r\nX-Other: 1";
        assert_eq!(header_value(headers, "origin"), Some("https://example.com"));
    }

    #[test]
    fn detects_websocket_upgrade() {
        let request = Request {
            method: "GET".to_string(),
            target: "/".to_string(),
            origin: None,
            headers: "Host: x\nUpgrade: websocket\nConnection: Upgrade".to_string(),
        };
        assert!(request.is_upgrade());

        let plain = Request {
            method: "GET".to_string(),
            target: "/".to_string(),
            origin: None,
            headers: "Host: x".to_string(),
        };
        assert!(!plain.is_upgrade());
    }
}

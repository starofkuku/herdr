//! Web gateway: serves the browser UI and proxies the Herdr JSON API.
//!
//! This is a separate process (the `herdr web` subcommand), not part of any
//! session's server. That matters: a session server only knows about its own
//! session, so only a process outside them can list every session and let the
//! user pick one.
//!
//! The gateway is a thin proxy over the public JSON API. The browser sends the
//! same requests the CLI sends, so the UI depends only on documented API
//! methods and never on the private client/server terminal wire format.

pub(crate) mod api;
pub(crate) mod auth;
pub(crate) mod http;
pub(crate) mod protocol;
pub(crate) mod update;

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use futures_util::{SinkExt as _, StreamExt as _};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::{self, Message};
use tracing::{debug, error, info, warn};

use auth::{KeyError, WebKey};
use protocol::{ClientMessage, ServerMessage};

/// Runtime settings for one gateway process.
pub(crate) struct WebOptions {
    pub bind: String,
    pub port: u16,
    pub static_dir: Option<PathBuf>,
    /// Resolved uploads directory, shared with the server so both sides agree
    /// on where a staged file is written and served from.
    pub uploads_dir: Option<PathBuf>,
    pub allowed_origins: Vec<String>,
    pub key: WebKey,
}

/// Runs the gateway until the process is stopped.
///
/// Fails before binding when the address is unavailable, so a misconfigured
/// gateway does not silently sit on a port it cannot serve.
pub(crate) fn run(options: WebOptions) -> std::io::Result<()> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;

    runtime.block_on(async move {
        let addr: SocketAddr = format!("{}:{}", options.bind, options.port)
            .parse()
            .map_err(|err| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    format!("invalid web bind address: {err}"),
                )
            })?;

        let listener = TcpListener::bind(addr).await.map_err(|err| {
            std::io::Error::new(
                err.kind(),
                format!("failed to bind web gateway to {addr}: {err}"),
            )
        })?;

        let static_dir = options.static_dir.as_deref().map(expand_tilde);
        let uploads_dir = options.uploads_dir.clone();

        if let Some(dir) = &static_dir {
            if !dir.is_dir() {
                warn!(
                    path = %dir.display(),
                    "web static dir does not exist; only the WebSocket endpoint will work"
                );
            }
        }

        info!(
            %addr,
            static_dir = ?static_dir,
            key_source = %options.key.source(),
            "web gateway listening"
        );
        println!("herdr web listening on http://{addr}");
        println!("web key source: {}", options.key.source());

        let shared = Arc::new(SharedState {
            key: options.key,
            static_dir,
            uploads_dir,
            allowed_origins: options.allowed_origins,
        });

        loop {
            let (stream, peer) = match listener.accept().await {
                Ok(pair) => pair,
                Err(err) => {
                    error!(err = %err, "web accept failed");
                    continue;
                }
            };

            let shared = shared.clone();
            tokio::spawn(async move {
                if let Err(err) = handle_connection(stream, peer, shared).await {
                    debug!(%peer, err = %err, "web connection ended");
                }
            });
        }
    })
}

struct SharedState {
    key: WebKey,
    static_dir: Option<PathBuf>,
    /// Resolved uploads directory; `None` when neither `uploads_dir` nor
    /// `static_dir` is configured, in which case `/uploads/*` is not served.
    uploads_dir: Option<PathBuf>,
    allowed_origins: Vec<String>,
}

/// Expands a leading `~` to the user's home directory.
pub(crate) fn expand_tilde(path: &Path) -> PathBuf {
    let raw = path.to_string_lossy();
    let Some(rest) = raw.strip_prefix("~/") else {
        return path.to_path_buf();
    };
    let Some(home) = std::env::var_os("HOME") else {
        return path.to_path_buf();
    };
    PathBuf::from(home).join(rest)
}

async fn handle_connection(
    mut stream: TcpStream,
    peer: SocketAddr,
    shared: Arc<SharedState>,
) -> std::io::Result<()> {
    let (request, rest) = http::read_request(&mut stream).await?;

    if request.is_upgrade() {
        return handle_websocket(stream, peer, shared, &request, rest).await;
    }

    if request.target.starts_with(UPLOADS_ROUTE_PREFIX) {
        return handle_upload_asset(stream, &request, shared).await;
    }

    handle_static(stream, &request, shared).await
}

/// Route prefix uploaded files are served from.
const UPLOADS_ROUTE_PREFIX: &str = "/uploads/";

/// Serves one uploaded file.
///
/// This route is deliberately unauthenticated: the browser references the file
/// from an `<img>` or a download link, and neither can carry the gateway key.
/// The filename is unguessable instead, which is what keeps one upload from
/// being found by guessing at another.
///
async fn handle_upload_asset(
    mut stream: TcpStream,
    request: &http::Request,
    shared: Arc<SharedState>,
) -> std::io::Result<()> {
    if request.method != "GET" && request.method != "HEAD" {
        return http::write_simple(&mut stream, 405, "text/plain", "method not allowed").await;
    }

    let Some(dir) = shared.uploads_dir.as_deref() else {
        return http::write_simple(
            &mut stream,
            404,
            "text/plain",
            "uploads are not configured; set [web] static_dir or [web] uploads_dir",
        )
        .await;
    };

    // `resolve_path` rejects traversal, so a name cannot escape the uploads
    // directory. The prefix is stripped first so the remainder is a plain name.
    let relative = request
        .target
        .strip_prefix(UPLOADS_ROUTE_PREFIX)
        .unwrap_or(&request.target);
    let Some(path) = http::resolve_path(dir, relative) else {
        return http::write_simple(&mut stream, 400, "text/plain", "bad path").await;
    };

    let extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let serving = crate::server::uploads::serving_for(&extension);

    // An image renders inline so a preview works. Everything else downloads:
    // this route shares an origin with the web UI, so a document the browser is
    // willing to execute could otherwise run script in that origin and read the
    // gateway key.
    let disposition =
        if serving.attachment || crate::server::uploads::must_force_download(&extension) {
            "attachment"
        } else {
            "inline"
        };
    let nosniff = if serving.is_image {
        ""
    } else {
        "X-Content-Type-Options: nosniff\r\n"
    };

    match tokio::fs::read(&path).await {
        Ok(body) => {
            let header = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: {}\r\nContent-Length: {}\r\n\
                 Content-Disposition: {disposition}\r\n{nosniff}\
                 Cache-Control: no-cache\r\nConnection: close\r\n\r\n",
                serving.content_type,
                body.len()
            );
            use tokio::io::AsyncWriteExt as _;
            stream.write_all(header.as_bytes()).await?;
            if request.method == "GET" {
                stream.write_all(&body).await?;
            }
            stream.flush().await
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            http::write_simple(&mut stream, 404, "text/plain", "not found").await
        }
        Err(err) if err.kind() == std::io::ErrorKind::PermissionDenied => {
            http::write_simple(&mut stream, 403, "text/plain", "forbidden").await
        }
        Err(err) => {
            debug!(path = %path.display(), err = %err, "failed to read uploaded asset");
            http::write_simple(&mut stream, 500, "text/plain", "internal error").await
        }
    }
}

async fn handle_static(
    mut stream: TcpStream,
    request: &http::Request,
    shared: Arc<SharedState>,
) -> std::io::Result<()> {
    if request.method != "GET" && request.method != "HEAD" {
        return http::write_simple(&mut stream, 405, "text/plain", "method not allowed").await;
    }

    let Some(dir) = shared.static_dir.as_deref() else {
        return http::write_simple(
            &mut stream,
            404,
            "text/plain",
            "no web UI configured; set [web] static_dir",
        )
        .await;
    };

    let Some(path) = http::resolve_path(dir, &request.target) else {
        return http::write_simple(&mut stream, 400, "text/plain", "bad path").await;
    };

    match tokio::fs::read(&path).await {
        Ok(body) => {
            let content_type = http::content_type(&path);
            let header = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\n\
                 Cache-Control: no-cache\r\nConnection: close\r\n\r\n",
                body.len()
            );
            use tokio::io::AsyncWriteExt as _;
            stream.write_all(header.as_bytes()).await?;
            if request.method == "GET" {
                stream.write_all(&body).await?;
            }
            stream.flush().await
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            http::write_simple(&mut stream, 404, "text/plain", "not found").await
        }
        Err(err) if err.kind() == std::io::ErrorKind::PermissionDenied => {
            http::write_simple(&mut stream, 403, "text/plain", "forbidden").await
        }
        Err(err) => {
            debug!(path = %path.display(), err = %err, "failed to read static asset");
            http::write_simple(&mut stream, 500, "text/plain", "internal error").await
        }
    }
}

/// WebSocket limits for the browser connection.
///
/// A file upload arrives as one JSON frame with the bytes base64-encoded, so a
/// 16 MiB file is about 21 MiB on the wire. The library defaults cap a single
/// frame at 16 MiB, which silently dropped anything past roughly 12 MiB of
/// file: the socket closed with no response and the handler never ran. The
/// frame limit is raised to cover the largest file the API accepts, and the
/// message limit is raised past it so the frame limit is the binding one.
///
/// These bounds stay well below the protocol's own request cap, so they only
/// stop a runaway frame rather than acting as the real size check.
fn websocket_config() -> tungstenite::protocol::WebSocketConfig {
    /// Largest file the API accepts, before base64 expansion, plus headroom.
    const MAX_UPLOAD_FRAME_BYTES: usize = 32 * 1024 * 1024;

    // `WebSocketConfig` is non-exhaustive, so it is built from `Default` and
    // adjusted rather than written out as a struct literal.
    let mut config = tungstenite::protocol::WebSocketConfig::default();
    config.max_frame_size = Some(MAX_UPLOAD_FRAME_BYTES);
    config.max_message_size = Some(MAX_UPLOAD_FRAME_BYTES);
    config
}

async fn handle_websocket(
    mut stream: TcpStream,
    peer: SocketAddr,
    shared: Arc<SharedState>,
    request: &http::Request,
    rest: Vec<u8>,
) -> std::io::Result<()> {
    // Reject a disallowed Origin before upgrading, so a page that is not
    // allowed never gets an open socket at all.
    if !shared.allowed_origins.is_empty() {
        let allowed = request
            .origin
            .as_deref()
            .is_some_and(|origin| shared.allowed_origins.iter().any(|a| a == origin));
        if !allowed {
            warn!(%peer, origin = ?request.origin, "web origin rejected");
            return http::write_simple(&mut stream, 403, "text/plain", "origin not allowed").await;
        }
    }

    let Some(key) = request.websocket_key() else {
        return http::write_simple(&mut stream, 400, "text/plain", "missing websocket key").await;
    };

    // Complete the RFC 6455 handshake ourselves so the pre-read bytes from the
    // request head are not lost and Origin is checked first.
    let accept = tungstenite::handshake::derive_accept_key(key.as_bytes());
    let response = format!(
        "HTTP/1.1 101 Switching Protocols\r\n\
         Upgrade: websocket\r\n\
         Connection: Upgrade\r\n\
         Sec-WebSocket-Accept: {accept}\r\n\r\n"
    );
    use tokio::io::AsyncWriteExt as _;
    stream.write_all(response.as_bytes()).await?;
    stream.flush().await?;

    let ws = tokio_tungstenite::WebSocketStream::from_partially_read(
        stream,
        rest,
        tungstenite::protocol::Role::Server,
        Some(websocket_config()),
    )
    .await;

    info!(%peer, "web client connected");
    let result = run_client(ws, shared, peer).await;
    info!(%peer, "web client disconnected");
    result
}

/// Per-connection state machine for one browser client.
async fn run_client(
    ws: tokio_tungstenite::WebSocketStream<TcpStream>,
    shared: Arc<SharedState>,
    peer: SocketAddr,
) -> std::io::Result<()> {
    let (mut sink, mut source) = ws.split();

    send(
        &mut sink,
        &ServerMessage::Hello {
            protocol: protocol::PROTOCOL_VERSION,
            authenticated: false,
        },
    )
    .await?;

    // Authentication is required before anything else.
    let mut authenticated = false;
    // Session this connection is bound to, resolved on first `use_session`.
    let mut api_socket: Option<PathBuf> = None;
    // Live subscription tasks, keyed by the browser's id.
    let mut subscriptions: std::collections::HashMap<String, tokio::task::JoinHandle<()>> =
        std::collections::HashMap::new();
    // Events produced by subscription tasks.
    let (events_tx, mut events_rx) = mpsc::unbounded_channel::<ServerMessage>();

    let result: std::io::Result<()> = loop {
        tokio::select! {
            incoming = source.next() => {
                let Some(incoming) = incoming else { break Ok(()) };
                match incoming {
                    Ok(Message::Text(text)) => {
                        match serde_json::from_str::<ClientMessage>(&text) {
                            Ok(message) => {
                                if let Err(err) = handle_message(
                                    message,
                                    &shared,
                                    &mut authenticated,
                                    &mut api_socket,
                                    &mut subscriptions,
                                    &events_tx,
                                    &mut sink,
                                    peer,
                                ).await {
                                    break Err(err);
                                }
                            }
                            Err(err) => {
                                debug!(%peer, err = %err, "invalid web message");
                                send(&mut sink, &ServerMessage::Error {
                                    message: "invalid message".to_string(),
                                }).await?;
                            }
                        }
                    }
                    Ok(Message::Binary(_)) | Ok(Message::Ping(_)) | Ok(Message::Pong(_)) => {}
                    Ok(Message::Close(_)) => break Ok(()),
                    Ok(_) => {}
                    Err(err) => {
                        debug!(%peer, err = %err, "web socket read failed");
                        break Ok(());
                    }
                }
            }
            event = events_rx.recv() => {
                let Some(message) = event else { continue };
                if send(&mut sink, &message).await.is_err() {
                    break Ok(());
                }
            }
        }
    };

    for (_, handle) in subscriptions {
        handle.abort();
    }
    let _ = sink.close().await;
    result
}

#[allow(clippy::too_many_arguments)]
async fn handle_message(
    message: ClientMessage,
    shared: &SharedState,
    authenticated: &mut bool,
    api_socket: &mut Option<PathBuf>,
    subscriptions: &mut std::collections::HashMap<String, tokio::task::JoinHandle<()>>,
    events_tx: &mpsc::UnboundedSender<ServerMessage>,
    sink: &mut futures_util::stream::SplitSink<
        tokio_tungstenite::WebSocketStream<TcpStream>,
        Message,
    >,
    peer: SocketAddr,
) -> std::io::Result<()> {
    match message {
        ClientMessage::Auth { key, protocol } => {
            if let Some(version) = protocol {
                if version != protocol::PROTOCOL_VERSION {
                    send(
                        sink,
                        &ServerMessage::Error {
                            message: format!(
                                "protocol mismatch: gateway speaks {}, client sent {version}; reload the page",
                                protocol::PROTOCOL_VERSION
                            ),
                        },
                    )
                    .await?;
                    return Ok(());
                }
            }

            if shared.key.verify(&key) {
                *authenticated = true;
                send(
                    sink,
                    &ServerMessage::Hello {
                        protocol: protocol::PROTOCOL_VERSION,
                        authenticated: true,
                    },
                )
                .await?;
            } else {
                warn!(%peer, "web authentication failed");
                send(
                    sink,
                    &ServerMessage::Error {
                        message: "authentication failed".to_string(),
                    },
                )
                .await?;
            }
            Ok(())
        }

        ClientMessage::SessionsList => {
            if !*authenticated {
                return send_unauthorized(sink).await;
            }
            send(
                sink,
                &ServerMessage::Sessions {
                    items: api::list_sessions(),
                },
            )
            .await
        }

        ClientMessage::UseSession { name } => {
            if !*authenticated {
                return send_unauthorized(sink).await;
            }
            if !name.trim().is_empty() && name != crate::session::DEFAULT_SESSION_NAME {
                if let Err(reason) = crate::session::validate_name(&name) {
                    return send(sink, &ServerMessage::Error { message: reason }).await;
                }
            }

            let normalized = api::normalize_session(&name).map(str::to_string);
            let name_for_log = name.clone();
            let resolved = tokio::task::spawn_blocking(move || {
                api::ensure_session_server(normalized.as_deref())
            })
            .await
            .map_err(std::io::Error::other)?;

            match resolved {
                Ok(socket) => {
                    *api_socket = Some(socket);
                    send(sink, &ServerMessage::SessionReady { name: name_for_log }).await
                }
                Err(err) => {
                    send(
                        sink,
                        &ServerMessage::Error {
                            message: err.to_string(),
                        },
                    )
                    .await
                }
            }
        }

        ClientMessage::Api { id, method, params } => {
            if !*authenticated {
                return send_unauthorized(sink).await;
            }
            let Some(socket) = api_socket.clone() else {
                return send(
                    sink,
                    &ServerMessage::Error {
                        message: "no session selected".to_string(),
                    },
                )
                .await;
            };

            let request_limit = api::max_request_bytes_for(&method);
            let line = serde_json::to_string(&serde_json::json!({
                "id": id,
                "method": method,
                "params": params,
            }))
            .map_err(std::io::Error::other)?;

            let response = tokio::task::spawn_blocking(move || {
                api::request_with_limit(&socket, &line, request_limit)
            })
            .await
            .map_err(std::io::Error::other)?;

            let payload = match response {
                Ok(raw) => serde_json::from_str::<serde_json::Value>(raw.trim())
                    .unwrap_or_else(|_| serde_json::json!({"raw": raw})),
                Err(err) => serde_json::json!({
                    "error": {"code": "gateway_error", "message": err.to_string()}
                }),
            };

            send(
                sink,
                &ServerMessage::ApiResult {
                    id,
                    result: payload,
                },
            )
            .await
        }

        ClientMessage::Subscribe {
            id,
            subscriptions: subs,
        } => {
            if !*authenticated {
                return send_unauthorized(sink).await;
            }
            let Some(socket) = api_socket.clone() else {
                return send(
                    sink,
                    &ServerMessage::Error {
                        message: "no session selected".to_string(),
                    },
                )
                .await;
            };

            // Replace an existing subscription with the same id.
            if let Some(previous) = subscriptions.remove(&id) {
                previous.abort();
            }

            let line = serde_json::to_string(&serde_json::json!({
                "id": id,
                "method": "events.subscribe",
                "params": { "subscriptions": subs },
            }))
            .map_err(std::io::Error::other)?;

            let tx = events_tx.clone();
            let sub_id = id.clone();
            let handle = tokio::task::spawn_blocking(move || {
                let result = api::subscribe(&socket, &line, |line| {
                    let payload = match serde_json::from_str::<serde_json::Value>(line) {
                        Ok(value) => value,
                        Err(_) => return true,
                    };
                    tx.send(ServerMessage::Event {
                        id: sub_id.clone(),
                        payload,
                    })
                    .is_ok()
                });
                if let Err(err) = result {
                    let _ = tx.send(ServerMessage::EventClosed {
                        id: sub_id,
                        reason: err.to_string(),
                    });
                }
            });
            subscriptions.insert(id, handle);
            Ok(())
        }

        ClientMessage::Unsubscribe { id } => {
            if let Some(handle) = subscriptions.remove(&id) {
                handle.abort();
            }
            Ok(())
        }
    }
}

async fn send_unauthorized(
    sink: &mut futures_util::stream::SplitSink<
        tokio_tungstenite::WebSocketStream<TcpStream>,
        Message,
    >,
) -> std::io::Result<()> {
    send(
        sink,
        &ServerMessage::Error {
            message: "not authenticated".to_string(),
        },
    )
    .await
}

async fn send(
    sink: &mut futures_util::stream::SplitSink<
        tokio_tungstenite::WebSocketStream<TcpStream>,
        Message,
    >,
    message: &ServerMessage,
) -> std::io::Result<()> {
    let text = serde_json::to_string(message).map_err(std::io::Error::other)?;
    sink.send(Message::Text(text.into()))
        .await
        .map_err(std::io::Error::other)
}

/// Resolves gateway options from config, failing when no key is configured.
pub(crate) fn options_from_config(config: &crate::config::Config) -> Result<WebOptions, KeyError> {
    let config_path = crate::config::config_path();
    let key = WebKey::load(config.web.key.as_deref(), Some(&config_path))?;
    Ok(WebOptions {
        bind: config.web.bind.clone(),
        port: config.web.port,
        static_dir: config.web.static_dir.clone().map(PathBuf::from),
        uploads_dir: crate::server::uploads::uploads_dir(config),
        allowed_origins: config.web.allowed_origins.clone(),
        key,
    })
}

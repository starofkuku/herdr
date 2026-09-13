//! Web gateway: serves the browser UI and bridges browser attachments to
//! Herdr server sessions.
//!
//! This is a separate process (the `herdr web` subcommand), not part of any
//! session's server. That matters: a session server only knows about its own
//! session, so only a process outside them can list every session and let the
//! user pick one.

pub(crate) mod auth;
pub(crate) mod bridge;
pub(crate) mod http;
pub(crate) mod protocol;

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::Engine as _;
use futures_util::{SinkExt as _, StreamExt as _};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::tungstenite::{self, Message};
use tracing::{debug, error, info, warn};

use auth::{KeyError, WebKey};
use bridge::{Bridge, BridgeEvent, BridgeInput};
use protocol::{ClientMessage, ServerMessage, SessionSummary};

/// Default terminal size used when a browser does not report one yet.
const DEFAULT_COLS: u16 = 80;
const DEFAULT_ROWS: u16 = 24;

/// Narrowest viewport we will forward. Below this the TUI cannot render.
const MIN_COLS: u16 = 20;
const MIN_ROWS: u16 = 5;

/// Largest viewport we accept, so a hostile client cannot force giant renders.
const MAX_COLS: u16 = 500;
const MAX_ROWS: u16 = 300;

/// Runtime settings for one gateway process.
pub(crate) struct WebOptions {
    pub bind: String,
    pub port: u16,
    pub static_dir: Option<PathBuf>,
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

        if let Some(dir) = &static_dir {
            if !dir.is_dir() {
                warn!(
                    path = %dir.display(),
                    "web static dir does not exist; only the WebSocket endpoint will work"
                );
            }
        }

        info!(%addr, static_dir = ?static_dir, key_source = %options.key.source(), "web gateway listening");
        println!("herdr web listening on http://{addr}");
        println!("web key source: {}", options.key.source());

        let shared = std::sync::Arc::new(SharedState {
            key: options.key,
            static_dir,
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
    allowed_origins: Vec<String>,
}

/// Expands a leading `~` to the user's home directory.
fn expand_tilde(path: &Path) -> PathBuf {
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
    shared: std::sync::Arc<SharedState>,
) -> std::io::Result<()> {
    let (request, rest) = http::read_request(&mut stream).await?;

    if request.is_upgrade() {
        return handle_websocket(stream, peer, shared, &request, rest).await;
    }

    handle_static(stream, &request, shared).await
}

async fn handle_static(
    mut stream: TcpStream,
    request: &http::Request,
    shared: std::sync::Arc<SharedState>,
) -> std::io::Result<()> {
    if request.method != "GET" && request.method != "HEAD" {
        // A non-upgrade POST to the gateway has no meaning.
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

async fn handle_websocket(
    mut stream: TcpStream,
    peer: SocketAddr,
    shared: std::sync::Arc<SharedState>,
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
        None,
    )
    .await;

    info!(%peer, "web client connected");

    let session = run_session(ws, shared, peer).await;
    info!(%peer, "web client disconnected");
    session
}

/// Per-connection state machine.
async fn run_session(
    ws: tokio_tungstenite::WebSocketStream<TcpStream>,
    shared: std::sync::Arc<SharedState>,
    peer: SocketAddr,
) -> std::io::Result<()> {
    let (mut sink, mut source) = ws.split();

    send_json_split(
        &mut sink,
        &ServerMessage::Hello {
            protocol: protocol::PROTOCOL_VERSION,
            authenticated: false,
        },
    )
    .await?;

    // Auth must be the first message. Anything else closes the connection.
    let mut authenticated = false;
    let mut bridge: Option<(String, Bridge)> = None;

    // Frames produced by the current attachment.
    let (events_tx, mut events_rx) = tokio::sync::mpsc::unbounded_channel::<BridgeEvent>();

    let result: std::io::Result<()> = loop {
        tokio::select! {
            incoming = source.next() => {
                let Some(incoming) = incoming else { break Ok(()) };
                match incoming {
                    Ok(Message::Text(text)) => {
                        match serde_json::from_str::<ClientMessage>(&text) {
                            Ok(message) => {
                                if let Err(err) = handle_client_message(
                                    message,
                                    &shared,
                                    &mut authenticated,
                                    &mut bridge,
                                    &events_tx,
                                    &mut sink,
                                    peer,
                                ).await {
                                    break Err(err);
                                }
                            }
                            Err(err) => {
                                debug!(%peer, err = %err, "invalid web message");
                                send_json_split(&mut sink, &ServerMessage::Error {
                                    message: "invalid message".to_string(),
                                }).await?;
                            }
                        }
                    }
                    Ok(Message::Binary(_)) => {}
                    Ok(Message::Close(_)) => break Ok(()),
                    Ok(_) => {}
                    Err(err) => {
                        debug!(%peer, err = %err, "web socket read failed");
                        break Ok(());
                    }
                }
            }
            event = events_rx.recv() => {
                let Some(event) = event else { continue };
                match event {
                    BridgeEvent::Frame { seq, width, height, full, bytes } => {
                        let message = ServerMessage::Frame {
                            seq,
                            cols: width,
                            rows: height,
                            full,
                            data: base64::engine::general_purpose::STANDARD.encode(&bytes),
                        };
                        if send_json_split(&mut sink, &message).await.is_err() {
                            break Ok(());
                        }
                    }
                    BridgeEvent::Closed { reason } => {
                        bridge = None;
                        if send_json_split(&mut sink, &ServerMessage::Closed { reason }).await.is_err() {
                            break Ok(());
                        }
                    }
                    BridgeEvent::MouseCapture { enabled } => {
                        if send_json_split(&mut sink, &ServerMessage::MouseMode { enabled })
                            .await
                            .is_err()
                        {
                            break Ok(());
                        }
                    }
                }
            }
        }
    };

    // Dropping the bridge closes the server-side attachment.
    drop(bridge);
    let _ = sink.close().await;
    result
}

async fn handle_client_message(
    message: ClientMessage,
    shared: &SharedState,
    authenticated: &mut bool,
    bridge: &mut Option<(String, Bridge)>,
    events_tx: &tokio::sync::mpsc::UnboundedSender<BridgeEvent>,
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
                    send_json_split(
                        sink,
                        &ServerMessage::Error {
                            message: format!(
                                "protocol mismatch: gateway speaks {}, client sent {version}",
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
                send_json_split(
                    sink,
                    &ServerMessage::Hello {
                        protocol: protocol::PROTOCOL_VERSION,
                        authenticated: true,
                    },
                )
                .await?;
            } else {
                warn!(%peer, "web authentication failed");
                send_json_split(
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
            let items = list_sessions();
            send_json_split(sink, &ServerMessage::Sessions { items }).await
        }

        ClientMessage::SessionOpen { name, cols, rows } => {
            if !*authenticated {
                return send_unauthorized(sink).await;
            }
            if let Err(reason) = crate::session::validate_name(&name) {
                return send_json_split(sink, &ServerMessage::Error { message: reason }).await;
            }

            let cols = cols.unwrap_or(DEFAULT_COLS).clamp(MIN_COLS, MAX_COLS);
            let rows = rows.unwrap_or(DEFAULT_ROWS).clamp(MIN_ROWS, MAX_ROWS);

            // Detach any existing attachment first. Replacing the handle drops
            // the old input sender, but the old reader thread would otherwise
            // keep forwarding frames into the same channel and interleave two
            // sessions' output.
            if let Some((_, previous)) = bridge.take() {
                previous.send(BridgeInput::Detach);
            }

            match attach_to_session(&name, cols, rows, events_tx.clone()).await {
                Ok(attached) => {
                    *bridge = Some((name.clone(), attached));
                    send_json_split(sink, &ServerMessage::Opened { name }).await
                }
                Err(err) => {
                    send_json_split(
                        sink,
                        &ServerMessage::Error {
                            message: err.to_string(),
                        },
                    )
                    .await
                }
            }
        }

        ClientMessage::Input { data } => {
            if !*authenticated {
                return send_unauthorized(sink).await;
            }
            let Some((_, bridge)) = bridge.as_ref() else {
                return Ok(());
            };
            let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(data.as_bytes())
            else {
                return Ok(());
            };
            bridge.send(BridgeInput::Data(bytes));
            Ok(())
        }

        ClientMessage::Resize { cols, rows } => {
            if !*authenticated {
                return send_unauthorized(sink).await;
            }
            let Some((_, bridge)) = bridge.as_ref() else {
                return Ok(());
            };
            let cols = cols.clamp(MIN_COLS, MAX_COLS);
            let rows = rows.clamp(MIN_ROWS, MAX_ROWS);
            bridge.send(BridgeInput::Resize { cols, rows });
            Ok(())
        }

        ClientMessage::SessionClose => {
            if let Some((_, bridge)) = bridge.take() {
                bridge.send(BridgeInput::Detach);
            }
            send_json_split(sink, &ServerMessage::Closed { reason: None }).await
        }
    }
}

async fn send_unauthorized(
    sink: &mut futures_util::stream::SplitSink<
        tokio_tungstenite::WebSocketStream<TcpStream>,
        Message,
    >,
) -> std::io::Result<()> {
    send_json_split(
        sink,
        &ServerMessage::Error {
            message: "not authenticated".to_string(),
        },
    )
    .await
}

/// Reads the session list from the same source `herdr session list` uses.
fn list_sessions() -> Vec<SessionSummary> {
    match crate::session::list_sessions() {
        Ok(sessions) => sessions
            .into_iter()
            .map(|session| SessionSummary {
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

/// Ensures the target session's server is running, then attaches to it.
async fn attach_to_session(
    name: &str,
    cols: u16,
    rows: u16,
    events: tokio::sync::mpsc::UnboundedSender<BridgeEvent>,
) -> std::io::Result<Bridge> {
    let normalized = if name == crate::session::DEFAULT_SESSION_NAME {
        None
    } else {
        Some(name)
    };

    let api_socket = crate::session::api_socket_path_for(normalized);
    let client_socket = crate::session::client_socket_path_for(normalized);

    if !is_socket_listening(&client_socket) {
        spawn_session_server(normalized, &api_socket, &client_socket)?;
    }

    let socket = client_socket.clone();
    tokio::task::spawn_blocking(move || bridge::attach(socket, cols, rows, events))
        .await
        .map_err(std::io::Error::other)?
}

fn is_socket_listening(path: &Path) -> bool {
    if !path.exists() {
        return false;
    }
    crate::ipc::connect_local_stream(path).is_ok()
}

/// Starts `herdr server` for a specific session as a detached daemon.
fn spawn_session_server(
    name: Option<&str>,
    api_socket: &Path,
    client_socket: &Path,
) -> std::io::Result<()> {
    let exe = std::env::current_exe()?;

    let mut command = std::process::Command::new(exe);
    command
        .arg("server")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());

    match name {
        Some(name) => {
            // The named session is selected through the session env var, which
            // is what `herdr --session <name>` uses internally.
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
    let _ = api_socket;

    command.spawn().map_err(|err| {
        std::io::Error::new(err.kind(), format!("failed to start session server: {err}"))
    })?;

    // Wait for the client socket to accept connections before attaching.
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while std::time::Instant::now() < deadline {
        if is_socket_listening(client_socket) {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(50));
    }

    Err(std::io::Error::new(
        std::io::ErrorKind::TimedOut,
        "timed out waiting for session server to start",
    ))
}

async fn send_json_split(
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
        allowed_origins: config.web.allowed_origins.clone(),
        key,
    })
}

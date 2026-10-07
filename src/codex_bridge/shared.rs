//! A connection to Codex's managed daemon, never ownership of that daemon.
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use std::{io, process::Stdio, time::Duration};
use tokio::{process::Command, sync::mpsc, task::JoinHandle};
use tokio_tungstenite::tungstenite::Message;

pub(super) struct Shared {
    // Dropping a pane closes only its connection, not the shared app-server.
    pump: JoinHandle<io::Result<()>>,
}

impl Drop for Shared {
    fn drop(&mut self) {
        self.pump.abort();
    }
}

pub(super) struct Connection {
    pub owner: Shared,
    pub receive: mpsc::UnboundedReceiver<Value>,
    pub send: mpsc::UnboundedSender<Value>,
}

pub(super) async fn daemon_socket() -> io::Result<String> {
    let mut command = Command::new("codex");
    command.args(["app-server", "daemon", "start"]);
    // A daemon can outlive every pane. Never give its hooks pane-local identity.
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("HERDR_") || key == "CODEX_THREAD_ID" {
            command.env_remove(key);
        }
    }
    let output = tokio::time::timeout(
        Duration::from_secs(60),
        command.kill_on_drop(true).stdin(Stdio::null()).output(),
    )
    .await
    .map_err(|_| io::Error::other("Timed out starting the shared Codex daemon"))??;
    if !output.status.success() {
        return Err(io::Error::other(format!(
            "Cannot start the shared Codex daemon: {}",
            String::from_utf8_lossy(&output.stderr)
        )));
    }
    let status: Value = serde_json::from_slice(&output.stdout)?;
    status["socketPath"]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| io::Error::other("Codex daemon did not report its socket path"))
}

pub(super) async fn connect() -> io::Result<Connection> {
    let path = daemon_socket().await?;
    let stream = crate::platform::connect_shared_codex(&path).await?;
    // Connect directly: no per-pane proxy process or app-server is needed.
    let (socket, _) = tokio::time::timeout(
        Duration::from_secs(5),
        tokio_tungstenite::client_async("ws://localhost/rpc", stream),
    )
    .await
    .map_err(|_| io::Error::other("Codex daemon handshake timed out"))?
    .map_err(io::Error::other)?;
    let (send, outbound) = mpsc::unbounded_channel();
    let (inbound, receive) = mpsc::unbounded_channel();
    let pump = tokio::spawn(async move {
        let result = pump(socket, outbound, inbound).await;
        if let Err(error) = &result {
            eprintln!("Codex shared connection failed: {error}");
        }
        result
    });
    Ok(Connection {
        owner: Shared { pump },
        receive,
        send,
    })
}

async fn pump<S>(
    mut socket: tokio_tungstenite::WebSocketStream<S>,
    mut outbound: mpsc::UnboundedReceiver<Value>,
    inbound: mpsc::UnboundedSender<Value>,
) -> io::Result<()>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let mut resumes = super::shared_resume::ResumeGuard::default();
    loop {
        tokio::select! {
            message = outbound.recv() => match message {
                Some(mut message) => {
                    preserve_pane_environment(&mut message)?;
                    let message = resumes.prepare(message);
                    socket.send(Message::Text(message.to_string().into())).await.map_err(io::Error::other)?;
                }
                None => return Ok(()),
            },
            message = socket.next() => match message {
                Some(Ok(Message::Text(text))) => {
                    let message = serde_json::from_str(&text)?;
                    if let Some((forward, reply)) = resumes.resolve(&message) {
                        if forward {
                            socket.send(Message::Text(reply.to_string().into())).await.map_err(io::Error::other)?;
                        } else {
                            inbound.send(reply).map_err(io::Error::other)?;
                        }
                    } else {
                        inbound.send(message).map_err(io::Error::other)?;
                    }
                }
                Some(Ok(Message::Ping(data))) => socket.send(Message::Pong(data)).await.map_err(io::Error::other)?,
                Some(Ok(Message::Close(_))) | None => return Ok(()),
                Some(Err(error)) => return Err(io::Error::other(error)),
                _ => {}
            }
        }
    }
}

fn preserve_pane_environment(message: &mut Value) -> io::Result<()> {
    if !matches!(
        message["method"].as_str(),
        Some("thread/start" | "thread/resume" | "thread/fork")
    ) {
        return Ok(());
    }
    let config = &mut message["params"]["config"];
    if config.is_null() {
        *config = serde_json::json!({});
    }
    let policy = &mut config["shell_environment_policy"];
    if policy.is_null() {
        *policy = serde_json::json!({});
    }
    let environment = &mut policy["set"];
    if environment.is_null() {
        *environment = serde_json::json!({});
    }
    let environment = environment
        .as_object_mut()
        .ok_or_else(|| io::Error::other("Invalid Codex shell environment configuration"))?;
    // Tool commands still need their pane identity; hooks deliberately do not
    // inherit it from the shared daemon. The protocol bridge owns hook reports.
    for (key, value) in std::env::vars() {
        if key.starts_with("HERDR_") && key != "HERDR_CODEX_BRIDGE_TOKEN" {
            environment.insert(key, Value::String(value));
        }
    }
    Ok(())
}

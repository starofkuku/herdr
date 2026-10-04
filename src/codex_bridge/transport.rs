use super::{pane::Pane, session::Session};
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use std::io::{self, BufRead, BufReader, Write};
use std::process::{Child, ChildStdin};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::{
    handshake::server::{ErrorResponse, Request, Response},
    Message,
};

pub(super) fn read(child: &mut Child) -> io::Result<mpsc::UnboundedReceiver<Value>> {
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| io::Error::other("missing app-server stdout"))?;
    let (send, receive) = mpsc::unbounded_channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else {
                break;
            };
            match serde_json::from_str(&line) {
                Ok(message) => {
                    if send.send(message).is_err() {
                        break;
                    }
                }
                Err(error) => tracing::warn!(%error, "Invalid Codex protocol message"),
            }
        }
    });
    Ok(receive)
}

fn write(stdin: &mut ChildStdin, value: &Value) -> io::Result<()> {
    serde_json::to_writer(&mut *stdin, value)?;
    stdin.write_all(b"\n")?;
    stdin.flush()
}

pub(super) async fn serve(
    listener: TcpListener,
    token: String,
    mut receive: mpsc::UnboundedReceiver<Value>,
    mut stdin: ChildStdin,
    mut pane: Pane,
    mut cli: super::OwnedChild,
) -> io::Result<i32> {
    let mut tick = tokio::time::interval(std::time::Duration::from_millis(100));
    let mut session = Session::new(format!("codex:app-server:{}", super::now_ms()));
    let mut socket = accept(&listener, token, &mut cli).await?;
    loop {
        tokio::select! {
            _ = tick.tick() => if let Some(status) = cli.0.try_wait()? { return Ok(status.code().unwrap_or(1)); },
            message = receive.recv() => {
                let message = message.ok_or_else(|| io::Error::other("Codex app-server closed"))?;
                if session.server(&message) {
                    socket.send(Message::Text(message.to_string().into())).await.map_err(io::Error::other)?;
                }
            }
            message = socket.next() => {
                match message {
                    Some(Ok(Message::Text(text))) => {
                        let message: Value = serde_json::from_str(&text)?;
                        if session.client(&message) { write(&mut stdin, &message)?; }
                    }
                    Some(Ok(Message::Ping(data))) => socket.send(Message::Pong(data)).await.map_err(io::Error::other)?,
                    Some(Ok(Message::Close(_))) | None => {
                        for _ in 0..20 {
                            if let Some(status) = cli.0.try_wait()? { return Ok(status.code().unwrap_or(1)); }
                            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                        }
                        return Err(io::Error::other("Codex CLI connection closed"));
                    }
                    Some(Err(error)) => return Err(io::Error::other(error)),
                    _ => {}
                }
            }
            Some((key, answers)) = pane.answers.recv() => {
                if let Some(reply) = session.answer(&key, &answers) { write(&mut stdin, &reply)?; }
            }
        }
        session.refresh(&pane);
    }
}

struct Authenticate(String);
impl tokio_tungstenite::tungstenite::handshake::server::Callback for Authenticate {
    // Tungstenite requires this concrete HTTP response error in its Callback API.
    #[allow(clippy::result_large_err)]
    fn on_request(self, request: &Request, response: Response) -> Result<Response, ErrorResponse> {
        if request.headers().contains_key("origin")
            || request
                .headers()
                .get("authorization")
                .and_then(|v| v.to_str().ok())
                != Some(self.0.as_str())
        {
            let mut error = ErrorResponse::new(Some("Unauthorized".into()));
            *error.status_mut() = tokio_tungstenite::tungstenite::http::StatusCode::UNAUTHORIZED;
            Err(error)
        } else {
            Ok(response)
        }
    }
}

async fn accept(
    listener: &TcpListener,
    token: String,
    cli: &mut super::OwnedChild,
) -> io::Result<tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>> {
    let mut tick = tokio::time::interval(std::time::Duration::from_millis(100));
    loop {
        tokio::select! {
            _ = tick.tick() => if let Some(status) = cli.0.try_wait()? {
                return Err(io::Error::other(format!("Codex exited before connecting: {status}")));
            },
            connection = listener.accept() => {
                let (stream, _) = connection?;
                let handshake = tokio_tungstenite::accept_hdr_async(stream, Authenticate(format!("Bearer {token}")));
                match tokio::time::timeout(std::time::Duration::from_secs(2), handshake).await {
                    Ok(Ok(socket)) => return Ok(socket),
                    // This CLI runs before the server logger is initialized. Surface
                    // handshake failures on stderr; never print the request/token.
                    Ok(Err(error)) => eprintln!("Codex bridge WebSocket handshake failed: {error}"),
                    Err(_) => eprintln!("Codex bridge WebSocket handshake timed out after 2 seconds"),
                }
            }
        }
    }
}

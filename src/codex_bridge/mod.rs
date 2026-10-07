//! A single Codex connection shared by the native CLI and Herdr interactions.
mod mapping;
mod pane;
mod session;
#[cfg(target_os = "linux")]
mod shared;
#[cfg(target_os = "linux")]
mod shared_resume;
mod transport;

use serde_json::json;
use std::io;
use std::process::{Child, Command, Stdio};

/// Keep managed starts and restores on the same protocol connection path.
pub(crate) fn launch_argv(args: &[String]) -> io::Result<Vec<String>> {
    let executable = std::env::current_exe()?;
    let mut argv = vec![
        executable.to_string_lossy().into_owned(),
        "codex".into(),
        "--".into(),
    ];
    argv.extend_from_slice(args);
    Ok(argv)
}

pub(super) struct OwnedChild(Child);
impl Drop for OwnedChild {
    fn drop(&mut self) {
        for _ in 0..20 {
            if matches!(self.0.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        if !matches!(self.0.try_wait(), Ok(Some(_))) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|time| time.as_millis() as u64)
        .unwrap_or_default()
}

pub(crate) fn run(args: &[String]) -> io::Result<i32> {
    let args = args.strip_prefix(&["--".to_owned()]).unwrap_or(args);
    let pane = std::env::var("HERDR_PANE_ID")
        .map_err(|_| io::Error::other("Run herdr codex inside the intended Herdr pane"))?;
    let request = serde_json::from_value(json!({"id":"codex-bridge-start","method":"pane.get",
        "params":{"pane_id":pane}}))?;
    let response = crate::api::client::ApiClient::local()
        .request_value_with_timeout(&request, std::time::Duration::from_secs(2))
        .map_err(io::Error::other)?;
    if response.get("error").is_some() {
        return Err(io::Error::other(response.to_string()));
    }
    if crate::integration::installed_integration_statuses()
        .iter()
        .any(|status| {
            status.target == crate::api::schema::IntegrationTarget::Codex
                && status.installed_version.is_some_and(|version| version < 9)
        })
    {
        return Err(io::Error::other(
            "Update the Codex integration with this Herdr binary: herdr integration install codex",
        ));
    }
    let (server_args, cwd) = server_options(args)?;
    let args = client_options(args);
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    runtime.block_on(launch(&args, server_args, cwd, pane))
}

fn client_options(args: &[String]) -> Vec<String> {
    let mut result = Vec::new();
    let mut args = args.iter();
    while let Some(arg) = args.next() {
        if arg == "--" {
            result.push(arg.clone());
            result.extend(args.cloned());
            break;
        }
        if matches!(arg.as_str(), "-C" | "--cd") {
            args.next();
        } else if !arg.starts_with("--cd=") && !arg.starts_with("-C") {
            result.push(arg.clone());
        }
    }
    result
}

fn server_options(args: &[String]) -> io::Result<(Vec<String>, std::path::PathBuf)> {
    let mut result = Vec::new();
    let mut cwd = std::env::current_dir()?;
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        if arg == "--" {
            break;
        }
        validate_option(arg)?;
        if matches!(
            arg.as_str(),
            "-c" | "--config" | "--enable" | "--disable" | "-C" | "--cd"
        ) {
            index += 1;
            let value = args
                .get(index)
                .ok_or_else(|| io::Error::other(format!("Missing value for {arg}")))?;
            if matches!(arg.as_str(), "-C" | "--cd") {
                cwd = std::env::current_dir()?.join(value);
            } else {
                result.extend([arg.clone(), value.clone()]);
            }
        } else if ["--config=", "--enable=", "--disable="]
            .iter()
            .any(|prefix| arg.starts_with(prefix))
        {
            result.push(arg.clone());
        } else if let Some(value) = arg.strip_prefix("-c").filter(|value| !value.is_empty()) {
            result.extend(["-c".into(), value.trim_start_matches('=').into()]);
        } else if let Some(path) = arg.strip_prefix("-C").filter(|value| !value.is_empty()) {
            cwd = std::env::current_dir()?.join(path.trim_start_matches('='));
        } else if let Some(path) = arg.strip_prefix("--cd=") {
            cwd = std::env::current_dir()?.join(path);
        }
        index += 1;
    }
    Ok((result, cwd.canonicalize()?))
}

async fn launch(
    args: &[String],
    server_args: Vec<String>,
    cwd: std::path::PathBuf,
    pane_id: String,
) -> io::Result<i32> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let endpoint = format!("ws://{}/", listener.local_addr()?);
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(io::Error::other)?;
    let token: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    let upstream = connect(server_args, &cwd).await?;
    let cli = OwnedChild(
        Command::new("codex")
            .args([
                "--remote",
                &endpoint,
                "--remote-auth-token-env",
                "HERDR_CODEX_BRIDGE_TOKEN",
            ])
            .arg("-C")
            .arg(&cwd)
            .args(args)
            .env("HERDR_CODEX_BRIDGE_TOKEN", &token)
            .env("HERDR_CODEX_BRIDGE", "1")
            .env_remove("CODEX_THREAD_ID")
            .spawn()?,
    );
    transport::serve(
        listener,
        token,
        upstream.receive,
        upstream.send,
        pane::Pane::start(pane_id),
        cli,
    )
    .await
}

struct Upstream {
    receive: tokio::sync::mpsc::UnboundedReceiver<serde_json::Value>,
    send: tokio::sync::mpsc::UnboundedSender<serde_json::Value>,
    _server: Option<OwnedChild>,
    #[cfg(target_os = "linux")]
    _shared: Option<shared::Shared>,
}

async fn connect(server_args: Vec<String>, cwd: &std::path::Path) -> io::Result<Upstream> {
    // Arbitrary CLI config overrides can change process-scoped services. Keep
    // their existing isolated semantics instead of silently losing overrides.
    #[cfg(target_os = "linux")]
    if server_args.is_empty() {
        let connection = shared::connect().await?;
        return Ok(Upstream {
            receive: connection.receive,
            send: connection.send,
            _server: None,
            _shared: Some(connection.owner),
        });
    }
    eprintln!("Codex bridge: using an isolated app-server for this platform or explicit server configuration.");
    let mut server = spawn_server(server_args, cwd)?;
    let receive = transport::read(&mut server.0)?;
    let stdin = server
        .0
        .stdin
        .take()
        .ok_or_else(|| io::Error::other("Missing app-server stdin"))?;
    Ok(Upstream {
        receive,
        send: transport::writer(stdin),
        _server: Some(server),
        #[cfg(target_os = "linux")]
        _shared: None,
    })
}

/// Asks the managed app-server one question and returns its result.
///
/// The model picker needs Codex's live model list, which only the app-server can
/// answer, and it needs it from the same daemon the panes connect to: a cached
/// catalog file is the wrong answer, and on this machine provably so — the file
/// lists fourteen models and does not contain the one the account is running.
///
/// The daemon is started, and its peer verified, in the same place the bridge
/// does it, so a daemon carrying another pane's identity is refused here as well
/// rather than quietly answered.
///
/// Only Linux shares a daemon. Elsewhere each pane owns an isolated app-server
/// that the bridge holds open, and herdr has no socket of its own to ask, so the
/// refusal below is the honest answer rather than a missing implementation.
#[cfg(target_os = "linux")]
pub(crate) async fn query(
    method: &str,
    params: serde_json::Value,
) -> io::Result<serde_json::Value> {
    // Bounded as a whole: the daemon is another process, and a model list that
    // never arrives must fail the request rather than hold a pane's caller open.
    tokio::time::timeout(
        std::time::Duration::from_secs(20),
        query_inner(method, params),
    )
    .await
    .map_err(|_| io::Error::other("the Codex app-server did not answer in time"))?
}

#[cfg(target_os = "linux")]
async fn query_inner(method: &str, params: serde_json::Value) -> io::Result<serde_json::Value> {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;

    let path = shared::daemon_socket().await?;
    let stream = crate::platform::connect_shared_codex(&path).await?;
    let (mut socket, _) = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        tokio_tungstenite::client_async("ws://localhost/rpc", stream),
    )
    .await
    .map_err(|_| io::Error::other("Codex daemon handshake timed out"))?
    .map_err(io::Error::other)?;

    let request = |id: u64, method: &str, params: serde_json::Value| {
        json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}).to_string()
    };
    // Experimental methods are what the caller asked for: `thread/settings/update`
    // refuses a connection that did not declare the capability, and declaring it
    // here keeps one connection able to both read the list and apply a choice.
    let initialize = json!({
        "clientInfo": {
            "name": "herdr",
            "title": "Herdr",
            "version": env!("CARGO_PKG_VERSION"),
        },
        "capabilities": {"experimentalApi": true},
    });
    socket
        .send(Message::Text(request(1, "initialize", initialize).into()))
        .await
        .map_err(io::Error::other)?;
    socket
        .send(Message::Text(request(2, method, params).into()))
        .await
        .map_err(io::Error::other)?;

    while let Some(message) = socket.next().await {
        let Message::Text(text) = message.map_err(io::Error::other)? else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };
        // The daemon interleaves notifications meant for other clients, and those
        // carry a method but no id; only the reply to this request ends the wait.
        if value.get("id").and_then(serde_json::Value::as_u64) != Some(2) {
            continue;
        }
        if let Some(error) = value.get("error") {
            return Err(io::Error::other(error.to_string()));
        }
        return Ok(value
            .get("result")
            .cloned()
            .unwrap_or(serde_json::Value::Null));
    }
    Err(io::Error::other(
        "the Codex app-server closed the connection",
    ))
}

#[cfg(not(target_os = "linux"))]
pub(crate) async fn query(
    _method: &str,
    _params: serde_json::Value,
) -> io::Result<serde_json::Value> {
    Err(io::Error::other(
        "Codex runs its app-server per pane on this platform; the model list can only be read where the daemon is shared",
    ))
}

fn validate_option(arg: &str) -> io::Result<()> {
    if (arg.starts_with("-p") && !arg.starts_with("--"))
        || [
            "--remote",
            "--remote-auth-token-env",
            "--profile",
            "-p",
            "--oss",
            "--local-provider",
        ]
        .iter()
        .any(|flag| arg == *flag || arg.starts_with(&format!("{flag}=")))
    {
        return Err(io::Error::other(format!(
            "{arg} is not supported by herdr codex"
        )));
    }
    Ok(())
}

fn spawn_server(server_args: Vec<String>, cwd: &std::path::Path) -> io::Result<OwnedChild> {
    Ok(OwnedChild(
        Command::new("codex")
            .args(server_args)
            .args(["app-server", "--listen", "stdio://"])
            .current_dir(cwd)
            .env("HERDR_CODEX_BRIDGE", "1")
            .env_remove("CODEX_THREAD_ID")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()?,
    ))
}

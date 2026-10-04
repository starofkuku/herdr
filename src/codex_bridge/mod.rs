//! A single Codex connection shared by the native CLI and Herdr interactions.
mod mapping;
mod pane;
mod session;
mod transport;

use serde_json::json;
use std::io;
use std::process::{Child, Command, Stdio};

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
    let mut server = spawn_server(server_args, &cwd)?;
    let receive = transport::read(&mut server.0)?;
    let stdin = server
        .0
        .stdin
        .take()
        .ok_or_else(|| io::Error::other("Missing app-server stdin"))?;
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
        receive,
        stdin,
        pane::Pane::start(pane_id),
        cli,
    )
    .await
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

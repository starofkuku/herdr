//! Local gateway shutdown, independent of session servers and the blocking pool.
use std::io::{self, BufRead, Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

use interprocess::local_socket::{
    traits::Listener as _, traits::Stream as _, ListenerNonblockingMode,
};
use tokio::sync::oneshot;

use super::auth::WebKey;
use crate::ipc::{LocalStream, SocketFileIdentity};

const TIMEOUT: Duration = Duration::from_secs(2);
const MAX_REQUEST: u64 = 64 * 1024;

fn socket_path(port: u16) -> PathBuf {
    crate::config::config_dir().join(format!("herdr-web-{port}.sock"))
}

pub(super) struct Control {
    path: PathBuf,
    identity: SocketFileIdentity,
    stopped: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

impl Drop for Control {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Relaxed);
        if let Some(worker) = self.worker.take() {
            worker.thread().unpark();
            let _ = worker.join();
        }
        let _ = crate::ipc::remove_socket_file_if_owned(&self.path, &self.identity);
    }
}

pub(super) fn start(
    port: u16,
    key: WebKey,
) -> io::Result<(Control, oneshot::Receiver<LocalStream>)> {
    let path = socket_path(port);
    crate::ipc::prepare_socket_path(&path, |_| {
        format!("web control port {port} is already in use")
    })?;
    let listener = crate::ipc::bind_local_listener(&path)?;
    let mut control = Control {
        identity: crate::ipc::socket_file_identity(&path)?,
        path,
        stopped: Arc::new(AtomicBool::new(false)),
        worker: None,
    };
    crate::ipc::restrict_socket_permissions(&control.path, 0o600)?;
    listener.set_nonblocking(ListenerNonblockingMode::Accept)?;
    let stopped = control.stopped.clone();
    let (tx, rx) = oneshot::channel();
    control.worker = Some(
        std::thread::Builder::new()
            .name("web-control".into())
            .spawn(move || {
                listen(listener, key, stopped, tx);
            })?,
    );
    Ok((control, rx))
}

fn listen(
    listener: crate::ipc::LocalListener,
    key: WebKey,
    stopped: Arc<AtomicBool>,
    tx: oneshot::Sender<LocalStream>,
) {
    while !stopped.load(Ordering::Relaxed) {
        match listener.accept() {
            Ok(mut stream) => {
                if authenticate(&mut stream, &key).is_ok() {
                    let _ = tx.send(stream);
                    return;
                }
            }
            Err(err) if err.kind() == io::ErrorKind::WouldBlock => {
                std::thread::park_timeout(Duration::from_millis(100));
            }
            Err(err) => {
                tracing::error!(%err, "web control listener failed");
                return;
            }
        }
    }
}

fn authenticate(stream: &mut LocalStream, key: &WebKey) -> io::Result<()> {
    stream.set_recv_timeout(Some(TIMEOUT))?;
    let mut line = String::new();
    io::BufReader::new(stream.take(MAX_REQUEST)).read_line(&mut line)?;
    let request: serde_json::Value = serde_json::from_str(&line)?;
    if request["method"] == "web.stop"
        && request["key"]
            .as_str()
            .is_some_and(|candidate| key.verify(candidate))
    {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "invalid web stop request",
        ))
    }
}

pub(crate) fn stop(port: u16, key: &WebKey) -> io::Result<()> {
    let path = socket_path(port);
    let mut stream = crate::ipc::connect_local_stream(&path).map_err(|err| {
        io::Error::new(err.kind(), format!(
            "cannot reach web gateway control at {}: {err}; the gateway must be running a version that supports `herdr web stop`",
            path.display()
        ))
    })?;
    stream.set_recv_timeout(Some(Duration::from_secs(5)))?;
    stream.set_send_timeout(Some(TIMEOUT))?;
    let request = key.stop_request();
    if request.len() as u64 >= MAX_REQUEST {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "web key is too large for control request",
        ));
    }
    stream.write_all(request.as_bytes())?;
    stream.write_all(b"\n")?;
    let mut response = [0; 8];
    stream.read_exact(&mut response)?;
    if &response != b"stopped\n" {
        return Err(io::Error::other("unexpected web stop response"));
    }
    println!("herdr web stopped (port {port}); session servers remain running");
    Ok(())
}

pub(super) fn acknowledge(mut stream: LocalStream) -> io::Result<()> {
    stream.set_send_timeout(Some(TIMEOUT))?;
    stream.write_all(b"stopped\n")
}

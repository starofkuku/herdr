//! Bridges one browser attachment to one Herdr server client socket.
//!
//! The bridge is a real thin client: it performs the normal `Hello`/`Welcome`
//! handshake and asks for [`RenderEncoding::TerminalAnsi`], so every frame it
//! forwards is already-encoded ANSI bytes that a browser terminal can write
//! directly. It never touches the JSON API socket and never spawns a PTY.

use std::io::Write as _;
use std::path::PathBuf;

use interprocess::TryClone as _;
use tracing::{debug, warn};

use crate::ipc::LocalStream;
use crate::protocol::{
    ClientKeybindings, ClientLaunchMode, ClientMessage, RenderEncoding, ServerMessage,
    MAX_FRAME_SIZE, MAX_GRAPHICS_FRAME_SIZE, PROTOCOL_VERSION,
};

/// A frame heading to the browser.
#[derive(Debug)]
pub(crate) enum BridgeEvent {
    /// ANSI bytes for the terminal. `full` asks the client to reset first.
    Frame {
        seq: u64,
        width: u16,
        height: u16,
        full: bool,
        bytes: Vec<u8>,
    },
    /// The attachment ended. The browser should stop writing frames.
    Closed { reason: Option<String> },
    /// The server wants host mouse reporting turned on or off.
    ///
    /// Herdr's TUI is mouse-first: clicking tabs, panes, and menus arrives as
    /// terminal mouse reports. The ANSI frames do not carry the DECSET
    /// sequences, so the browser terminal must enable reporting from here.
    MouseCapture { enabled: bool },
}

/// A command heading to the server.
#[derive(Debug)]
pub(crate) enum BridgeInput {
    /// Raw terminal input bytes.
    Data(Vec<u8>),
    /// Client viewport size changed.
    Resize { cols: u16, rows: u16 },
    /// Browser wants to detach.
    Detach,
}

/// Live attachment handle. Dropping the sender ends the attachment.
pub(crate) struct Bridge {
    input_tx: tokio::sync::mpsc::UnboundedSender<BridgeInput>,
}

impl Bridge {
    /// Queues a command for the server. Returns false once the bridge is gone.
    pub(crate) fn send(&self, input: BridgeInput) -> bool {
        self.input_tx.send(input).is_ok()
    }
}

/// Connects to `socket` and starts forwarding frames into `events`.
///
/// Returns `None` when the handshake fails, in which case the caller should
/// report a connection error to the browser.
pub(crate) fn attach(
    socket: PathBuf,
    cols: u16,
    rows: u16,
    events: tokio::sync::mpsc::UnboundedSender<BridgeEvent>,
) -> std::io::Result<Bridge> {
    let mut stream = crate::ipc::connect_local_stream(&socket)?;
    crate::ipc::set_local_stream_polling(&mut stream, false)?;
    handshake(&mut stream, cols, rows)?;

    let mut read_stream = stream.try_clone()?;
    let (input_tx, mut input_rx) = tokio::sync::mpsc::unbounded_channel::<BridgeInput>();

    std::thread::spawn(move || {
        while let Some(input) = input_rx.blocking_recv() {
            let message = match input {
                BridgeInput::Data(data) => ClientMessage::Input { data },
                BridgeInput::Resize { cols, rows } => ClientMessage::Resize {
                    cols,
                    rows,
                    cell_width_px: 0,
                    cell_height_px: 0,
                },
                BridgeInput::Detach => break,
            };
            if crate::protocol::write_message(&mut stream, &message).is_err() {
                break;
            }
            let _ = stream.flush();
        }

        // The browser went away without detaching, or the caller dropped the
        // bridge. Always tell the server so it closes its side; otherwise the
        // reader thread below blocks forever on a socket nobody will close.
        let _ = crate::protocol::write_message(&mut stream, &ClientMessage::Detach);
        let _ = stream.flush();
    });

    std::thread::spawn(move || {
        loop {
            match crate::protocol::read_message::<_, ServerMessage>(
                &mut read_stream,
                MAX_GRAPHICS_FRAME_SIZE,
            ) {
                Ok(ServerMessage::Terminal(frame)) => {
                    let ended = events
                        .send(BridgeEvent::Frame {
                            seq: frame.seq,
                            width: frame.width,
                            height: frame.height,
                            full: frame.full,
                            bytes: frame.bytes,
                        })
                        .is_err();
                    if ended {
                        return;
                    }
                }
                Ok(ServerMessage::ServerShutdown { reason }) => {
                    let _ = events.send(BridgeEvent::Closed { reason });
                    return;
                }
                Ok(ServerMessage::MouseCapture { enabled }) => {
                    if events.send(BridgeEvent::MouseCapture { enabled }).is_err() {
                        return;
                    }
                }
                // Notification, clipboard, title, and graphics messages are
                // client-local presentation concerns that the browser client
                // does not implement yet. Ignore them instead of failing.
                Ok(_) => {}
                Err(err) => {
                    debug!(err = %err, "web attachment ended");
                    let _ = events.send(BridgeEvent::Closed { reason: None });
                    return;
                }
            }
        }
    });

    Ok(Bridge { input_tx })
}

fn handshake(stream: &mut LocalStream, cols: u16, rows: u16) -> std::io::Result<()> {
    let hello = ClientMessage::Hello {
        version: PROTOCOL_VERSION,
        cols,
        rows,
        cell_width_px: 0,
        cell_height_px: 0,
        requested_encoding: RenderEncoding::TerminalAnsi,
        keybindings: ClientKeybindings::Server,
        launch_mode: ClientLaunchMode::App,
        remote_session: false,
    };
    crate::protocol::write_message(stream, &hello)
        .map_err(|err| std::io::Error::other(err.to_string()))?;
    stream.flush()?;

    let welcome: ServerMessage = crate::protocol::read_message(stream, MAX_FRAME_SIZE)
        .map_err(|err| std::io::Error::other(err.to_string()))?;
    match welcome {
        ServerMessage::Welcome { error, .. } => match error {
            Some(reason) => {
                warn!(reason, "web attachment rejected by server");
                Err(std::io::Error::other(reason))
            }
            None => Ok(()),
        },
        _ => Err(std::io::Error::other("expected Welcome message")),
    }
}

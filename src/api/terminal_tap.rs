//! PTY output, handed to whoever is watching a pane.
//!
//! Herdr already reads every byte the pane's process writes — it feeds them to the
//! terminal state the TUI draws from. A client that wants to draw the terminal
//! itself (a browser running a real terminal emulator, which is what the web UI
//! does) needs those same bytes, in order and as they arrive: a screen snapshot
//! would put the cursor in the wrong place and lose every line that has scrolled
//! past.
//!
//! So this is a tap on the read path, not a store. Nothing here keeps history —
//! the terminal state on the server already has that, and a client that falls
//! behind is told to re-read the screen rather than being replayed into.
//!
//! The tap sits on the thread that reads the PTY, which means it runs for every
//! read of every pane. The common case is a pane nobody is watching, and that case
//! is made to cost one relaxed atomic load and nothing else.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender, TryRecvError, TrySendError};
use std::sync::{Mutex, OnceLock};

/// How much output one subscriber may fall behind before its tap is dropped.
///
/// A viewer that cannot keep up is not served by buffering more: the bytes are
/// stale by the time it reads them, and the buffer is the memory a runaway command
/// (`yes`) would fill. It is dropped instead, and told so, which is what lets it
/// re-read the screen and carry on from there.
const QUEUE_CHUNKS: usize = 256;

/// One poll's worth of output, in bytes.
///
/// A command that prints megabytes hands the tap megabytes of chunks. Sending them
/// as one event would make a frame nobody can parse quickly, and sending one chunk
/// per event would spend more on framing than on bytes, so a poll takes a slice of
/// what is waiting and the next poll takes the rest.
pub(crate) const MAX_DRAIN_BYTES: usize = 128 * 1024;

/// One subscriber, as the hub holds it: its id, and where to send its output.
type Subscriber = (u64, SyncSender<Vec<u8>>);

struct TerminalTapHub {
    /// One list of subscribers per pane. The key is the pane's internal id,
    /// because that is the name the thread reading the PTY knows it by.
    subscribers: Mutex<HashMap<u32, Vec<Subscriber>>>,
    /// Whether any subscriber exists anywhere, for the read path to check first.
    watching: AtomicBool,
}

fn hub() -> &'static TerminalTapHub {
    static HUB: OnceLock<TerminalTapHub> = OnceLock::new();
    HUB.get_or_init(|| TerminalTapHub {
        subscribers: Mutex::new(HashMap::new()),
        watching: AtomicBool::new(false),
    })
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    // A poisoned lock here means a subscriber panicked while holding it, which
    // says nothing about the map itself: the entries are a counter and senders.
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The next subscriber's id, so a tap can take back exactly its own entry.
fn next_tap_id() -> u64 {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

/// Whether anything at all is watching any pane.
///
/// Read first, on the hot path, so a pane with no viewer does not take a lock for
/// output nobody asked for.
pub(crate) fn watching_anything() -> bool {
    hub().watching.load(Ordering::Relaxed)
}

/// Hands one read of PTY output to every subscriber watching this pane.
pub(crate) fn broadcast(pane_raw: u32, bytes: &[u8]) {
    if !watching_anything() {
        return;
    }
    let hub = hub();
    let mut map = lock(&hub.subscribers);
    let Some(subscribers) = map.get_mut(&pane_raw) else {
        return;
    };
    subscribers.retain(|(_, sender)| match sender.try_send(bytes.to_vec()) {
        Ok(()) => true,
        // Full is a viewer that fell behind, disconnected is one that has gone
        // away. Either way there is nothing left to send it.
        Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => false,
    });
    if subscribers.is_empty() {
        map.remove(&pane_raw);
        hub.watching.store(!map.is_empty(), Ordering::Relaxed);
    }
}

/// One subscriber's end of the tap.
pub(crate) struct TerminalTap {
    pane_raw: u32,
    id: u64,
    receiver: Receiver<Vec<u8>>,
    /// Set once the hub has dropped this tap for falling behind.
    lost: bool,
}

impl TerminalTap {
    /// Starts watching one pane's output.
    pub(crate) fn subscribe(pane_raw: u32) -> Self {
        let (sender, receiver) = mpsc::sync_channel(QUEUE_CHUNKS);
        let id = next_tap_id();
        let hub = hub();
        lock(&hub.subscribers)
            .entry(pane_raw)
            .or_default()
            .push((id, sender));
        hub.watching.store(true, Ordering::Relaxed);
        Self {
            pane_raw,
            id,
            receiver,
            lost: false,
        }
    }

    /// One poll's worth of output, and whether the tap was dropped behind it.
    ///
    /// `None` for the chunks means nothing arrived, which is the ordinary case for
    /// a shell sitting at a prompt.
    pub(crate) fn drain(&mut self) -> (Option<Vec<u8>>, bool) {
        let mut out: Vec<u8> = Vec::new();
        loop {
            match self.receiver.try_recv() {
                Ok(chunk) => {
                    // A chunk that would take this poll past its budget is left for
                    // the next one, so a burst is spread over a few frames rather
                    // than arriving as a single one.
                    if !out.is_empty() && out.len() + chunk.len() > MAX_DRAIN_BYTES {
                        break;
                    }
                    out.extend_from_slice(&chunk);
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    self.lost = true;
                    break;
                }
            }
        }
        let chunks = (!out.is_empty()).then_some(out);
        let lost = self.lost;
        if lost {
            self.resubscribe();
        }
        (chunks, lost)
    }

    /// Watches the pane again, after being dropped for falling behind.
    fn resubscribe(&mut self) {
        self.lost = false;
        let (sender, receiver) = mpsc::sync_channel(QUEUE_CHUNKS);
        let id = next_tap_id();
        let hub = hub();
        lock(&hub.subscribers)
            .entry(self.pane_raw)
            .or_default()
            .push((id, sender));
        hub.watching.store(true, Ordering::Relaxed);
        self.id = id;
        self.receiver = receiver;
    }
}

impl Drop for TerminalTap {
    fn drop(&mut self) {
        let hub = hub();
        let mut map = lock(&hub.subscribers);
        if let Some(subscribers) = map.get_mut(&self.pane_raw) {
            subscribers.retain(|(id, _)| *id != self.id);
            if subscribers.is_empty() {
                map.remove(&self.pane_raw);
            }
        }
        hub.watching.store(!map.is_empty(), Ordering::Relaxed);
    }
}

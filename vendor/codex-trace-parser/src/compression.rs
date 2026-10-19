use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

// zstd frame magic: 0xFD2FB528 stored little-endian => bytes [0x28, 0xB5, 0x2F, 0xFD]
const ZSTD_MAGIC: [u8; 4] = [0x28, 0xB5, 0x2F, 0xFD];

/// Open a session file for streaming, line-by-line reads, transparently
/// decompressing zstd-compressed files.
///
/// Unlike [`read_session_file`], this never loads the whole file into memory.
/// The discovery scan only needs the first line plus a light pass over event
/// types, so streaming keeps peak memory bounded to a single line even for
/// multi-hundred-megabyte session files.
pub fn open_session_reader(path: &Path) -> Result<Box<dyn BufRead>, String> {
    let mut file = File::open(path).map_err(|e| e.to_string())?;

    // Peek the first 4 bytes to detect the zstd frame magic, then rewind.
    let mut magic = [0u8; 4];
    let read = read_up_to(&mut file, &mut magic).map_err(|e| e.to_string())?;
    file.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;

    if read == 4 && magic == ZSTD_MAGIC {
        let decoder = zstd::stream::read::Decoder::new(file).map_err(|e| format!("zstd: {e}"))?;
        Ok(Box::new(BufReader::new(decoder)))
    } else {
        Ok(Box::new(BufReader::new(file)))
    }
}

/// Fill `buf` from `reader`, tolerating short reads. Returns the number of
/// bytes actually read (which may be less than `buf.len()` at EOF).
fn read_up_to<R: Read>(reader: &mut R, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut total = 0;
    while total < buf.len() {
        match reader.read(&mut buf[total..]) {
            Ok(0) => break,
            Ok(n) => total += n,
            Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        }
    }
    Ok(total)
}

/// Resolve the actual on-disk path for a rollout session file.
///
/// Codex's background compression worker can replace a cold plain `rollout-*.jsonl`
/// file with a `rollout-*.jsonl.zst` sibling and remove the original (see
/// `codex-rs/rollout/src/compression.rs` upstream). A watcher holding the original
/// plain path would otherwise find it gone and silently stop updating. Returns
/// `None` if neither representation exists.
pub fn resolve_rollout_path(path: &Path) -> Option<PathBuf> {
    if path.exists() {
        return Some(path.to_path_buf());
    }
    let name = path.file_name()?.to_str()?;
    if !name.ends_with(".jsonl.zst") {
        let compressed = path.with_file_name(format!("{name}.zst"));
        if compressed.exists() {
            return Some(compressed);
        }
    }
    None
}

/// Read a session file that may be plain text or zstd-compressed.
/// Detects the zstd frame magic and decompresses transparently.
/// How a window is opened: by its approximate size from the end, or by the
/// approximate start it should reach back to.
pub enum WindowCut {
    /// Hold roughly this many bytes of the tail.
    Tail(u64),
    /// Start at or before this offset.
    From(u64),
}

/// A byte window of a session file that starts on a line boundary.
pub struct SessionFileWindow {
    pub content: String,
    /// Where `content` starts in the file: the byte after the newline before
    /// the cut, so every line held is complete.
    pub start: u64,
}

/// Reads the last `approx_bytes` of a session file, whole lines only.
///
/// The cut is moved *back* to the newline before it, so the line the cut
/// landed in is included whole: the window can be slightly larger than asked
/// for, and never holds a partial JSON line. A compressed stream cannot be
/// entered at an offset, so it is read whole with `start` at 0.
pub fn read_session_file_tail(path: &Path, approx_bytes: u64) -> Result<SessionFileWindow, String> {
    let metadata = fs::metadata(path).map_err(|e| e.to_string())?;
    let len = metadata.len();
    if len <= approx_bytes || path_is_zstd(path)? {
        let content = read_session_file(path)?;
        return Ok(SessionFileWindow { content, start: 0 });
    }
    let start = line_start_before(path, len - approx_bytes)?;
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    file.seek(SeekFrom::Start(start)).map_err(|e| e.to_string())?;
    let mut content = String::new();
    file.read_to_string(&mut content).map_err(|e| e.to_string())?;
    Ok(SessionFileWindow { content, start })
}

/// Reads from `approx_start` (moved back to its line start) to the end.
///
/// The same boundary rule as [`read_session_file_tail`], for widening an
/// existing window: the caller hands back the start it was given and asks for
/// the line-aligned window that begins at or before it.
pub fn read_session_file_from(path: &Path, approx_start: u64) -> Result<SessionFileWindow, String> {
    let metadata = fs::metadata(path).map_err(|e| e.to_string())?;
    let len = metadata.len();
    if approx_start == 0 || len <= approx_start || path_is_zstd(path)? {
        let content = read_session_file(path)?;
        return Ok(SessionFileWindow { content, start: 0 });
    }
    let start = line_start_before(path, approx_start)?;
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    file.seek(SeekFrom::Start(start)).map_err(|e| e.to_string())?;
    let mut content = String::new();
    file.read_to_string(&mut content).map_err(|e| e.to_string())?;
    Ok(SessionFileWindow { content, start })
}

/// Whether the file begins with the zstd frame magic.
fn path_is_zstd(path: &Path) -> Result<bool, String> {
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let mut magic = [0u8; 4];
    let read = read_up_to(&mut file, &mut magic).map_err(|e| e.to_string())?;
    Ok(read == 4 && magic == ZSTD_MAGIC)
}

/// The offset of the first byte of the line containing `offset`.
///
/// Scans backwards in blocks for the newline that opens that line; the start
/// of the file is the boundary when none precedes it.
fn line_start_before(path: &Path, offset: u64) -> Result<u64, String> {
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; 8192];
    let mut pos = offset;
    loop {
        let read_from = pos.saturating_sub(buf.len() as u64);
        file.seek(SeekFrom::Start(read_from)).map_err(|e| e.to_string())?;
        let read = file.read(&mut buf).map_err(|e| e.to_string())?;
        if read == 0 {
            return Ok(0);
        }
        for index in (0..read).rev() {
            let absolute = read_from + index as u64;
            if buf[index] == b'\n' && absolute < offset {
                return Ok(absolute + 1);
            }
        }
        if read_from == 0 {
            return Ok(0);
        }
        pos = read_from;
    }
}

pub fn read_session_file(path: &Path) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    if bytes.starts_with(&ZSTD_MAGIC) {
        let decompressed = zstd::decode_all(bytes.as_slice()).map_err(|e| format!("zstd: {e}"))?;
        String::from_utf8(decompressed).map_err(|e| format!("zstd utf-8: {e}"))
    } else {
        String::from_utf8(bytes).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn compress_zstd(data: &[u8]) -> Vec<u8> {
        zstd::encode_all(data, 3).expect("zstd compress failed")
    }

    #[test]
    fn read_plain_text_unchanged() {
        let tmp = tempdir().unwrap();
        let path = tmp.path().join("plain.jsonl");
        let content = r#"{"type":"session_meta","payload":{"id":"abc"}}"#;
        std::fs::write(&path, content).unwrap();
        let result = read_session_file(&path).unwrap();
        assert_eq!(result, content);
    }

    #[test]
    fn read_zstd_compressed_decompresses() {
        let tmp = tempdir().unwrap();
        let path = tmp.path().join("compressed.jsonl");
        let content = r#"{"type":"session_meta","payload":{"id":"compressed-session"}}"#;
        let compressed = compress_zstd(content.as_bytes());
        std::fs::write(&path, &compressed).unwrap();
        let result = read_session_file(&path).unwrap();
        assert_eq!(result, content);
    }

    #[test]
    fn read_zstd_multiline_jsonl() {
        let tmp = tempdir().unwrap();
        let path = tmp.path().join("multi.jsonl");
        let content = [
            r#"{"timestamp":"2026-06-04T00:00:00Z","type":"session_meta","payload":{"id":"zstd-session","timestamp":"2026-06-04T00:00:00Z"}}"#,
            r#"{"timestamp":"2026-06-04T00:00:01Z","type":"event_msg","payload":{"type":"task_started","turn_id":"t1"}}"#,
            r#"{"timestamp":"2026-06-04T00:00:02Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"t1","completed_at":1748995202.0}}"#,
        ]
        .join("\n");
        let compressed = compress_zstd(content.as_bytes());
        std::fs::write(&path, &compressed).unwrap();
        let result = read_session_file(&path).unwrap();
        assert_eq!(result, content);
    }

    fn read_lines_via_stream(path: &Path) -> Vec<String> {
        open_session_reader(path)
            .unwrap()
            .lines()
            .map(Result::unwrap)
            .collect()
    }

    #[test]
    fn stream_plain_text_lines() {
        let tmp = tempdir().unwrap();
        let path = tmp.path().join("plain.jsonl");
        let lines = [
            r#"{"type":"session_meta","payload":{"id":"abc"}}"#,
            r#"{"type":"event_msg","payload":{"type":"task_started"}}"#,
        ];
        std::fs::write(&path, lines.join("\n")).unwrap();
        assert_eq!(read_lines_via_stream(&path), lines.to_vec());
    }

    #[test]
    fn stream_zstd_compressed_lines() {
        let tmp = tempdir().unwrap();
        let path = tmp.path().join("compressed.jsonl");
        let lines = [
            r#"{"type":"session_meta","payload":{"id":"compressed-session"}}"#,
            r#"{"type":"event_msg","payload":{"type":"task_started"}}"#,
            r#"{"type":"event_msg","payload":{"type":"task_complete"}}"#,
        ];
        let compressed = compress_zstd(lines.join("\n").as_bytes());
        std::fs::write(&path, &compressed).unwrap();
        assert_eq!(read_lines_via_stream(&path), lines.to_vec());
    }

    #[test]
    fn stream_matches_full_read_for_crlf_and_trailing_newline() {
        // BufRead::lines strips trailing \r and the final newline, matching
        // str::lines used elsewhere. Verify both readers agree.
        let tmp = tempdir().unwrap();
        let path = tmp.path().join("crlf.jsonl");
        let raw = "{\"a\":1}\r\n{\"b\":2}\n";
        std::fs::write(&path, raw).unwrap();

        let streamed = read_lines_via_stream(&path);
        let slurped: Vec<String> = read_session_file(&path)
            .unwrap()
            .lines()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(streamed, slurped);
        assert_eq!(
            streamed,
            vec!["{\"a\":1}".to_string(), "{\"b\":2}".to_string()]
        );
    }

    #[test]
    fn stream_handles_empty_file() {
        let tmp = tempdir().unwrap();
        let path = tmp.path().join("empty.jsonl");
        std::fs::write(&path, b"").unwrap();
        assert!(read_lines_via_stream(&path).is_empty());
    }

    #[test]
    fn open_session_reader_errors_on_missing_file() {
        let tmp = tempdir().unwrap();
        let path = tmp.path().join("does-not-exist.jsonl");
        assert!(open_session_reader(&path).is_err());
    }

    #[test]
    fn resolve_rollout_path_returns_plain_path_when_it_exists() {
        let tmp = tempdir().unwrap();
        let path = tmp.path().join("rollout-plain.jsonl");
        std::fs::write(&path, "content").unwrap();
        assert_eq!(resolve_rollout_path(&path), Some(path));
    }

    #[test]
    fn resolve_rollout_path_falls_back_to_compressed_sibling() {
        // Issue #209: a watched session that goes cold can be replaced by Codex's
        // compression worker with a `.jsonl.zst` sibling, removing the plain file.
        let tmp = tempdir().unwrap();
        let plain_path = tmp.path().join("rollout-cold.jsonl");
        let compressed_path = tmp.path().join("rollout-cold.jsonl.zst");
        std::fs::write(&compressed_path, compress_zstd(b"content")).unwrap();
        assert_eq!(resolve_rollout_path(&plain_path), Some(compressed_path));
    }

    #[test]
    fn resolve_rollout_path_returns_none_when_neither_representation_exists() {
        let tmp = tempdir().unwrap();
        let path = tmp.path().join("rollout-gone.jsonl");
        assert_eq!(resolve_rollout_path(&path), None);
    }
}

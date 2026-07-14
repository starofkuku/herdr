use std::io::{self, Write as _};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminalNotificationBackend {
    Ghostty,
    Iterm2,
    Kitty,
    WezTerm,
    WindowsTerminal,
}

pub fn detect_backend() -> Option<TerminalNotificationBackend> {
    let term_program = std::env::var("TERM_PROGRAM").ok();
    let term = std::env::var("TERM").ok();

    detect_backend_from_environment(
        term_program.as_deref(),
        term.as_deref(),
        std::env::var_os("KITTY_WINDOW_ID").is_some(),
        std::env::var_os("WT_SESSION").is_some(),
    )
}

fn detect_backend_from_environment(
    term_program: Option<&str>,
    term: Option<&str>,
    kitty_window_id: bool,
    windows_terminal_session: bool,
) -> Option<TerminalNotificationBackend> {
    match term_program {
        Some("ghostty") => return Some(TerminalNotificationBackend::Ghostty),
        Some("iTerm.app") => return Some(TerminalNotificationBackend::Iterm2),
        Some("WezTerm") => return Some(TerminalNotificationBackend::WezTerm),
        _ => {}
    }

    if kitty_window_id {
        return Some(TerminalNotificationBackend::Kitty);
    }

    // Windows Terminal exports WT_SESSION to native shells and WSL profiles.
    // Check it after explicit terminal markers so nested terminal processes can
    // identify themselves instead of inheriting the outer Windows Terminal.
    if windows_terminal_session {
        return Some(TerminalNotificationBackend::WindowsTerminal);
    }

    match term.as_deref() {
        Some("xterm-ghostty") => Some(TerminalNotificationBackend::Ghostty),
        Some("xterm-kitty") => Some(TerminalNotificationBackend::Kitty),
        Some(term) if term.contains("wezterm") => Some(TerminalNotificationBackend::WezTerm),
        _ => None,
    }
}

pub fn show_notification(title: &str, body: Option<&str>) -> io::Result<bool> {
    let Some(backend) = detect_backend() else {
        return Ok(false);
    };

    let sequence = match backend {
        TerminalNotificationBackend::Ghostty
        | TerminalNotificationBackend::Iterm2
        | TerminalNotificationBackend::WezTerm => build_osc9_notification(title, body),
        TerminalNotificationBackend::Kitty => build_osc99_notification(title, body),
        TerminalNotificationBackend::WindowsTerminal => build_osc777_notification(title, body),
    };

    let sequence = if std::env::var_os("TMUX").is_some() {
        wrap_tmux_passthrough(&sequence)
    } else {
        sequence
    };

    let mut stdout = io::stdout();
    stdout.write_all(&sequence)?;
    stdout.flush()?;
    Ok(true)
}

pub fn split_message(message: &str) -> (&str, Option<&str>) {
    match message.split_once(": ") {
        Some((title, body)) if !title.is_empty() && !body.is_empty() => (title, Some(body)),
        _ => (message, None),
    }
}

fn build_osc9_notification(title: &str, body: Option<&str>) -> Vec<u8> {
    let message = sanitize_text(match body {
        Some(body) if !body.is_empty() => format!("{title}: {body}"),
        _ => title.to_string(),
    });
    format!("\x1b]9;{message}\x1b\\").into_bytes()
}

fn build_osc99_notification(title: &str, body: Option<&str>) -> Vec<u8> {
    let title = sanitize_text(title);
    match body {
        Some(body) if !body.is_empty() => {
            let body = sanitize_text(body);
            format!("\x1b]99;i=1:d=0;{title}\x1b\\\x1b]99;i=1:p=body;{body}\x1b\\").into_bytes()
        }
        _ => format!("\x1b]99;;{title}\x1b\\").into_bytes(),
    }
}

fn build_osc777_notification(title: &str, body: Option<&str>) -> Vec<u8> {
    let title = sanitize_text(title).replace(';', ":");
    let body = match body {
        Some(body) if !body.is_empty() => sanitize_text(body),
        // Windows Terminal treats an empty body as generic tab activity. A
        // blank body keeps the caller's title as the visible notification title.
        _ => " ".to_string(),
    };
    format!("\x1b]777;notify;{title};{body}\x1b\\").into_bytes()
}

fn sanitize_text(text: impl AsRef<str>) -> String {
    text.as_ref()
        .chars()
        .filter(|ch| *ch != '\u{1b}' && *ch != '\u{7}' && *ch != '\u{9c}')
        .map(|ch| match ch {
            '\n' | '\r' | '\t' => ' ',
            _ => ch,
        })
        .collect()
}

fn wrap_tmux_passthrough(sequence: &[u8]) -> Vec<u8> {
    let mut wrapped = Vec::with_capacity(sequence.len() + 16);
    wrapped.extend_from_slice(b"\x1bPtmux;");
    for &byte in sequence {
        if byte == 0x1b {
            wrapped.push(0x1b);
        }
        wrapped.push(byte);
    }
    wrapped.extend_from_slice(b"\x1b\\");
    wrapped
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_message_splits_title_and_body() {
        assert_eq!(
            split_message("agent done: ws · 1"),
            ("agent done", Some("ws · 1"))
        );
    }

    #[test]
    fn split_message_leaves_plain_message_alone() {
        assert_eq!(split_message("agent done"), ("agent done", None));
    }

    #[test]
    fn sanitize_text_strips_control_bytes() {
        assert_eq!(sanitize_text("a\n\tb\u{1b}c\u{7}"), "a  bc");
    }

    #[test]
    fn kitty_notification_uses_structured_title_and_body() {
        let sequence = String::from_utf8(build_osc99_notification("pi finished", Some("ws · 1")))
            .expect("utf8");
        assert!(sequence.contains("]99;i=1:d=0;pi finished"));
        assert!(sequence.contains("]99;i=1:p=body;ws · 1"));
    }

    #[test]
    fn windows_terminal_is_detected_from_wt_session_in_wsl_style_environment() {
        assert_eq!(
            detect_backend_from_environment(None, Some("xterm-256color"), false, true),
            Some(TerminalNotificationBackend::WindowsTerminal)
        );
    }

    #[test]
    fn explicit_terminal_marker_wins_over_inherited_wt_session() {
        assert_eq!(
            detect_backend_from_environment(Some("WezTerm"), None, false, true),
            Some(TerminalNotificationBackend::WezTerm)
        );
    }

    #[test]
    fn windows_terminal_notification_uses_osc777_title_and_body() {
        let sequence = String::from_utf8(build_osc777_notification(
            "codex finished",
            Some("api workspace; pane 2"),
        ))
        .expect("utf8");
        assert_eq!(
            sequence,
            "\x1b]777;notify;codex finished;api workspace; pane 2\x1b\\"
        );
    }

    #[test]
    fn windows_terminal_notification_sanitizes_title_delimiters() {
        let sequence = String::from_utf8(build_osc777_notification(
            "build; finished",
            Some("workspace"),
        ))
        .expect("utf8");
        assert_eq!(sequence, "\x1b]777;notify;build: finished;workspace\x1b\\");
    }

    #[test]
    fn windows_terminal_title_only_notification_keeps_title_visible() {
        let sequence =
            String::from_utf8(build_osc777_notification("build finished", None)).expect("utf8");
        assert_eq!(sequence, "\x1b]777;notify;build finished; \x1b\\");
    }

    #[test]
    fn tmux_passthrough_wraps_and_escapes() {
        let wrapped = wrap_tmux_passthrough(b"\x1b]9;hi\x1b\\");
        assert_eq!(wrapped, b"\x1bPtmux;\x1b\x1b]9;hi\x1b\x1b\\\x1b\\");
    }
}

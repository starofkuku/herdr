//! Builds codex-trace deep links from an agent's transcript path.
//!
//! codex-trace addresses a conversation as `{base}/{provider}/{session_id}`,
//! where the session id is not the file path but the identifier the agent gave
//! the session. Each agent names its transcript differently, so the id has to be
//! recovered per provider rather than from a single rule.

/// A link to one conversation in codex-trace.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionLink {
    /// One of `codex`, `claude`, `pi`; these are the providers codex-trace serves.
    pub provider: String,
    pub session_id: String,
}

impl SessionLink {
    /// The URL to open, given the configured codex-trace base.
    pub fn url(&self, base: &str) -> String {
        let base = base.trim_end_matches('/');
        format!("{base}/{}/{}", self.provider, self.session_id)
    }
}

/// Derives the codex-trace link for a transcript path.
///
/// Returns `None` when the provider is unknown or the filename does not carry a
/// usable session id, so the caller can hide the action rather than copy a link
/// that would not open anything.
pub fn session_link(agent: Option<&str>, transcript_path: &str) -> Option<SessionLink> {
    let provider = normalize_provider(agent?)?;
    let file_name = transcript_path.rsplit(['/', '\\']).next()?;
    let stem = file_name.strip_suffix(".jsonl")?;
    let session_id = session_id_for(provider, stem)?;
    Some(SessionLink {
        provider: provider.to_string(),
        session_id,
    })
}

/// Maps an agent label to the provider codex-trace uses.
fn normalize_provider(agent: &str) -> Option<&'static str> {
    let agent = agent.trim().to_ascii_lowercase();
    match agent.as_str() {
        "codex" => Some("codex"),
        "claude" => Some("claude"),
        "pi" => Some("pi"),
        _ => None,
    }
}

/// Recovers the session id from a transcript filename.
///
/// The shapes, taken from real files on disk:
/// - codex:  `rollout-2026-09-17T14-13-04-<uuid>` — the uuid is the trailing
///   five dash-separated groups.
/// - pi:     `2026-09-17T12-22-26-648Z_<uuid>` — everything after the last `_`.
/// - claude: `<uuid>` — the whole stem.
fn session_id_for(provider: &str, stem: &str) -> Option<String> {
    let candidate = match provider {
        "codex" => stem.strip_prefix("rollout-").and_then(trailing_uuid),
        "pi" => stem.rsplit_once('_').map(|(_, id)| id),
        "claude" => Some(stem),
        _ => None,
    }?;
    is_link_safe(candidate).then(|| candidate.to_string())
}

/// The trailing uuid of a `rollout-<timestamp>-<uuid>` stem.
///
/// The timestamp itself contains dashes, so the uuid is identified by shape
/// (five groups of 8-4-4-4-12) rather than by counting separators.
fn trailing_uuid(stem: &str) -> Option<&str> {
    let parts: Vec<&str> = stem.split('-').collect();
    if parts.len() < 5 {
        return None;
    }
    let tail = &parts[parts.len() - 5..];
    if matches!(
        tail.iter().map(|p| p.len()).collect::<Vec<_>>().as_slice(),
        [8, 4, 4, 4, 12]
    ) {
        // Re-slice the original so the dashes between the groups are preserved.
        let start = stem.len() - tail.iter().map(|p| p.len()).sum::<usize>() - (tail.len() - 1);
        Some(&stem[start..])
    } else {
        None
    }
}

/// Rejects ids that would not survive a round trip through a URL path segment.
///
/// Mirrors codex-trace's own validation, which accepts UUIDs and rollout ids.
fn is_link_safe(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

#[cfg(test)]
mod tests {
    use super::*;

    const CODEX: &str = "/home/u/.codex/sessions/2026/03/17/rollout-2026-03-17T23-34-58-019cfc6f-999f-7243-b137-4cce65287072.jsonl";
    const PI: &str = "/home/u/.pi/agent/sessions/--home-u-proj--/2026-09-17T01-19-29-211Z_01a0acf2-81bb-76f7-9e48-763112a909d3.jsonl";
    const CLAUDE: &str =
        "/home/u/.claude/projects/-home-u-proj/e8e2fa9d-d794-4572-8c93-e77f5969d0b6.jsonl";

    #[test]
    fn codex_rollout_uses_trailing_uuid() {
        let link = session_link(Some("codex"), CODEX).expect("link");
        assert_eq!(link.provider, "codex");
        assert_eq!(link.session_id, "019cfc6f-999f-7243-b137-4cce65287072");
    }

    #[test]
    fn pi_uses_the_segment_after_the_underscore() {
        let link = session_link(Some("pi"), PI).expect("link");
        assert_eq!(link.provider, "pi");
        assert_eq!(link.session_id, "01a0acf2-81bb-76f7-9e48-763112a909d3");
    }

    #[test]
    fn claude_uses_the_whole_stem() {
        let link = session_link(Some("claude"), CLAUDE).expect("link");
        assert_eq!(link.provider, "claude");
        assert_eq!(link.session_id, "e8e2fa9d-d794-4572-8c93-e77f5969d0b6");
    }

    #[test]
    fn url_joins_without_doubling_the_slash() {
        let link = session_link(Some("pi"), PI).expect("link");
        assert_eq!(
            link.url("http://127.0.0.1:1422/"),
            "http://127.0.0.1:1422/pi/01a0acf2-81bb-76f7-9e48-763112a909d3"
        );
        assert_eq!(
            link.url("http://127.0.0.1:1422"),
            "http://127.0.0.1:1422/pi/01a0acf2-81bb-76f7-9e48-763112a909d3"
        );
    }

    #[test]
    fn unknown_agent_has_no_link() {
        assert!(session_link(Some("amp"), PI).is_none());
        assert!(session_link(None, PI).is_none());
    }

    #[test]
    fn non_jsonl_path_has_no_link() {
        assert!(session_link(Some("pi"), "/tmp/notes.txt").is_none());
    }

    /// A claude subagent transcript is named `agent-<hex>.jsonl`; it is not a
    /// conversation codex-trace can open, so no link should be offered.
    #[test]
    fn codex_without_a_uuid_tail_has_no_link() {
        assert!(session_link(Some("codex"), "/s/rollout-2026-03-17T23-34-58.jsonl").is_none());
    }

    #[test]
    fn ids_with_path_separators_are_rejected() {
        assert!(session_link(Some("claude"), "/p/..%2f..%2fetc.jsonl").is_none());
        assert!(session_link(Some("pi"), "/p/2026_x/y.jsonl").is_none());
    }

    /// Real claude transcripts live one directory per project, and a subagent
    /// transcript sits beside them; the parent directory must not leak into the
    /// id.
    #[test]
    fn claude_ignores_parent_directories() {
        let link = session_link(
            Some("claude"),
            "/home/u/.claude/projects/-home-u-proj/e8e2fa9d-d794-4572-8c93-e77f5969d0b6.jsonl",
        )
        .expect("link");
        assert_eq!(link.session_id, "e8e2fa9d-d794-4572-8c93-e77f5969d0b6");
    }

    #[test]
    fn provider_match_is_case_insensitive() {
        assert!(session_link(Some("Claude"), CLAUDE).is_some());
        assert!(session_link(Some(" CLAUDE "), CLAUDE).is_some());
    }

    /// The menu action is only offered when a codex-trace URL is configured, an
    /// agent pane reports a readable transcript, and that path yields an id.
    #[test]
    fn menu_action_appears_only_for_a_usable_link() {
        let mut state = crate::app::state::AppState::test_new();
        let ws = crate::workspace::Workspace::test_new("test");
        let pane_id = ws.tabs[0].root_pane;
        let terminal_id = ws.tabs[0].panes[&pane_id].attached_terminal_id.clone();
        state.terminals.insert(
            terminal_id.clone(),
            crate::terminal::TerminalState::new(
                terminal_id.clone(),
                std::path::PathBuf::from("/tmp"),
            ),
        );
        state.workspaces = vec![ws];

        // No URL configured: hidden regardless of the pane.
        assert!(state.session_link_actions_for_pane(0, pane_id).is_empty());

        state.codex_trace_url = Some("http://127.0.0.1:1422".into());
        // URL set but no transcript reported yet.
        assert!(state.session_link_actions_for_pane(0, pane_id).is_empty());

        let terminal = state.terminals.get_mut(&terminal_id).expect("terminal");
        terminal.set_detected_state(
            Some(crate::detect::Agent::Pi),
            crate::detect::AgentState::Idle,
        );
        terminal
            .set_agent_session_ref(
                "herdr:pi".into(),
                "pi".into(),
                crate::agent_resume::AgentSessionRef::path(PI),
                Some(1),
            )
            .expect("session accepted");

        let actions = state.session_link_actions_for_pane(0, pane_id);
        assert_eq!(actions.len(), 1);
        assert_eq!(actions[0].label, "Copy session link");
        match &actions[0].command {
            crate::app::state::ContextMenuCommand::CopySessionLink { url } => assert_eq!(
                url,
                "http://127.0.0.1:1422/pi/01a0acf2-81bb-76f7-9e48-763112a909d3"
            ),
        }
    }
}

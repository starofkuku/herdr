use indexmap::IndexMap;
use serde_json::Value;
use std::fs;
use std::io::{BufRead, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use super::compression::{read_session_file, resolve_rollout_path};
use super::discover::CodexSessionInfo;
use super::entry::parse_timestamp_secs;
use super::provider::{chat_content_text, date_group_from_mtime, Provider};
use super::session::{CodexSession, SessionPatch, SessionRefresh, SessionStatus};
use super::toolcall::ToolKind;
use super::turn::{AgentMsg, CodexTurn, TokenInfo, TokenUsage, TurnStatus};

/// One typed content block inside a chat assistant message.
#[derive(Debug, Clone)]
pub enum ChatBlock {
    Text(String),
    Thinking(String),
    ToolUse {
        call_id: String,
        name: String,
        arguments: Value,
    },
}

/// Token usage reported for one assistant response, normalised to the
/// Codex semantics where `input` excludes cache reads.
#[derive(Debug, Clone, Copy, Default)]
pub struct ChatUsage {
    pub input_tokens: u64,
    pub cached_input_tokens: u64,
    pub output_tokens: u64,
    pub reasoning_output_tokens: u64,
}

/// How an assistant response ended, as far as the provider records it.
///
/// `ToolUse` is a continuation: the model asked for tools and the run stays
/// alive until their results come back. Every other recorded reason
/// (`end_turn`, pi's `stop`, `error`, `length`, …) means the response is
/// finished and nothing further is coming for that turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChatStop {
    ToolUse,
    Terminal,
    Aborted,
    Cancelled,
    Error,
}

/// Map a provider stop reason onto [`ChatStop`]. Providers disagree on the
/// spelling of the tool-use reason (`tool_use` vs `toolUse`), so the compare is
/// case-insensitive; an unknown reason is terminal because the only reason to
/// stay open is an explicit request for tools.
pub fn chat_stop(reason: Option<&str>) -> Option<ChatStop> {
    let reason = reason?;
    Some(
        if reason.eq_ignore_ascii_case("tool_use") || reason.eq_ignore_ascii_case("tooluse") {
            ChatStop::ToolUse
        } else if reason.eq_ignore_ascii_case("aborted") {
            ChatStop::Aborted
        } else if reason.eq_ignore_ascii_case("cancelled")
            || reason.eq_ignore_ascii_case("canceled")
        {
            ChatStop::Cancelled
        } else if reason.eq_ignore_ascii_case("error") {
            ChatStop::Error
        } else {
            ChatStop::Terminal
        },
    )
}

/// Provider-neutral events extracted from raw JSONL lines.
#[derive(Debug, Clone)]
pub enum ChatEvent {
    /// Session header: id, cwd, start timestamp, CLI version.
    Meta {
        id: String,
        cwd: Option<String>,
        timestamp: Option<String>,
        version: Option<String>,
    },
    ModelChange {
        model: String,
    },
    /// A user-authored prompt. Starts a new turn.
    User {
        text: String,
        timestamp: Option<String>,
        id: Option<String>,
    },
    /// An assistant response made of content blocks.
    Assistant {
        blocks: Vec<ChatBlock>,
        timestamp: Option<String>,
        model: Option<String>,
        usage: Option<ChatUsage>,
        /// Absent when the provider did not record a reason on this line.
        stop: Option<ChatStop>,
        error_message: Option<String>,
    },
    /// The result of a previously issued tool call. Belongs to the turn the
    /// call was made in, never starts a new turn.
    ToolResult {
        call_id: String,
        output: String,
        is_error: bool,
    },
    /// A human-readable session title (Claude Code `summary` lines).
    Title {
        text: String,
    },
    /// Lines that carry no transcript semantics (metadata, snapshots, sidechains).
    Ignored,
}

/// Per-provider translation from raw JSON lines to chat events.
pub trait ChatAdapter {
    fn provider(&self) -> Provider;
    fn adapt(&self, line: &Value) -> Vec<ChatEvent>;
}

fn opt_str_field(v: &Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Claude Code transcript lines (`~/.claude/projects/**/<uuid>.jsonl`).
///
/// Line shapes handled (fields beyond these are ignored):
/// - `{"type":"user","message":{"content": string | blocks[]},"uuid","timestamp","isSidechain"}`
///   where blocks may include `tool_result` entries returned by the model's
///   previous `tool_use` calls. A line containing only tool results continues
///   the current turn; a line with user text starts a new one.
/// - `{"type":"assistant","message":{"content": blocks[], "model","usage"},"timestamp"}`
///   with blocks `text` / `thinking` / `tool_use`.
/// - `{"type":"summary","summary": "..."}` — compaction/AI session title.
/// - Other bookkeeping types (`permission-mode`, `file-history-snapshot`,
///   `attachment`, `last-prompt`, `system`, …) are ignored.
/// - Lines with `isSidechain: true` are subagent chatter inside the parent
///   transcript; skipped (subagent transcripts live in separate files).
pub struct ClaudeAdapter;

impl ChatAdapter for ClaudeAdapter {
    fn provider(&self) -> Provider {
        Provider::Claude
    }

    fn adapt(&self, line: &Value) -> Vec<ChatEvent> {
        let line_type = line.get("type").and_then(Value::as_str).unwrap_or("");
        if line.get("isSidechain").and_then(Value::as_bool) == Some(true) {
            return vec![ChatEvent::Ignored];
        }
        match line_type {
            "summary" => {
                let text = opt_str_field(line, "summary").unwrap_or_default();
                if text.is_empty() {
                    vec![ChatEvent::Ignored]
                } else {
                    vec![ChatEvent::Title { text }]
                }
            }
            "user" => {
                let content = line
                    .get("message")
                    .and_then(|m| m.get("content"))
                    .unwrap_or(&Value::Null);
                let mut tool_results = Vec::new();
                let mut text_parts: Vec<String> = Vec::new();
                match content {
                    Value::Array(items) => {
                        for item in items {
                            match item.get("type").and_then(Value::as_str) {
                                Some("tool_result") => {
                                    tool_results.push(ChatEvent::ToolResult {
                                        call_id: item
                                            .get("tool_use_id")
                                            .and_then(Value::as_str)
                                            .unwrap_or("")
                                            .to_string(),
                                        output: chat_content_text(
                                            item.get("content").unwrap_or(&Value::Null),
                                        ),
                                        is_error: item
                                            .get("is_error")
                                            .and_then(Value::as_bool)
                                            .unwrap_or(false),
                                    });
                                }
                                Some("text") => {
                                    if let Some(text) = item.get("text").and_then(Value::as_str) {
                                        text_parts.push(text.to_string());
                                    }
                                }
                                _ => {}
                            }
                        }
                    }
                    Value::String(text) => text_parts.push(text.clone()),
                    _ => {}
                }
                // Finalise the outstanding tool calls first: they belong to the
                // current turn, while new user text starts the next one.
                let mut events = tool_results;
                // Every user line carries session identity (sessionId, cwd,
                // version); the builder keeps the first non-empty values.
                events.push(ChatEvent::Meta {
                    id: opt_str_field(line, "sessionId").unwrap_or_default(),
                    cwd: opt_str_field(line, "cwd"),
                    timestamp: opt_str_field(line, "timestamp"),
                    version: opt_str_field(line, "version"),
                });
                let text = text_parts.join("").trim().to_string();
                if !text.is_empty() {
                    events.push(ChatEvent::User {
                        text,
                        timestamp: opt_str_field(line, "timestamp"),
                        id: opt_str_field(line, "uuid"),
                    });
                }
                events
            }
            "assistant" => {
                let message = line.get("message").unwrap_or(&Value::Null);
                let mut blocks = Vec::new();
                match message.get("content") {
                    Some(Value::Array(items)) => {
                        for item in items {
                            match item.get("type").and_then(Value::as_str) {
                                Some("text") => {
                                    let text = item
                                        .get("text")
                                        .and_then(Value::as_str)
                                        .unwrap_or_default()
                                        .to_string();
                                    if !text.is_empty() {
                                        blocks.push(ChatBlock::Text(text));
                                    }
                                }
                                Some("thinking") => {
                                    let text = item
                                        .get("thinking")
                                        .and_then(Value::as_str)
                                        .or_else(|| item.get("text").and_then(Value::as_str))
                                        .unwrap_or_default()
                                        .to_string();
                                    if !text.is_empty() {
                                        blocks.push(ChatBlock::Thinking(text));
                                    }
                                }
                                Some("tool_use") => {
                                    blocks.push(ChatBlock::ToolUse {
                                        call_id: item
                                            .get("id")
                                            .and_then(Value::as_str)
                                            .unwrap_or("")
                                            .to_string(),
                                        name: item
                                            .get("name")
                                            .and_then(Value::as_str)
                                            .unwrap_or("unknown")
                                            .to_string(),
                                        arguments: item
                                            .get("input")
                                            .cloned()
                                            .unwrap_or(Value::Null),
                                    });
                                }
                                _ => {}
                            }
                        }
                    }
                    Some(Value::String(text)) if !text.is_empty() => {
                        blocks.push(ChatBlock::Text(text.clone()));
                    }
                    _ => {}
                }
                let stop = if line.get("isApiErrorMessage").and_then(Value::as_bool) == Some(true) {
                    Some(ChatStop::Error)
                } else {
                    chat_stop(message.get("stop_reason").and_then(Value::as_str))
                };
                if blocks.is_empty() && stop.is_none() {
                    return vec![ChatEvent::Ignored];
                }
                let usage = message.get("usage").and_then(|u| {
                    let input = u.get("input_tokens").and_then(Value::as_u64)?;
                    Some(ChatUsage {
                        input_tokens: input
                            + u.get("cache_creation_input_tokens")
                                .and_then(Value::as_u64)
                                .unwrap_or(0),
                        cached_input_tokens: u
                            .get("cache_read_input_tokens")
                            .and_then(Value::as_u64)
                            .unwrap_or(0),
                        output_tokens: u.get("output_tokens").and_then(Value::as_u64).unwrap_or(0),
                        reasoning_output_tokens: 0,
                    })
                });
                vec![ChatEvent::Assistant {
                    blocks,
                    timestamp: opt_str_field(line, "timestamp"),
                    model: opt_str_field(message, "model"),
                    usage,
                    stop,
                    error_message: opt_str_field(message, "errorMessage"),
                }]
            }
            _ => vec![ChatEvent::Ignored],
        }
    }
}

/// pi transcript lines (`~/.pi/agent/sessions/**/<ts>_<uuid>.jsonl`).
///
/// Line shapes handled:
/// - `{"type":"session","id","timestamp","cwd"}` — session header.
/// - `{"type":"model_change","modelId"}`.
/// - `{"type":"message","id","timestamp","message":{"role","content","usage","model"}}`
///   with roles `user` / `assistant` / `toolResult`; content is a typed block
///   array (`text` / `thinking` / `toolCall` / `image`). A `toolResult` message
///   carries `toolCallId`, `content` and `isError`.
pub struct PiAdapter;

impl ChatAdapter for PiAdapter {
    fn provider(&self) -> Provider {
        Provider::Pi
    }

    fn adapt(&self, line: &Value) -> Vec<ChatEvent> {
        match line.get("type").and_then(Value::as_str).unwrap_or("") {
            "session" => {
                let id = opt_str_field(line, "id").unwrap_or_default();
                if id.is_empty() {
                    return vec![ChatEvent::Ignored];
                }
                vec![ChatEvent::Meta {
                    id,
                    cwd: opt_str_field(line, "cwd"),
                    timestamp: opt_str_field(line, "timestamp"),
                    version: None,
                }]
            }
            "model_change" => {
                let model = opt_str_field(line, "modelId").unwrap_or_default();
                if model.is_empty() {
                    vec![ChatEvent::Ignored]
                } else {
                    vec![ChatEvent::ModelChange { model }]
                }
            }
            "message" => {
                let message = line.get("message").unwrap_or(&Value::Null);
                let timestamp = opt_str_field(line, "timestamp");
                let id = opt_str_field(line, "id");
                match message.get("role").and_then(Value::as_str).unwrap_or("") {
                    "user" => {
                        let text =
                            chat_content_text(message.get("content").unwrap_or(&Value::Null))
                                .trim()
                                .to_string();
                        if text.is_empty() {
                            vec![ChatEvent::Ignored]
                        } else {
                            vec![ChatEvent::User {
                                text,
                                timestamp,
                                id,
                            }]
                        }
                    }
                    "assistant" => {
                        let mut blocks = Vec::new();
                        if let Some(items) = message.get("content").and_then(Value::as_array) {
                            for item in items {
                                match item.get("type").and_then(Value::as_str) {
                                    Some("text") => {
                                        let text = item
                                            .get("text")
                                            .and_then(Value::as_str)
                                            .unwrap_or_default()
                                            .to_string();
                                        if !text.is_empty() {
                                            blocks.push(ChatBlock::Text(text));
                                        }
                                    }
                                    Some("thinking") => {
                                        let text = item
                                            .get("thinking")
                                            .and_then(Value::as_str)
                                            .unwrap_or_default()
                                            .to_string();
                                        if !text.is_empty() {
                                            blocks.push(ChatBlock::Thinking(text));
                                        }
                                    }
                                    Some("toolCall") => {
                                        blocks.push(ChatBlock::ToolUse {
                                            call_id: item
                                                .get("id")
                                                .and_then(Value::as_str)
                                                .unwrap_or("")
                                                .to_string(),
                                            name: item
                                                .get("name")
                                                .and_then(Value::as_str)
                                                .unwrap_or("unknown")
                                                .to_string(),
                                            arguments: item
                                                .get("arguments")
                                                .cloned()
                                                .unwrap_or(Value::Null),
                                        });
                                    }
                                    _ => {}
                                }
                            }
                        }
                        let stop = chat_stop(message.get("stopReason").and_then(Value::as_str));
                        if blocks.is_empty() && stop.is_none() {
                            return vec![ChatEvent::Ignored];
                        }
                        let usage = message.get("usage").and_then(|u| {
                            let input_total = u.get("input").and_then(Value::as_u64)?;
                            let cached = u.get("cacheRead").and_then(Value::as_u64).unwrap_or(0);
                            Some(ChatUsage {
                                input_tokens: input_total.saturating_sub(cached),
                                cached_input_tokens: cached,
                                output_tokens: u.get("output").and_then(Value::as_u64).unwrap_or(0),
                                reasoning_output_tokens: u
                                    .get("reasoning")
                                    .and_then(Value::as_u64)
                                    .unwrap_or(0),
                            })
                        });
                        vec![ChatEvent::Assistant {
                            blocks,
                            timestamp,
                            model: opt_str_field(message, "model"),
                            usage,
                            stop,
                            error_message: opt_str_field(message, "errorMessage"),
                        }]
                    }
                    "toolResult" => {
                        vec![ChatEvent::ToolResult {
                            call_id: message
                                .get("toolCallId")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_string(),
                            output: chat_content_text(
                                message.get("content").unwrap_or(&Value::Null),
                            ),
                            is_error: message
                                .get("isError")
                                .and_then(Value::as_bool)
                                .unwrap_or(false),
                        }]
                    }
                    _ => vec![ChatEvent::Ignored],
                }
            }
            _ => vec![ChatEvent::Ignored],
        }
    }
}

pub fn adapter_for(provider: Provider) -> &'static dyn ChatAdapter {
    match provider {
        Provider::Claude => &ClaudeAdapter,
        Provider::Pi => &PiAdapter,
        Provider::Codex => unreachable!("codex sessions use the native parser"),
    }
}

/// Map a provider tool name onto the shared ToolKind vocabulary so the
/// frontend renders a sensible icon and detail layout.
fn classify_tool(provider: Provider, name: &str) -> ToolKind {
    let lower = name.to_lowercase();
    match provider {
        Provider::Claude => {
            if let Some(rest) = name.strip_prefix("mcp__") {
                let _ = rest;
                return ToolKind::McpTool;
            }
            match lower.as_str() {
                "bash" | "bashoutput" | "killshell" => ToolKind::ExecCommand,
                "task" => ToolKind::SpawnAgent,
                "websearch" | "webfetch" => ToolKind::WebSearch,
                _ => ToolKind::Unknown,
            }
        }
        Provider::Pi => match lower.as_str() {
            "bash" => ToolKind::ExecCommand,
            "webfetch" | "websearch" => ToolKind::WebSearch,
            _ => ToolKind::Unknown,
        },
        Provider::Codex => ToolKind::Unknown,
    }
}

/// Split Claude Code MCP tool names (`mcp__<server>__<tool>`) into their parts.
fn mcp_parts(name: &str) -> (Option<String>, Option<String>) {
    let rest = match name.strip_prefix("mcp__") {
        Some(rest) => rest,
        None => return (None, None),
    };
    let mut parts = rest.splitn(2, "__");
    let server = parts.next().unwrap_or_default().to_string();
    let tool = parts.next().unwrap_or_default().to_string();
    (
        (!server.is_empty()).then_some(server),
        (!tool.is_empty()).then_some(tool),
    )
}

struct PendingChatCall {
    turn_index: usize,
    call_index: usize,
}

/// Builds normalised CodexTurns from chat events. Shared by full parsing and
/// the incremental watcher path; state is preserved across appended batches.
pub struct ChatSessionBuilder {
    provider: Provider,
    meta_id: String,
    cwd: Option<String>,
    start_time: Option<String>,
    version: Option<String>,
    thread_name: Option<String>,
    model: Option<String>,
    turns: Vec<CodexTurn>,
    pending: IndexMap<String, PendingChatCall>,
    /// Whether the turn currently being built is still expecting output.
    ///
    /// `pending` (outstanding tool calls) is only half the answer: a turn whose
    /// tools have all returned but that has not reported a final response yet is
    /// equally unfinished, and one where the client never recorded the tool
    /// results would look running forever. The provider's own stop reason is the
    /// authority — `ToolUse` opens the turn, anything terminal closes it.
    awaiting_response: bool,
    /// Whether any assistant line carried a stop reason. Transcripts that never
    /// record one (an older or unknown provider) fall back to counting open tool
    /// calls, so a missing signal cannot pin every turn as running.
    saw_stop: bool,
    terminal_stops: IndexMap<usize, ChatStop>,
    order_counter: usize,
    cumulative: ChatUsage,
    last_timestamp: Option<u64>,
}

impl ChatSessionBuilder {
    pub fn new(provider: Provider) -> Self {
        Self {
            provider,
            meta_id: String::new(),
            cwd: None,
            start_time: None,
            version: None,
            thread_name: None,
            model: None,
            turns: Vec::new(),
            pending: IndexMap::new(),
            awaiting_response: false,
            saw_stop: false,
            terminal_stops: IndexMap::new(),
            order_counter: 0,
            cumulative: ChatUsage::default(),
            last_timestamp: None,
        }
    }

    /// Feed one raw JSONL line.
    pub fn push_line(&mut self, line: &str) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            return;
        }
        let Ok(v) = serde_json::from_str::<Value>(trimmed) else {
            return;
        };
        for event in adapter_for(self.provider).adapt(&v) {
            self.apply(event);
        }
    }

    fn track_timestamp(&mut self, timestamp: &Option<String>) {
        if let Some(ts) = timestamp {
            self.last_timestamp = parse_timestamp_secs(ts).or(self.last_timestamp);
        }
    }

    fn apply(&mut self, event: ChatEvent) {
        match event {
            ChatEvent::Meta {
                id,
                cwd,
                timestamp,
                version,
            } => {
                if self.meta_id.is_empty() {
                    self.meta_id = id;
                }
                self.cwd = cwd.or(self.cwd.take());
                self.version = version.or(self.version.take());
                if self.start_time.is_none() {
                    self.start_time = timestamp;
                }
            }
            ChatEvent::ModelChange { model } => {
                self.model = Some(model);
            }
            ChatEvent::Title { text } => {
                self.thread_name = Some(text);
            }
            ChatEvent::User {
                text,
                timestamp,
                id,
            } => {
                self.track_timestamp(&timestamp);
                let turn_id = id.unwrap_or_else(|| format!("turn-{}", self.turns.len() + 1));
                let mut turn = CodexTurn::new(turn_id);
                turn.started_at = timestamp.as_deref().and_then(parse_timestamp_secs);
                turn.user_message = Some(text);
                turn.cwd = self.cwd.clone();
                turn.model = self.model.clone();
                self.turns.push(turn);
                // A user prompt opens a turn that is unfinished until the model
                // reports a terminal stop reason.
                self.awaiting_response = true;
            }
            ChatEvent::Assistant {
                blocks,
                timestamp,
                model,
                usage,
                stop,
                error_message,
            } => {
                self.track_timestamp(&timestamp);
                if let Some(model) = &model {
                    self.model = Some(model.clone());
                }
                let turn_index = match self.current_turn_index() {
                    Some(index) => index,
                    // Assistant output before any user line (should not happen,
                    // but must not crash or drop content).
                    None => {
                        self.turns
                            .push(CodexTurn::new(format!("turn-{}", self.turns.len() + 1)));
                        self.turns.len() - 1
                    }
                };
                if let Some(ts) = timestamp {
                    let parsed = parse_timestamp_secs(&ts);
                    let turn = &mut self.turns[turn_index];
                    if turn.started_at.is_none() {
                        turn.started_at = parsed;
                    }
                    turn.completed_at = parsed;
                }
                if let Some(model) = model {
                    self.turns[turn_index].model = Some(model);
                }
                if let Some(stop) = stop {
                    self.saw_stop = true;
                    // Only the newest turn's flag can be stale (earlier turns are
                    // closed by the next user prompt), so a late assistant line
                    // cannot resurrect an already-finished turn.
                    if turn_index == self.current_turn_index().unwrap_or(usize::MAX) {
                        self.awaiting_response = stop == ChatStop::ToolUse;
                    }
                }
                if let Some(stop) = stop {
                    if stop == ChatStop::ToolUse {
                        self.terminal_stops.shift_remove(&turn_index);
                    } else {
                        self.terminal_stops.insert(turn_index, stop);
                    }
                    let turn = &mut self.turns[turn_index];
                    if stop == ChatStop::Error {
                        turn.error = error_message;
                    } else if matches!(stop, ChatStop::Aborted | ChatStop::Cancelled) {
                        turn.aborted_reason = error_message;
                    }
                }
                for block in blocks {
                    match block {
                        ChatBlock::Text(text) => {
                            let order = self.order_counter;
                            self.order_counter += 1;
                            self.turns[turn_index].agent_messages.push(AgentMsg {
                                text,
                                phase: None,
                                timestamp: String::new(),
                                is_reasoning: false,
                                order,
                            });
                        }
                        ChatBlock::Thinking(text) => {
                            let order = self.order_counter;
                            self.order_counter += 1;
                            self.turns[turn_index].agent_messages.push(AgentMsg {
                                text,
                                phase: None,
                                timestamp: String::new(),
                                is_reasoning: true,
                                order,
                            });
                        }
                        ChatBlock::ToolUse {
                            call_id,
                            name,
                            arguments,
                        } => {
                            let order = self.order_counter;
                            self.order_counter += 1;
                            let (mcp_server, mcp_tool) = mcp_parts(&name);
                            let input_text = match &arguments {
                                Value::String(raw) => Some(raw.clone()),
                                Value::Object(_) => Some(arguments.to_string()),
                                _ => None,
                            };
                            let command =
                                if classify_tool(self.provider, &name) == ToolKind::ExecCommand {
                                    arguments
                                        .get("command")
                                        .and_then(Value::as_str)
                                        .map(|cmd| vec![cmd.to_string()])
                                } else {
                                    None
                                };
                            let call = super::toolcall::ToolCall {
                                call_id: call_id.clone(),
                                kind: classify_tool(self.provider, &name),
                                name: name.clone(),
                                arguments,
                                input_text,
                                nested_tool_calls: Vec::new(),
                                output: None,
                                exit_code: None,
                                command,
                                cwd: None,
                                duration_secs: None,
                                mcp_server,
                                mcp_tool,
                                plugin_id: None,
                                script_path: None,
                                patch_success: None,
                                patch_changes: None,
                                web_query: None,
                                web_url: None,
                                image_prompt: None,
                                image_file_path: None,
                                worker_session: None,
                                status: "running".to_string(),
                                subagent_id: None,
                                subagent_name: None,
                                output_truncated: None,
                            };
                            let call_index = self.turns[turn_index].tool_calls.len();
                            self.turns[turn_index].tool_calls.push(call);
                            self.turns[turn_index].tool_call_orders.push(order);
                            if !call_id.is_empty() {
                                self.pending.insert(
                                    call_id,
                                    PendingChatCall {
                                        turn_index,
                                        call_index,
                                    },
                                );
                            }
                        }
                    }
                }
                if let Some(usage) = usage {
                    self.cumulative.input_tokens += usage.input_tokens;
                    self.cumulative.cached_input_tokens += usage.cached_input_tokens;
                    self.cumulative.output_tokens += usage.output_tokens;
                    self.cumulative.reasoning_output_tokens += usage.reasoning_output_tokens;
                    let turn = &mut self.turns[turn_index];
                    let previous = turn.turn_tokens.take();
                    let turn_usage = merge_usage(previous.as_ref(), &usage);
                    turn.turn_tokens = Some(turn_usage);
                }
            }
            ChatEvent::ToolResult {
                call_id,
                output,
                is_error,
            } => {
                if let Some(pending) = self.pending.shift_remove(&call_id) {
                    let call = &mut self.turns[pending.turn_index].tool_calls[pending.call_index];
                    call.output = (!output.is_empty()).then_some(output);
                    call.status = if is_error { "failed" } else { "completed" }.to_string();
                    call.exit_code = is_error.then_some(1);
                }
            }
            ChatEvent::Ignored => {}
        }
    }

    fn current_turn_index(&self) -> Option<usize> {
        self.turns.len().checked_sub(1)
    }

    /// Token totals across the whole session, in the shared display shape.
    fn session_tokens(&self) -> TokenInfo {
        TokenInfo {
            input_tokens: self.cumulative.input_tokens,
            cached_input_tokens: self.cumulative.cached_input_tokens,
            output_tokens: self.cumulative.output_tokens,
            reasoning_output_tokens: self.cumulative.reasoning_output_tokens,
            total_tokens: self.cumulative.input_tokens + self.cumulative.output_tokens,
            context_window_tokens: None,
            model_context_window: 0,
        }
    }

    fn finalize_turn_statuses(&mut self, file_fresh: bool) {
        let last_index = self.turns.len().checked_sub(1);
        for (index, turn) in self.turns.iter_mut().enumerate() {
            let has_pending = self
                .pending
                .values()
                .any(|pending| pending.turn_index == index);
            // Only the last turn can still be awaiting output: every earlier one
            // was closed by the user message that started the next. Where the
            // transcript records no stop reason at all, the open tool calls are
            // all there is to go on, so an unknown provider is not left running.
            let await_signal = if self.saw_stop {
                self.awaiting_response
            } else {
                has_pending
            };
            let unfinished = has_pending || (Some(index) == last_index && await_signal);
            turn.status = if let Some(stop) = self.terminal_stops.get(&index) {
                match stop {
                    ChatStop::Aborted => TurnStatus::Aborted,
                    ChatStop::Cancelled => TurnStatus::Cancelled,
                    ChatStop::Error => TurnStatus::Error,
                    ChatStop::Terminal => TurnStatus::Complete,
                    ChatStop::ToolUse => unreachable!("only terminal stops are stored"),
                }
            } else if unfinished {
                if Some(index) == last_index && !file_fresh {
                    // The writer stopped mid-turn long ago; the run was cut off.
                    TurnStatus::Aborted
                } else {
                    TurnStatus::Ongoing
                }
            } else {
                TurnStatus::Complete
            };
            if turn.completed_at.is_none() && matches!(turn.status, TurnStatus::Complete) {
                turn.completed_at = turn.started_at;
            }
            if let Some(started) = turn.started_at {
                if let Some(completed) = turn.completed_at {
                    turn.duration_ms = Some(completed.saturating_sub(started) * 1000);
                }
            }
            // Recomputed every time rather than only when empty. Chat transcripts stream prose
            // between tool calls, so the block that closes the turn does not exist yet when the
            // turn first appears; an `is_none()` guard froze the value at whatever prose happened
            // to be last at that moment, and every later block — including the actual conclusion
            // — was ignored. The transcript then previewed a mid-turn status line while the
            // detail view (which walks `agent_messages` directly) showed the full answer.
            turn.final_answer = turn
                .agent_messages
                .iter()
                .rev()
                .find(|message| !message.is_reasoning)
                .map(|message| message.text.clone());
        }
    }

    /// Build the session snapshot. `file_fresh` mirrors the Codex heuristic:
    /// files modified within the last minute may still be receiving turns.
    pub fn finish(&mut self, path: &Path, file_fresh: bool) -> CodexSession {
        self.finalize_turn_statuses(file_fresh);
        let total_tokens = self.session_tokens();
        let last_turn_tokens = self
            .turns
            .last()
            .and_then(|turn| turn.total_tokens.clone())
            .unwrap_or_else(|| total_tokens.clone());
        if let Some(last) = self.turns.last_mut() {
            last.total_tokens = Some(last_turn_tokens.clone());
        }
        let is_ongoing = matches!(
            self.turns.last().map(|t| t.status.clone()),
            Some(TurnStatus::Ongoing)
        ) && file_fresh;
        CodexSession {
            id: self.meta_id.clone(),
            timestamp: self.start_time.clone().unwrap_or_default(),
            cwd: self.cwd.clone(),
            originator: None,
            cli_version: self.version.clone(),
            model_provider: None,
            git: None,
            instructions: None,
            // A snapshot, not a move: the builder retains its state so
            // subsequent incremental refreshes keep appending to the history.
            turns: self.turns.clone(),
            is_ongoing,
            total_tokens: Some(total_tokens),
            thread_name: self.thread_name.clone(),
            spawned_worker_ids: Vec::new(),
            path: path.to_string_lossy().to_string(),
            ai_title: None,
            is_headless: false,
            has_missing_spawn_metadata: false,
            history_base_thread_id: None,
            pagination: None,
            provider: self.provider.id().to_string(),
        }
    }
}

fn merge_usage(previous: Option<&TokenUsage>, usage: &ChatUsage) -> TokenUsage {
    let mut merged = previous.cloned().unwrap_or(TokenUsage {
        input_tokens: 0,
        cached_input_tokens: 0,
        output_tokens: 0,
        reasoning_output_tokens: 0,
        total_tokens: 0,
    });
    merged.input_tokens += usage.input_tokens;
    merged.cached_input_tokens += usage.cached_input_tokens;
    merged.output_tokens += usage.output_tokens;
    merged.reasoning_output_tokens += usage.reasoning_output_tokens;
    merged.total_tokens = merged.input_tokens + merged.output_tokens;
    merged
}

const ONGOING_THRESHOLD_SECS: u64 = 60;

pub(crate) fn file_is_fresh(path: &Path) -> bool {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .map(|modified| {
            SystemTime::now()
                .duration_since(modified)
                .map(|elapsed| elapsed.as_secs() <= ONGOING_THRESHOLD_SECS)
                .unwrap_or(true)
        })
        .unwrap_or(true)
}

/// Full parse of a chat-style session file (Claude Code / pi).
pub fn parse_chat_session(path: &Path, provider: Provider) -> Result<CodexSession, String> {
    let resolved = resolve_rollout_path(path)
        .ok_or_else(|| format!("session file does not exist: {}", path.display()))?;
    let content = read_session_file(&resolved)?;
    let mut builder = ChatSessionBuilder::new(provider);
    for line in content.lines() {
        builder.push_line(line);
    }
    let mut session = builder.finish(path, file_is_fresh(&resolved));
    // Keep the caller's path stable when a compressed sibling was resolved.
    session.path = path.to_string_lossy().to_string();
    Ok(session)
}

/// Lightweight metadata scan used by discovery. Streams the file once.
pub fn scan_chat_session(path: &Path, provider: Provider) -> Option<CodexSessionInfo> {
    let file_size_bytes = fs::metadata(path).ok()?.len();
    let file = fs::File::open(path).ok()?;
    let reader = std::io::BufReader::new(file);

    let adapter = adapter_for(provider);
    let mut id = String::new();
    let mut cwd: Option<String> = None;
    let mut version: Option<String> = None;
    let mut model: Option<String> = None;
    let mut thread_name: Option<String> = None;
    let mut start_time: Option<String> = None;
    let mut last_activity_time = String::new();
    let mut last_user_message: Option<String> = None;
    let mut turn_count: u32 = 0;
    let mut pending_calls: usize = 0;
    let mut total_tokens: u64 = 0;
    // Mirrors the builder: a prompt opens the turn, and only the provider's own
    // stop reason closes it. Without this, a session whose last line is a tool
    // result — the normal shape while the model is thinking about it — looked
    // finished, and neither Claude Code nor pi ever showed as running.
    let mut awaiting_response = false;
    // Whether any line carried a stop reason. Transcripts that never record one
    // (a provider this code does not know yet) fall back to counting open tool
    // calls, so a missing stop signal cannot pin every session as running.
    let mut saw_stop = false;

    for line in reader.lines().map_while(Result::ok) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        if let Some(timestamp) = v.get("timestamp").and_then(Value::as_str) {
            if start_time.is_none() {
                start_time = Some(timestamp.to_string());
            }
            last_activity_time = timestamp.to_string();
        }
        for event in adapter.adapt(&v) {
            match event {
                ChatEvent::Meta {
                    id: meta_id,
                    cwd: meta_cwd,
                    version: meta_version,
                    ..
                } => {
                    if id.is_empty() {
                        id = meta_id;
                    }
                    cwd = meta_cwd.or(cwd.take());
                    version = meta_version.or(version.take());
                }
                ChatEvent::ModelChange { model: m } => model = Some(m),
                ChatEvent::Title { text } => thread_name = Some(text),
                ChatEvent::User { text, .. } => {
                    turn_count += 1;
                    last_user_message = Some(text);
                    awaiting_response = true;
                }
                ChatEvent::Assistant {
                    model: m,
                    usage,
                    stop,
                    ..
                } => {
                    if let Some(m) = m {
                        model = Some(m);
                    }
                    if let Some(usage) = usage {
                        total_tokens += usage.input_tokens + usage.output_tokens;
                    }
                    if let Some(stop) = stop {
                        saw_stop = true;
                        awaiting_response = stop == ChatStop::ToolUse;
                    }
                }
                ChatEvent::ToolResult { call_id, .. } => {
                    if !call_id.is_empty() {
                        pending_calls = pending_calls.saturating_sub(1);
                    }
                }
                ChatEvent::Ignored => {}
            }
            // Assistant tool-use blocks create pending calls; the event stream
            // above does not expose them, so recount from the raw line instead.
        }
        if provider == Provider::Claude
            && v.get("type").and_then(Value::as_str) == Some("assistant")
        {
            if let Some(items) = v
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(Value::as_array)
            {
                pending_calls += items
                    .iter()
                    .filter(|item| item.get("type").and_then(Value::as_str) == Some("tool_use"))
                    .count();
            }
        }
        if provider == Provider::Pi && v.get("type").and_then(Value::as_str) == Some("message") {
            if let Some(items) = v
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(Value::as_array)
            {
                pending_calls += items
                    .iter()
                    .filter(|item| item.get("type").and_then(Value::as_str) == Some("toolCall"))
                    .count();
            }
        }
    }

    if id.is_empty() {
        // Fall back to the file stem so orphan transcripts still appear.
        id = path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or_default()
            .to_string();
    }
    if id.is_empty() {
        return None;
    }

    let file_fresh = file_is_fresh(path);
    // `pending_calls` stays as the fallback for transcripts that never record a
    // stop reason; where one is recorded, it is the authority, because a turn can
    // be unfinished with no tool call open (the model is composing its answer).
    let unfinished = if saw_stop {
        awaiting_response
    } else {
        pending_calls > 0
    };
    let is_ongoing = file_fresh && unfinished;
    let end_time = if is_ongoing {
        None
    } else {
        (!last_activity_time.is_empty()).then_some(last_activity_time.clone())
    };
    let resolved_start_time = start_time.clone().unwrap_or_default();

    Some(CodexSessionInfo {
        id,
        path: path.to_string_lossy().to_string(),
        cwd,
        git_branch: None,
        originator: None,
        model,
        cli_version: version,
        thread_name,
        last_user_message,
        turn_count,
        start_time: start_time.unwrap_or_default(),
        end_time,
        total_tokens: (total_tokens > 0).then_some(total_tokens),
        is_ongoing,
        is_external_worker: false,
        is_inline_worker: false,
        worker_nickname: None,
        worker_role: None,
        spawned_worker_ids: Vec::new(),
        date_group: date_group_from_mtime(path),
        ai_title: None,
        is_headless: false,
        is_archived: false,
        approval_mode: None,
        history_base_thread_id: None,
        last_activity_time: if last_activity_time.is_empty() {
            resolved_start_time
        } else {
            last_activity_time
        },
        file_size_bytes,
        has_session_end: false,
        provider: provider.id().to_string(),
    })
}

/// Discover chat-provider sessions under `root` (recursive), newest first.
pub fn discover_chat_sessions(
    root: &Path,
    provider: Provider,
) -> Result<Vec<CodexSessionInfo>, String> {
    let mut paths = Vec::new();
    collect_chat_files(root, provider, &mut paths);
    let mut sessions: Vec<CodexSessionInfo> = paths
        .iter()
        .filter_map(|path| scan_chat_session(path, provider))
        .collect();
    sessions.sort_by(|a, b| b.start_time.cmp(&a.start_time));
    Ok(sessions)
}

fn collect_chat_files(dir: &Path, provider: Provider, paths: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_chat_files(&path, provider, &mut *paths);
            continue;
        }
        if provider.is_session_file(&path) {
            paths.push(path);
        }
    }
}

/// A cached parser for one chat session file, mirroring the public surface of
/// the Codex `IncrementalSession`. Refresh seeks to the previous byte offset
/// and feeds only newly completed lines into the retained builder state.
pub struct ChatIncremental {
    requested_path: PathBuf,
    resolved_path: PathBuf,
    provider: Provider,
    builder: ChatSessionBuilder,
    session: CodexSession,
    byte_offset: u64,
    pending_line: String,
    source_size_bytes: u64,
    modified: Option<SystemTime>,
    file_identity: Option<(u64, u64)>,
}

#[cfg(unix)]
fn file_identity(metadata: &fs::Metadata) -> Option<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    Some((metadata.dev(), metadata.ino()))
}

#[cfg(windows)]
fn file_identity(metadata: &fs::Metadata) -> Option<(u64, u64)> {
    use std::os::windows::fs::MetadataExt;
    Some((metadata.creation_time(), 0))
}

#[cfg(not(any(unix, windows)))]
fn file_identity(_metadata: &fs::Metadata) -> Option<(u64, u64)> {
    None
}

impl ChatIncremental {
    pub fn load(path: &Path, provider: Provider) -> Result<Self, String> {
        let resolved_path = resolve_rollout_path(path)
            .ok_or_else(|| format!("session file does not exist: {}", path.display()))?;
        let content = read_session_file(&resolved_path)?;
        let mut builder = ChatSessionBuilder::new(provider);
        for line in content.lines() {
            builder.push_line(line);
        }
        let file_fresh = file_is_fresh(&resolved_path);
        let mut session = builder.finish(path, file_fresh);
        session.path = path.to_string_lossy().to_string();
        let source_size_bytes = content.len() as u64;
        let metadata = fs::metadata(&resolved_path).ok();
        let modified = metadata.as_ref().and_then(|m| m.modified().ok());
        Ok(Self {
            requested_path: path.to_path_buf(),
            resolved_path,
            provider,
            builder,
            session,
            byte_offset: source_size_bytes,
            pending_line: String::new(),
            source_size_bytes,
            modified,
            file_identity: metadata.as_ref().and_then(file_identity),
        })
    }

    pub fn session(&self) -> &CodexSession {
        &self.session
    }

    pub fn source_size_bytes(&self) -> u64 {
        self.source_size_bytes
    }

    pub fn status_snapshot(&self) -> SessionStatus {
        SessionStatus {
            path: self.session.path.clone(),
            is_ongoing: self.session.is_ongoing,
            source_size_bytes: self.source_size_bytes,
            updated_turns: Vec::new(),
            total_turns: self.session.turns.len(),
            total_tokens: self.session.total_tokens.clone(),
            thread_name: self.session.thread_name.clone(),
            spawned_worker_ids: Vec::new(),
            has_missing_spawn_metadata: false,
        }
    }

    pub fn status_reconciliation(
        &mut self,
        _known_source_size_bytes: Option<u64>,
    ) -> Result<SessionStatus, String> {
        let refresh = self.refresh()?;
        let mut status = self.status_snapshot();
        status.updated_turns = match refresh {
            SessionRefresh::Unchanged => Vec::new(),
            SessionRefresh::Full { session, .. } => session.turns,
            SessionRefresh::Patch(patch) => patch.updated_turns,
        };
        Ok(status)
    }

    pub fn refresh(&mut self) -> Result<SessionRefresh, String> {
        let Some(resolved_path) = resolve_rollout_path(&self.requested_path) else {
            return Err(format!(
                "session file does not exist: {}",
                self.requested_path.display()
            ));
        };
        let metadata = fs::metadata(&resolved_path).map_err(|e| e.to_string())?;
        let modified = metadata.modified().ok();
        let identity = file_identity(&metadata);
        let identity_changed = self
            .file_identity
            .zip(identity)
            .map(|(previous, current)| previous != current)
            .unwrap_or(false);

        if resolved_path != self.resolved_path
            || identity_changed
            || metadata.len() < self.byte_offset
        {
            return self.reload();
        }
        if metadata.len() == self.byte_offset && modified == self.modified {
            return Ok(SessionRefresh::Unchanged);
        }

        let old_session = self.session.clone();
        let mut file = fs::File::open(&resolved_path).map_err(|e| e.to_string())?;
        file.seek(SeekFrom::Start(self.byte_offset))
            .map_err(|e| e.to_string())?;
        let mut reader = std::io::BufReader::new(file);
        let mut appended = String::new();
        reader
            .read_to_string(&mut appended)
            .map_err(|e| e.to_string())?;
        self.byte_offset = metadata.len();
        self.source_size_bytes = metadata.len();
        self.modified = modified;
        self.file_identity = identity;

        let combined = if self.pending_line.is_empty() {
            appended
        } else {
            let mut value = std::mem::take(&mut self.pending_line);
            value.push_str(&appended);
            value
        };
        let has_trailing_newline = combined.ends_with('\n');
        let mut lines: Vec<&str> = combined.split('\n').collect();
        let final_line = if has_trailing_newline {
            lines.pop();
            None
        } else {
            lines.pop()
        };

        for line in lines {
            self.builder.push_line(line);
        }
        if let Some(line) = final_line {
            // A line without its trailing newline may still be incomplete; only
            // accept it when it parses as complete JSON.
            if serde_json::from_str::<Value>(line).is_ok() {
                self.builder.push_line(line);
            } else {
                self.pending_line = line.to_string();
            }
        }

        let file_fresh = modified
            .and_then(|modified| SystemTime::now().duration_since(modified).ok())
            .map(|elapsed| elapsed.as_secs() <= ONGOING_THRESHOLD_SECS)
            .unwrap_or(true);
        let mut session = self.builder.finish(&self.requested_path, file_fresh);
        session.path = self.session.path.clone();
        let changed_turns = changed_turns(&old_session.turns, &session.turns);
        let unchanged = changed_turns.is_empty()
            && old_session.is_ongoing == session.is_ongoing
            && serde_json::to_vec(&old_session.total_tokens).ok()
                == serde_json::to_vec(&session.total_tokens).ok()
            && old_session.thread_name == session.thread_name;
        self.session = session;
        if unchanged {
            return Ok(SessionRefresh::Unchanged);
        }
        Ok(SessionRefresh::Patch(SessionPatch {
            path: self.session.path.clone(),
            updated_turns: changed_turns,
            total_turns: self.session.turns.len(),
            is_ongoing: self.session.is_ongoing,
            total_tokens: self.session.total_tokens.clone(),
            thread_name: self.session.thread_name.clone(),
            spawned_worker_ids: Vec::new(),
            has_missing_spawn_metadata: false,
            source_size_bytes: self.source_size_bytes,
        }))
    }

    fn reload(&mut self) -> Result<SessionRefresh, String> {
        let replacement = Self::load(&self.requested_path, self.provider)?;
        let session = replacement.session.clone();
        let source_size_bytes = replacement.source_size_bytes;
        *self = replacement;
        Ok(SessionRefresh::Full {
            session: Box::new(session),
            source_size_bytes,
        })
    }
}

fn changed_turns(previous: &[CodexTurn], current: &[CodexTurn]) -> Vec<CodexTurn> {
    let mut previous_by_id: std::collections::HashMap<&str, &CodexTurn> = previous
        .iter()
        .map(|turn| (turn.turn_id.as_str(), turn))
        .collect();
    current
        .iter()
        .filter(|turn| {
            previous_by_id
                .remove(turn.turn_id.as_str())
                .map(|old| serde_json::to_vec(old).ok() != serde_json::to_vec(turn).ok())
                .unwrap_or(true)
        })
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const CLAUDE_SESSION: &str = r#"{"type":"permission-mode","permissionMode":"default","sessionId":"29433de8"}
{"type":"summary","summary":"Fix the login bug"}
{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":[{"type":"text","text":"fix the login bug"}]},"uuid":"u-1","timestamp":"2026-07-11T18:05:06Z","cwd":"/repo","sessionId":"29433de8","version":"2.1.110"}
{"type":"assistant","message":{"role":"assistant","model":"claude-sonnet-4-5","content":[{"type":"thinking","thinking":"Need to look at auth."},{"type":"tool_use","id":"toolu-1","name":"Bash","input":{"command":"ls src","description":"list files"}}],"usage":{"input_tokens":100,"cache_creation_input_tokens":10,"cache_read_input_tokens":50,"output_tokens":20}},"uuid":"a-1","timestamp":"2026-07-11T18:05:10Z"}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu-1","content":[{"type":"text","text":"main.rs\nlib.rs"}],"is_error":false}]},"toolUseResult":"main.rs","uuid":"u-2","timestamp":"2026-07-11T18:05:11Z"}
{"type":"assistant","message":{"role":"assistant","model":"claude-sonnet-4-5","content":[{"type":"text","text":"Found the auth module. Done."}],"usage":{"input_tokens":120,"cache_read_input_tokens":60,"output_tokens":30}},"uuid":"a-2","timestamp":"2026-07-11T18:05:20Z"}
{"isSidechain":true,"type":"user","message":{"role":"user","content":"sidechain noise"},"uuid":"u-3"}"#;

    const PI_SESSION: &str = r#"{"type":"session","version":3,"id":"019f9d06","timestamp":"2026-07-26T06:05:02.097Z","cwd":"/work/jable"}
{"type":"model_change","id":"b7521e97","parentId":null,"timestamp":"2026-07-26T06:05:02.138Z","provider":"home-wsl","modelId":"grok-4.5"}
{"type":"message","id":"m-1","parentId":"b7521e97","timestamp":"2026-07-26T06:05:16.822Z","message":{"role":"user","content":[{"type":"text","text":"list the files"}]}}
{"type":"message","id":"m-2","timestamp":"2026-07-26T06:05:19.895Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":"Run ls."},{"type":"toolCall","id":"call-1","name":"bash","arguments":{"command":"ls -la"}}],"usage":{"input":2136,"output":85,"cacheRead":128,"cacheWrite":0,"reasoning":19,"totalTokens":2349},"model":"grok-4.5"}}
{"type":"message","id":"m-3","timestamp":"2026-07-26T06:05:20.001Z","message":{"role":"toolResult","toolCallId":"call-1","toolName":"bash","content":[{"type":"text","text":"main.rs\nlib.rs"}],"isError":false}}
{"type":"message","id":"m-4","timestamp":"2026-07-26T06:05:25.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Two files here."}],"usage":{"input":300,"output":40,"cacheRead":0,"cacheWrite":0,"reasoning":0,"totalTokens":340},"model":"grok-4.5"}}"#;

    fn temp_session(name: &str, content: &str) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(name);
        fs::write(&path, content).unwrap();
        (dir, path)
    }

    #[test]
    fn claude_lines_produce_turns_with_tool_calls_and_tokens() {
        let mut builder = ChatSessionBuilder::new(Provider::Claude);
        for line in CLAUDE_SESSION.lines() {
            builder.push_line(line);
        }
        let session = builder.finish(Path::new("/tmp/x.jsonl"), false);
        assert_eq!(session.id, "29433de8");
        assert_eq!(session.cwd.as_deref(), Some("/repo"));
        assert_eq!(session.cli_version.as_deref(), Some("2.1.110"));
        // The sidechain line must not create a turn or message.
        assert_eq!(session.turns.len(), 1);
        let turn = &session.turns[0];
        assert_eq!(turn.user_message.as_deref(), Some("fix the login bug"));
        let reasoning: Vec<_> = turn
            .agent_messages
            .iter()
            .filter(|m| m.is_reasoning)
            .collect();
        assert_eq!(reasoning.len(), 1);
        assert_eq!(
            turn.final_answer.as_deref(),
            Some("Found the auth module. Done.")
        );
        assert_eq!(turn.tool_calls.len(), 1);
        let call = &turn.tool_calls[0];
        assert_eq!(call.kind, ToolKind::ExecCommand);
        assert_eq!(call.status, "completed");
        assert_eq!(call.output.as_deref(), Some("main.rs\nlib.rs"));
        assert_eq!(turn.tool_call_orders.len(), 1);
        // input 100+10, cached 50, output 20+30
        let tokens = session.total_tokens.as_ref().unwrap();
        assert_eq!(tokens.input_tokens, 230);
        assert_eq!(tokens.cached_input_tokens, 110);
        assert_eq!(tokens.output_tokens, 50);
        assert_eq!(tokens.total_tokens, 280);
        assert_eq!(session.thread_name.as_deref(), Some("Fix the login bug"));
    }

    #[test]
    fn pi_lines_produce_turns_with_model_and_usage() {
        let mut builder = ChatSessionBuilder::new(Provider::Pi);
        for line in PI_SESSION.lines() {
            builder.push_line(line);
        }
        let session = builder.finish(Path::new("/tmp/pi.jsonl"), false);
        assert_eq!(session.id, "019f9d06");
        assert_eq!(session.cwd.as_deref(), Some("/work/jable"));
        assert_eq!(session.model_provider, None);
        assert_eq!(session.turns.len(), 1);
        let turn = &session.turns[0];
        assert_eq!(turn.model.as_deref(), Some("grok-4.5"));
        assert_eq!(turn.tool_calls.len(), 1);
        let call = &turn.tool_calls[0];
        assert_eq!(call.kind, ToolKind::ExecCommand);
        assert_eq!(call.command.as_deref(), Some(&["ls -la".to_string()][..]));
        assert_eq!(call.status, "completed");
        assert_eq!(turn.final_answer.as_deref(), Some("Two files here."));
        // pi input includes cache reads; the parser subtracts them:
        // non-cached input = (2136 - 128) + (300 - 0) = 2308, output = 85 + 40.
        let tokens = session.total_tokens.as_ref().unwrap();
        assert_eq!(tokens.input_tokens, 2308);
        assert_eq!(tokens.cached_input_tokens, 128);
        assert_eq!(tokens.output_tokens, 125);
    }

    #[test]
    fn unfinished_tool_call_keeps_turn_ongoing_when_file_fresh() {
        let truncated = r#"{"type":"user","message":{"role":"user","content":"do it"},"uuid":"u-1","timestamp":"2026-07-11T18:05:06Z","sessionId":"s1"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu-9","name":"Bash","input":{"command":"sleep 100"}}],"usage":{"input_tokens":10,"output_tokens":5}},"uuid":"a-1","timestamp":"2026-07-11T18:05:10Z"}"#;
        let mut builder = ChatSessionBuilder::new(Provider::Claude);
        for line in truncated.lines() {
            builder.push_line(line);
        }
        let session = builder.finish(Path::new("/tmp/live.jsonl"), true);
        assert_eq!(session.turns[0].status, TurnStatus::Ongoing);
        assert!(session.is_ongoing);
        assert_eq!(session.turns[0].tool_calls[0].status, "running");
    }

    #[test]
    fn stale_ongoing_turn_is_marked_aborted() {
        let truncated = r#"{"type":"user","message":{"role":"user","content":"do it"},"uuid":"u-1","timestamp":"2026-07-11T18:05:06Z","sessionId":"s1"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu-9","name":"Bash","input":{"command":"sleep 100"}}],"usage":{"input_tokens":10,"output_tokens":5}},"uuid":"a-1","timestamp":"2026-07-11T18:05:10Z"}"#;
        let mut builder = ChatSessionBuilder::new(Provider::Claude);
        for line in truncated.lines() {
            builder.push_line(line);
        }
        let session = builder.finish(Path::new("/tmp/stale.jsonl"), false);
        assert_eq!(session.turns[0].status, TurnStatus::Aborted);
        assert!(!session.is_ongoing);
    }

    #[test]
    fn stop_reason_tool_use_keeps_the_turn_ongoing_after_its_tools_return() {
        // The shape a live Claude Code session is in most of the time: the last
        // line is a tool result, so no tool call is outstanding, yet the model
        // still has to answer. Counting open calls alone reported it finished.
        let live = r#"{"type":"user","message":{"role":"user","content":"check the tests"},"uuid":"u-1","timestamp":"2026-07-11T18:05:06Z","sessionId":"s1"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu-9","name":"Bash","input":{"command":"cargo test"}}],"stop_reason":"tool_use","usage":{"input_tokens":10,"output_tokens":5}},"uuid":"a-1","timestamp":"2026-07-11T18:05:10Z"}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu-9","content":[{"type":"text","text":"ok"}]}]},"uuid":"u-2","timestamp":"2026-07-11T18:05:11Z"}"#;
        let mut builder = ChatSessionBuilder::new(Provider::Claude);
        for line in live.lines() {
            builder.push_line(line);
        }
        let session = builder.finish(Path::new("/tmp/live.jsonl"), true);
        assert_eq!(session.turns[0].status, TurnStatus::Ongoing);
        assert!(session.is_ongoing);
    }

    #[test]
    fn stop_reason_end_turn_finishes_the_turn_even_while_the_file_is_fresh() {
        let finished = r#"{"type":"user","message":{"role":"user","content":"hi"},"uuid":"u-1","timestamp":"2026-07-11T18:05:06Z","sessionId":"s1"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hello"}],"stop_reason":"end_turn","usage":{"input_tokens":10,"output_tokens":5}},"uuid":"a-1","timestamp":"2026-07-11T18:05:10Z"}"#;
        let mut builder = ChatSessionBuilder::new(Provider::Claude);
        for line in finished.lines() {
            builder.push_line(line);
        }
        // Still freshly written, so only the stop reason can close the turn.
        let session = builder.finish(Path::new("/tmp/done.jsonl"), true);
        assert_eq!(session.turns[0].status, TurnStatus::Complete);
        assert!(!session.is_ongoing);
    }

    #[test]
    fn pi_stop_reasons_are_read_the_same_way() {
        let live = r#"{"type":"session","version":3,"id":"019f9d06","timestamp":"2026-07-26T06:05:02.097Z","cwd":"/work/jable"}
{"type":"message","id":"m-1","timestamp":"2026-07-26T06:05:16.822Z","message":{"role":"user","content":[{"type":"text","text":"list the files"}]}}
{"type":"message","id":"m-2","timestamp":"2026-07-26T06:05:19.895Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"call-1","name":"bash","arguments":{"command":"ls -la"}}],"stopReason":"toolUse","usage":{"input":100,"output":10}}}
{"type":"message","id":"m-3","timestamp":"2026-07-26T06:05:20.001Z","message":{"role":"toolResult","toolCallId":"call-1","toolName":"bash","content":[{"type":"text","text":"main.rs"}],"isError":false}}"#;
        let mut builder = ChatSessionBuilder::new(Provider::Pi);
        for line in live.lines() {
            builder.push_line(line);
        }
        let session = builder.finish(Path::new("/tmp/pi-live.jsonl"), true);
        assert_eq!(session.turns[0].status, TurnStatus::Ongoing);

        let ended = format!(
            "{live}\n{}",
            r#"{"type":"message","id":"m-4","timestamp":"2026-07-26T06:05:25.000Z","message":{"role":"assistant","content":[{"type":"text","text":"One file here."}],"stopReason":"stop","usage":{"input":120,"output":20}}}"#
        );
        let mut builder = ChatSessionBuilder::new(Provider::Pi);
        for line in ended.lines() {
            builder.push_line(line);
        }
        let session = builder.finish(Path::new("/tmp/pi-done.jsonl"), true);
        assert_eq!(session.turns[0].status, TurnStatus::Complete);
        assert!(!session.is_ongoing);
    }

    #[test]
    fn transcripts_without_a_stop_reason_still_fall_back_to_open_tool_calls() {
        // No line carries a stop reason, so the provider is treated as unknown:
        // an open tool call keeps the turn running, a closed one does not.
        let unknown = r#"{"type":"user","message":{"role":"user","content":"do it"},"uuid":"u-1","timestamp":"2026-07-11T18:05:06Z","sessionId":"s1"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu-9","name":"Bash","input":{"command":"ls"}}],"usage":{"input_tokens":10,"output_tokens":5}},"uuid":"a-1","timestamp":"2026-07-11T18:05:10Z"}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu-9","content":[{"type":"text","text":"ok"}]}]},"uuid":"u-2","timestamp":"2026-07-11T18:05:11Z"}"#;
        let mut builder = ChatSessionBuilder::new(Provider::Claude);
        for line in unknown.lines() {
            builder.push_line(line);
        }
        let session = builder.finish(Path::new("/tmp/unknown.jsonl"), true);
        assert_eq!(session.turns[0].status, TurnStatus::Complete);
        assert!(!session.is_ongoing);
    }

    #[test]
    fn scan_marks_a_turn_ongoing_while_it_awaits_the_model() {
        // The picker and sidebar read `is_ongoing` off the scan, not the full
        // parse, so both paths have to agree about a turn waiting on the model.
        let (_dir, path) = temp_session(
            "live-claude.jsonl",
            r#"{"type":"user","message":{"role":"user","content":"hi"},"uuid":"u-1","timestamp":"2026-07-11T18:05:06Z","sessionId":"s1"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"looking"}],"stop_reason":"tool_use","usage":{"input_tokens":10,"output_tokens":5}},"uuid":"a-1","timestamp":"2026-07-11T18:05:10Z"}"#,
        );
        let info = scan_chat_session(&path, Provider::Claude).unwrap();
        assert!(info.is_ongoing);
        assert_eq!(info.end_time, None);

        let (_dir, path) = temp_session(
            "done-claude.jsonl",
            r#"{"type":"user","message":{"role":"user","content":"hi"},"uuid":"u-1","timestamp":"2026-07-11T18:05:06Z","sessionId":"s1"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hello"}],"stop_reason":"end_turn","usage":{"input_tokens":10,"output_tokens":5}},"uuid":"a-1","timestamp":"2026-07-11T18:05:10Z"}"#,
        );
        let info = scan_chat_session(&path, Provider::Claude).unwrap();
        assert!(!info.is_ongoing);
        assert_eq!(info.end_time.as_deref(), Some("2026-07-11T18:05:10Z"));
    }

    #[test]
    fn chat_stop_accepts_both_provider_spellings() {
        assert_eq!(chat_stop(Some("tool_use")), Some(ChatStop::ToolUse));
        assert_eq!(chat_stop(Some("toolUse")), Some(ChatStop::ToolUse));
        assert_eq!(chat_stop(Some("end_turn")), Some(ChatStop::Terminal));
        assert_eq!(chat_stop(Some("stop")), Some(ChatStop::Terminal));
        assert_eq!(chat_stop(Some("error")), Some(ChatStop::Error));
        // A missing reason is not a stop signal, so it must not read as terminal.
        assert_eq!(chat_stop(None), None);
    }

    #[test]
    fn parse_chat_session_reads_claude_file() {
        let (_dir, path) = temp_session("29433de8-c50c.jsonl", CLAUDE_SESSION);
        let session = parse_chat_session(&path, Provider::Claude).unwrap();
        assert_eq!(session.id, "29433de8");
        assert_eq!(session.turns.len(), 1);
        assert_eq!(session.provider, "claude");
    }

    #[test]
    fn parse_chat_session_reads_pi_file() {
        let (_dir, path) = temp_session("2026-id.jsonl", PI_SESSION);
        let session = parse_chat_session(&path, Provider::Pi).unwrap();
        assert_eq!(session.id, "019f9d06");
        assert_eq!(session.provider, "pi");
    }

    #[test]
    fn scan_chat_session_reports_discovery_metadata() {
        let (_dir, path) = temp_session("29433de8-c50c.jsonl", CLAUDE_SESSION);
        let info = scan_chat_session(&path, Provider::Claude).unwrap();
        assert_eq!(info.id, "29433de8");
        assert_eq!(info.provider, "claude");
        assert_eq!(info.turn_count, 1);
        assert_eq!(info.model.as_deref(), Some("claude-sonnet-4-5"));
        assert_eq!(info.last_user_message.as_deref(), Some("fix the login bug"));
        assert_eq!(info.total_tokens, Some(280));
        assert_eq!(info.cwd.as_deref(), Some("/repo"));
        assert_eq!(info.date_group.split('/').count(), 3);
    }

    #[test]
    fn discover_chat_sessions_scans_directory() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("s1.jsonl"), CLAUDE_SESSION).unwrap();
        let sub = dir.path().join("s1-sub");
        fs::create_dir_all(sub.join("subagents")).unwrap();
        fs::write(sub.join("subagents").join("agent-a.jsonl"), "{}\n").unwrap();
        let sessions = discover_chat_sessions(dir.path(), Provider::Claude).unwrap();
        assert_eq!(sessions.len(), 1, "subagent transcripts must be skipped");
        assert_eq!(sessions[0].id, "29433de8");
    }

    #[test]
    fn chat_incremental_refresh_appends_new_turns() {
        let (_dir, path) = temp_session("live.jsonl", CLAUDE_SESSION);
        let mut incremental = ChatIncremental::load(&path, Provider::Claude).unwrap();
        assert_eq!(incremental.session().turns.len(), 1);

        // Simulate a live append: a new user turn.
        let appended = r#"
{"type":"user","message":{"role":"user","content":"now check the tests"},"uuid":"u-4","timestamp":"2026-07-11T18:06:00Z"}"#;
        {
            use std::io::Write;
            let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
            write!(file, "{appended}").unwrap();
        }
        match incremental.refresh().unwrap() {
            SessionRefresh::Patch(patch) => {
                assert_eq!(patch.total_turns, 2);
                assert_eq!(patch.updated_turns.len(), 1);
                assert_eq!(
                    patch.updated_turns[0].user_message.as_deref(),
                    Some("now check the tests")
                );
            }
            other => panic!("expected patch, got {other:?}"),
        }
        assert_eq!(incremental.session().turns.len(), 2);
        assert_eq!(
            incremental.session().turns[1].user_message.as_deref(),
            Some("now check the tests")
        );
    }

    #[test]
    fn chat_incremental_refresh_unchanged_when_file_stable() {
        let (_dir, path) = temp_session("stable.jsonl", PI_SESSION);
        let mut incremental = ChatIncremental::load(&path, Provider::Pi).unwrap();
        assert!(matches!(
            incremental.refresh().unwrap(),
            SessionRefresh::Unchanged
        ));
    }

    #[test]
    fn chat_incremental_handles_partial_trailing_line() {
        let (_dir, path) = temp_session("partial.jsonl", PI_SESSION);
        let mut incremental = ChatIncremental::load(&path, Provider::Pi).unwrap();
        {
            use std::io::Write;
            let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
            // A truncated final line (no newline, incomplete JSON).
            write!(
                file,
                "\n{{\"type\":\"message\",\"id\":\"m-9\",\"timestamp\":\"2026-07-26T06:"
            )
            .unwrap();
        }
        let refresh = incremental.refresh().unwrap();
        // The partial line must be buffered, not parsed as a turn.
        match refresh {
            SessionRefresh::Unchanged => {}
            SessionRefresh::Patch(patch) => assert!(patch.updated_turns.is_empty()),
            other => panic!("unexpected refresh {other:?}"),
        }
        // Completing the line flushes the buffer.
        {
            use std::io::Write;
            let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
            writeln!(
                file,
                "06:30.000Z\",\"message\":{{\"role\":\"user\",\"content\":[{{\"type\":\"text\",\"text\":\"flushed\"}}]}}}}"
            )
            .unwrap();
        }
        match incremental.refresh().unwrap() {
            SessionRefresh::Patch(patch) => {
                assert_eq!(patch.updated_turns.len(), 1);
                assert_eq!(
                    patch.updated_turns[0].user_message.as_deref(),
                    Some("flushed")
                );
            }
            other => panic!("expected patch, got {other:?}"),
        }
    }

    #[test]
    fn classify_tools_across_providers() {
        assert_eq!(
            classify_tool(Provider::Claude, "Bash"),
            ToolKind::ExecCommand
        );
        assert_eq!(
            classify_tool(Provider::Claude, "Task"),
            ToolKind::SpawnAgent
        );
        assert_eq!(
            classify_tool(Provider::Claude, "WebSearch"),
            ToolKind::WebSearch
        );
        assert_eq!(classify_tool(Provider::Claude, "Read"), ToolKind::Unknown);
        let (server, tool) = mcp_parts("mcp__github__create_issue");
        assert_eq!(server.as_deref(), Some("github"));
        assert_eq!(tool.as_deref(), Some("create_issue"));
        assert_eq!(classify_tool(Provider::Pi, "bash"), ToolKind::ExecCommand);
        assert_eq!(classify_tool(Provider::Pi, "read"), ToolKind::Unknown);
    }
}

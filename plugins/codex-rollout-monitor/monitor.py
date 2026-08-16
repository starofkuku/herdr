#!/usr/bin/env python3
"""Report Codex rollout activity as Herdr pane diagnostics."""

from __future__ import annotations

import glob
import json
import os
from pathlib import Path
import re
import signal
import socket
import sys
import time
from datetime import datetime
from typing import Any


SOURCE = "herdr.codex-rollout-monitor"
DIAGNOSTIC_ID = "activity"
DEFAULTS = {
    "enabled": True,
    "silent_after_seconds": 60,
    "suspected_stalled_after_seconds": 180,
    "startup_grace_seconds": 30,
    "poll_interval_ms": 1000,
    "notify": True,
    "include_command": True,
}
CONFIG_KEYS = {
    ("monitor", "enabled"): "enabled",
    ("monitor", "silent_after_seconds"): "silent_after_seconds",
    ("monitor", "suspected_stalled_after_seconds"): "suspected_stalled_after_seconds",
    ("monitor", "startup_grace_seconds"): "startup_grace_seconds",
    ("monitor", "poll_interval_ms"): "poll_interval_ms",
    ("notification", "enabled"): "notify",
    ("diagnostic", "include_command"): "include_command",
}
RUNNING_PATTERNS = (
    re.compile(r"Process running with session ID\s+(\d+)", re.IGNORECASE),
    re.compile(r"Script running with cell ID\s+([^\s]+)", re.IGNORECASE),
)
SUBAGENT_MARKER = "subagent"
MAX_API_RESPONSE = 4 * 1024 * 1024


def parse_config(path: Path) -> dict[str, Any]:
    config = dict(DEFAULTS)
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return config
    legacy_values: dict[str, Any] = {}
    grouped_values: dict[str, Any] = {}
    section = ""
    for raw_line in lines:
        line = raw_line.split("#", 1)[0].strip()
        if not line:
            continue
        if line.startswith("[") and line.endswith("]"):
            section = line[1:-1].strip()
            continue
        if "=" not in line:
            continue
        key, value = (part.strip() for part in line.split("=", 1))
        config_key = CONFIG_KEYS.get((section, key))
        destination = grouped_values
        if config_key is None and not section and key in DEFAULTS:
            # Compatibility for configs created by unreleased test builds.
            config_key = key
            destination = legacy_values
        if config_key is None:
            continue
        default = DEFAULTS[config_key]
        if isinstance(default, bool):
            if value.lower() in ("true", "false"):
                destination[config_key] = value.lower() == "true"
            continue
        try:
            destination[config_key] = int(value)
        except ValueError:
            continue
    config.update(legacy_values)
    config.update(grouped_values)
    config["silent_after_seconds"] = max(1, int(config["silent_after_seconds"]))
    config["suspected_stalled_after_seconds"] = max(
        config["silent_after_seconds"] + 1,
        int(config["suspected_stalled_after_seconds"]),
    )
    config["startup_grace_seconds"] = max(0, int(config["startup_grace_seconds"]))
    config["poll_interval_ms"] = max(250, min(60_000, int(config["poll_interval_ms"])))
    return config


def unix_ms() -> int:
    return time.time_ns() // 1_000_000


def event_unix_ms(event: dict[str, Any], fallback: int) -> int:
    raw = event.get("timestamp")
    if not isinstance(raw, str):
        payload = event.get("payload")
        raw = payload.get("timestamp") if isinstance(payload, dict) else None
    if not isinstance(raw, str):
        return fallback
    try:
        return int(datetime.fromisoformat(raw.replace("Z", "+00:00")).timestamp() * 1000)
    except (ValueError, TypeError, OverflowError):
        return fallback


def api_request(socket_path: str, method: str, params: dict[str, Any]) -> dict[str, Any]:
    request = {
        "id": f"{SOURCE}:{time.time_ns()}",
        "method": method,
        "params": params,
    }
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    client.settimeout(1.0)
    try:
        client.connect(socket_path)
        client.sendall((json.dumps(request, separators=(",", ":")) + "\n").encode())
        response = bytearray()
        while len(response) < MAX_API_RESPONSE:
            chunk = client.recv(65536)
            if not chunk:
                break
            response.extend(chunk)
            if b"\n" in chunk:
                break
        line = bytes(response).split(b"\n", 1)[0]
        value = json.loads(line) if line else {}
        return value if isinstance(value, dict) else {}
    finally:
        client.close()


def is_subagent_source(value: Any) -> bool:
    if isinstance(value, str):
        return SUBAGENT_MARKER in value.lower()
    if isinstance(value, dict):
        return SUBAGENT_MARKER in json.dumps(value, separators=(",", ":")).lower()
    return False


def rollout_matches_session(path: Path, session_id: str) -> bool:
    try:
        with path.open("r", encoding="utf-8") as handle:
            first = json.loads(handle.readline())
    except (OSError, UnicodeError, json.JSONDecodeError):
        return False
    if not isinstance(first, dict):
        return False
    if first.get("type") != "session_meta":
        return False
    payload = first.get("payload")
    if not isinstance(payload, dict) or payload.get("id") != session_id:
        return False
    return not (
        is_subagent_source(payload.get("thread_source"))
        or is_subagent_source(payload.get("source"))
    )


def find_rollout(codex_home: Path, session_id: str) -> Path | None:
    pattern = str(codex_home / "sessions" / "*" / "*" / "*" / f"rollout-*-{session_id}.jsonl")
    candidates = sorted(
        (Path(path) for path in glob.glob(pattern)),
        key=lambda path: path.stat().st_mtime_ns if path.exists() else 0,
        reverse=True,
    )
    return next((path for path in candidates if rollout_matches_session(path, session_id)), None)


def parse_arguments(payload: dict[str, Any]) -> dict[str, Any]:
    raw = payload.get("arguments")
    if not isinstance(raw, str):
        return {}
    try:
        value = json.loads(raw)
        return value if isinstance(value, dict) else {}
    except json.JSONDecodeError:
        return {}


def running_session_from_output(output: str) -> str | None:
    for pattern in RUNNING_PATTERNS:
        match = pattern.search(output)
        if match:
            return match.group(1)
    return None


class RolloutTracker:
    def __init__(self, pane_id: str, session_id: str, path: Path, started_ms: int):
        self.pane_id = pane_id
        self.session_id = session_id
        self.path = path
        self.started_ms = started_ms
        self.offset = 0
        self.partial = b""
        self.file_identity: tuple[int, int] | None = None
        self.turn_active = False
        self.active_calls: dict[str, dict[str, Any]] = {}
        self.process_calls: dict[str, str] = {}
        self.poll_calls: dict[str, str] = {}
        self.last_activity_ms = started_ms
        self.previous_state: str | None = None
        self.episode = 0
        self.episode_id: str | None = None
        self.notified_episode_id: str | None = None
        self.last_report_ms = 0

    def read_new_events(self, now_ms: int) -> bool:
        try:
            stat = self.path.stat()
        except OSError:
            return False
        identity = (stat.st_dev, stat.st_ino)
        if self.file_identity != identity or stat.st_size < self.offset:
            self.file_identity = identity
            self.offset = 0
            self.partial = b""
            self.turn_active = False
            self.active_calls.clear()
            self.process_calls.clear()
            self.poll_calls.clear()
        try:
            with self.path.open("rb") as handle:
                handle.seek(self.offset)
                chunk = handle.read()
                self.offset = handle.tell()
        except OSError:
            return False
        if not chunk:
            return False
        data = self.partial + chunk
        lines = data.split(b"\n")
        self.partial = lines.pop()
        progressed = False
        for raw_line in lines:
            if not raw_line.strip():
                continue
            try:
                event = json.loads(raw_line)
            except (UnicodeError, json.JSONDecodeError):
                continue
            if not isinstance(event, dict):
                continue
            at_ms = max(self.started_ms, event_unix_ms(event, now_ms))
            progressed |= self.apply_event(event, at_ms)
        return progressed

    def apply_event(self, event: dict[str, Any], at_ms: int) -> bool:
        event_type = event.get("type")
        payload = event.get("payload")
        if not isinstance(payload, dict):
            return False
        if event_type == "response_item":
            payload_type = payload.get("type")
            if payload_type in ("function_call", "custom_tool_call"):
                self._start_call(payload, at_ms)
                return True
            if payload_type in ("function_call_output", "custom_tool_call_output"):
                self._finish_call(payload, at_ms)
                return True
            if payload_type == "message":
                self._mark_activity(at_ms)
                return True
            return False
        if event_type != "event_msg":
            return False
        payload_type = str(payload.get("type") or "")
        if payload_type in ("task_started", "turn_started"):
            self.turn_active = True
            self._mark_activity(at_ms)
            return True
        if payload_type in ("task_complete", "turn_complete", "turn_aborted"):
            self.turn_active = False
            self.active_calls.clear()
            self.process_calls.clear()
            self.poll_calls.clear()
            self._mark_activity(at_ms)
            return True
        if payload_type in ("agent_message", "user_message"):
            self._mark_activity(at_ms)
            return True
        if payload_type == "item_completed":
            item = payload.get("item")
            if isinstance(item, dict) and str(item.get("type", "")).lower() == "commandexecution":
                self._clear_command_calls()
                self._mark_activity(at_ms)
                return True
        return False

    def _start_call(self, payload: dict[str, Any], at_ms: int) -> None:
        call_id = str(payload.get("call_id") or "")
        if not call_id:
            return
        name = str(payload.get("name") or "tool")
        args = parse_arguments(payload)
        command = args.get("cmd")
        if not isinstance(command, str):
            custom_input = payload.get("input")
            command = custom_input if name == "exec" and isinstance(custom_input, str) else None
        if name == "write_stdin":
            process_id = str(args.get("session_id") or "")
            original = self.process_calls.get(process_id)
            if original:
                self.poll_calls[call_id] = original
        self.active_calls[call_id] = {
            "name": name,
            "command": command,
            "started_ms": at_ms,
            "last_activity_ms": at_ms,
        }
        self.turn_active = True
        self._mark_activity(at_ms)

    def _finish_call(self, payload: dict[str, Any], at_ms: int) -> None:
        call_id = str(payload.get("call_id") or "")
        output = payload.get("output")
        output = output if isinstance(output, str) else json.dumps(output, ensure_ascii=False)
        running_id = running_session_from_output(output)
        original_id = self.poll_calls.pop(call_id, None)
        if original_id:
            self.active_calls.pop(call_id, None)
            original = self.active_calls.get(original_id)
            if running_id and original:
                original["last_activity_ms"] = at_ms
                self.process_calls[running_id] = original_id
            else:
                self._remove_call(original_id)
        elif running_id and call_id in self.active_calls:
            self.active_calls[call_id]["last_activity_ms"] = at_ms
            self.process_calls[running_id] = call_id
        else:
            self._remove_call(call_id)
        self._mark_activity(at_ms)

    def _remove_call(self, call_id: str) -> None:
        self.active_calls.pop(call_id, None)
        for process_id, original_id in list(self.process_calls.items()):
            if original_id == call_id:
                self.process_calls.pop(process_id, None)

    def _clear_command_calls(self) -> None:
        for call_id, call in list(self.active_calls.items()):
            if call.get("name") in ("exec", "exec_command", "write_stdin"):
                self._remove_call(call_id)

    def _mark_activity(self, at_ms: int) -> None:
        self.last_activity_ms = max(self.last_activity_ms, at_ms)

    def current_call(self) -> dict[str, Any] | None:
        if not self.active_calls:
            return None
        calls = [call for call in self.active_calls.values() if call.get("name") != "write_stdin"]
        if not calls:
            calls = list(self.active_calls.values())
        return max(calls, key=lambda call: int(call.get("started_ms", 0)))

    def classify(self, now_ms: int, config: dict[str, Any]) -> tuple[str, str]:
        call = self.current_call()
        if call is None:
            if self.turn_active:
                return "model_active", "Codex is processing the current turn"
            return "idle", "No active Codex turn or tool call"
        name = str(call.get("name") or "tool")
        age_ms = max(0, now_ms - int(call.get("last_activity_ms", self.last_activity_ms)))
        if name in ("request_user_input", "request_user_input_tool"):
            return "waiting_user", "Codex is waiting for user input"
        if name in ("wait_agent", "wait"):
            return "waiting_subagent", "Codex is waiting for a subagent"
        stalled_ms = int(config["suspected_stalled_after_seconds"]) * 1000
        silent_ms = int(config["silent_after_seconds"]) * 1000
        if age_ms >= stalled_ms:
            return "suspected_stalled", "The active tool has not produced a new rollout event"
        if age_ms >= silent_ms and name in ("exec", "exec_command", "write_stdin"):
            return "command_running_silent", "The command is still running without new rollout output"
        return "tool_running", "A Codex tool call is active"

    def diagnostic(self, now_ms: int, config: dict[str, Any]) -> tuple[dict[str, Any], bool]:
        state, reason = self.classify(now_ms, config)
        if state == "suspected_stalled" and self.previous_state != "suspected_stalled":
            self.episode += 1
            self.episode_id = f"{self.session_id}:{self.episode}"
        if self.previous_state == "suspected_stalled" and state != "suspected_stalled":
            state = "recovered"
            reason = "New rollout activity arrived after a suspected stall"
            self.episode_id = None
        self.previous_state = state
        notify = (
            state == "suspected_stalled"
            and self.episode_id is not None
            and self.notified_episode_id != self.episode_id
        )
        call = self.current_call()
        fields = [
            {"key": "monitor_state", "label": "Monitor", "value": state},
            {
                "key": "last_activity",
                "label": "Last activity",
                "value": format_age(now_ms - self.last_activity_ms),
            },
        ]
        if call:
            fields.append({"key": "tool", "label": "Tool", "value": str(call.get("name") or "tool")})
            command = call.get("command")
            if config["include_command"] and isinstance(command, str) and command.strip():
                fields.append({"key": "command", "label": "Command", "value": compact(command, 220)})
        fields.append({"key": "reason", "label": "Reason", "value": reason})
        diagnostic = {
            "source": SOURCE,
            "diagnostic_id": DIAGNOSTIC_ID,
            "severity": "warning" if state == "suspected_stalled" else "info",
            "state": state,
            "title": "Codex activity",
            "summary": reason,
            "fields": fields,
            "session_id": self.session_id,
            "episode_id": self.episode_id,
            "last_activity_unix_ms": self.last_activity_ms,
            "updated_unix_ms": now_ms,
        }
        return diagnostic, notify

    def mark_notified(self) -> None:
        self.notified_episode_id = self.episode_id


def compact(value: str, limit: int) -> str:
    value = " ".join(value.split())
    return value if len(value) <= limit else value[: limit - 3] + "..."


def format_age(age_ms: int) -> str:
    seconds = max(0, age_ms // 1000)
    if seconds < 60:
        return f"{seconds}s ago"
    minutes, seconds = divmod(seconds, 60)
    if minutes < 60:
        return f"{minutes}m {seconds}s ago"
    hours, minutes = divmod(minutes, 60)
    return f"{hours}h {minutes}m ago"


def pane_list(socket_path: str) -> list[dict[str, Any]]:
    response = api_request(socket_path, "pane.list", {})
    result = response.get("result")
    if not isinstance(result, dict):
        return []
    panes = result.get("panes", []) if result.get("type") == "pane_list" else []
    return panes if isinstance(panes, list) else []


def report_diagnostic(socket_path: str, pane_id: str, diagnostic: dict[str, Any], ttl_ms: int) -> None:
    params = {"pane_id": pane_id, **diagnostic, "seq": time.time_ns(), "ttl_ms": ttl_ms}
    api_request(socket_path, "pane.report_diagnostic", params)


def clear_diagnostic(socket_path: str, pane_id: str) -> None:
    api_request(
        socket_path,
        "pane.clear_diagnostic",
        {
            "pane_id": pane_id,
            "source": SOURCE,
            "diagnostic_id": DIAGNOSTIC_ID,
            "seq": time.time_ns(),
        },
    )


def notify_stall(socket_path: str, pane: dict[str, Any], diagnostic: dict[str, Any]) -> None:
    title = "Codex may be stalled"
    workspace = str(pane.get("workspace_id") or "workspace")
    body = compact(f"{workspace}: {diagnostic['summary']}", 240)
    api_request(
        socket_path,
        "notification.show",
        {"title": title, "body": body, "position": "top-right", "sound": "request"},
    )


def active_codex_sessions(panes: list[dict[str, Any]]) -> dict[str, tuple[str, dict[str, Any]]]:
    sessions: dict[str, tuple[str, dict[str, Any]]] = {}
    for pane in panes:
        if not isinstance(pane, dict):
            continue
        if pane.get("agent") != "codex":
            continue
        session = pane.get("agent_session")
        if not isinstance(session, dict) or session.get("kind") != "id":
            continue
        session_id = session.get("value")
        pane_id = pane.get("pane_id")
        if isinstance(session_id, str) and session_id and isinstance(pane_id, str) and pane_id:
            sessions[pane_id] = (session_id, pane)
    return sessions


def run() -> int:
    socket_path = os.environ.get("HERDR_SOCKET_PATH", "")
    config_dir = Path(os.environ.get("HERDR_PLUGIN_CONFIG_DIR", "."))
    codex_home = Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))).expanduser()
    if not socket_path:
        return 0
    trackers: dict[str, RolloutTracker] = {}
    running = True

    def stop(_signum: int, _frame: Any) -> None:
        nonlocal running
        running = False

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    started_ms = unix_ms()
    while running:
        loop_started = time.monotonic()
        config = parse_config(config_dir / "config.toml")
        interval = int(config["poll_interval_ms"]) / 1000.0
        ttl_ms = max(5_000, int(config["poll_interval_ms"]) * 4)
        try:
            if not config["enabled"]:
                for pane_id in list(trackers):
                    try:
                        clear_diagnostic(socket_path, pane_id)
                    except (OSError, ValueError, json.JSONDecodeError):
                        pass
                trackers.clear()
                remaining = interval - (time.monotonic() - loop_started)
                if remaining > 0:
                    time.sleep(remaining)
                continue
            sessions = active_codex_sessions(pane_list(socket_path))
            for pane_id in list(trackers):
                if pane_id not in sessions or trackers[pane_id].session_id != sessions[pane_id][0]:
                    try:
                        clear_diagnostic(socket_path, pane_id)
                    except (OSError, ValueError, json.JSONDecodeError):
                        pass
                    trackers.pop(pane_id, None)
            for pane_id, (session_id, pane) in sessions.items():
                tracker = trackers.get(pane_id)
                if tracker is None:
                    rollout = find_rollout(codex_home, session_id)
                    if rollout is None:
                        continue
                    tracker = RolloutTracker(pane_id, session_id, rollout, started_ms)
                    trackers[pane_id] = tracker
                now_ms = unix_ms()
                tracker.read_new_events(now_ms)
                diagnostic, should_notify = tracker.diagnostic(now_ms, config)
                diagnostic["fields"].insert(0, {
                    "key": "agent_status",
                    "label": "Codex status",
                    "value": str(pane.get("agent_status") or "unknown"),
                })
                report_diagnostic(socket_path, pane_id, diagnostic, ttl_ms)
                grace_ms = int(config["startup_grace_seconds"]) * 1000
                if should_notify and config["notify"] and now_ms - started_ms >= grace_ms:
                    notify_stall(socket_path, pane, diagnostic)
                    tracker.mark_notified()
        except (OSError, ValueError, json.JSONDecodeError) as error:
            print(f"codex rollout monitor: {error}", file=sys.stderr)
        remaining = interval - (time.monotonic() - loop_started)
        if remaining > 0:
            time.sleep(remaining)
    return 0


if __name__ == "__main__":
    raise SystemExit(run())

#!/bin/sh
# installed by herdr
# managed by herdr; reinstalling or updating the integration overwrites this file.
# add custom hooks beside this file instead of editing it.
# HERDR_INTEGRATION_ID=grok
# HERDR_INTEGRATION_VERSION=2

set -eu

# Grok hooks pass event JSON on stdin and set GROK_SESSION_ID / GROK_HOOK_EVENT.
hook_input_file="$(mktemp "${TMPDIR:-/tmp}/herdr-grok-hook.XXXXXX")" || exit 0
trap 'rm -f "$hook_input_file"' EXIT HUP INT TERM
cat >"$hook_input_file" 2>/dev/null || true

[ "${HERDR_ENV:-}" = "1" ] || exit 0
[ -n "${HERDR_SOCKET_PATH:-}" ] || exit 0
[ -n "${HERDR_PANE_ID:-}" ] || exit 0
command -v python3 >/dev/null 2>&1 || exit 0

HERDR_HOOK_INPUT_FILE="$hook_input_file" python3 - <<'PY'
import json
import os
import random
import socket
import time

source = "herdr:grok"
agent = "grok"
pane_id = os.environ.get("HERDR_PANE_ID")
socket_path = os.environ.get("HERDR_SOCKET_PATH")
hook_input_file = os.environ.get("HERDR_HOOK_INPUT_FILE")

if not pane_id or not socket_path:
    raise SystemExit(0)

hook_input = {}
if hook_input_file:
    try:
        with open(hook_input_file, encoding="utf-8") as handle:
            content = handle.read()
        if content.strip():
            hook_input = json.loads(content)
    except Exception:
        hook_input = {}


def first_text(*keys):
    for key in keys:
        value = hook_input.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    env_session = os.environ.get("GROK_SESSION_ID", "").strip()
    if env_session:
        return env_session
    return None


def event_name():
    for key in ("hook_event_name", "hookEventName", "event", "type"):
        value = hook_input.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    env_event = os.environ.get("GROK_HOOK_EVENT", "").strip()
    return env_event or ""


def normalize_event(name: str) -> str:
    raw = name.strip()
    if not raw:
        return ""
    # Accept PascalCase, camelCase, and snake_case from Grok / Cursor compat.
    out = []
    for index, ch in enumerate(raw):
        if ch == "_" or ch == "-":
            out.append("_")
            continue
        if ch.isupper() and index > 0 and (raw[index - 1].islower() or raw[index - 1].isdigit()):
            out.append("_")
        out.append(ch.lower())
    return "".join(out).replace("__", "_")


def map_state(event: str) -> str | None:
    """Map Grok hook events to Herdr pane state.

    Subagent lifecycle must not force root idle: a SubagentStop while other
    work continues was flipping sidebar idle/working and re-firing finished
    toasts. SubagentStart keeps working; SubagentStop is ignored for state.
    """
    event = normalize_event(event)

    # Ignore subagent completion for root state (do not report idle).
    if event in {
        "subagent_stop",
        "subagentstop",
        "subagent_end",
        "subagentend",
    }:
        return None

    if event in {
        "session_start",
        "sessionstart",
        "session_end",
        "sessionend",
        "stop",
        "stop_failure",
        "stopfailure",
    }:
        return "idle"
    if event in {
        "user_prompt_submit",
        "userpromptsubmit",
        "pre_tool_use",
        "pretooluse",
        "post_tool_use",
        "posttooluse",
        "post_tool_use_failure",
        "posttoolusefailure",
        "subagent_start",
        "subagentstart",
        "pre_compact",
        "precompact",
        "post_compact",
        "postcompact",
    }:
        return "working"
    if event in {"notification"}:
        # Prefer blocked for approval-style notifications when identifiable.
        notify_type = first_text("notification_type", "notificationType", "type", "kind") or ""
        notify_type = notify_type.lower()
        message = first_text("message", "GROK_MESSAGE") or os.environ.get("GROK_MESSAGE", "")
        blob = f"{notify_type} {message}".lower()
        if any(
            token in blob
            for token in (
                "approval",
                "permission",
                "confirm",
                "allow",
                "ask",
                "required",
            )
        ):
            return "blocked"
        # Non-approval notifications (e.g. turn_complete) must not force idle;
        # Stop / SessionEnd own idle transitions.
        return None
    return None


session_id = first_text("sessionId", "session_id", "conversationId", "conversation_id")
event = event_name()
state = map_state(event)
report_seq = time.time_ns()
base_id = f"{source}:{int(time.time() * 1000)}:{random.randrange(1_000_000):06d}"


def send(method: str, params: dict) -> None:
    request = {
        "id": f"{base_id}:{method}",
        "method": method,
        "params": {
            "pane_id": pane_id,
            "source": source,
            "agent": agent,
            "seq": report_seq,
            **params,
        },
    }
    try:
        client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        client.settimeout(0.5)
        client.connect(socket_path)
        client.sendall((json.dumps(request) + "\n").encode())
        try:
            client.recv(4096)
        except Exception:
            pass
        client.close()
    except Exception:
        pass


if session_id:
    send(
        "pane.report_agent_session",
        {"agent_session_id": session_id},
    )

if state:
    params = {"state": state}
    if session_id:
        params["agent_session_id"] = session_id
    send("pane.report_agent", params)
PY

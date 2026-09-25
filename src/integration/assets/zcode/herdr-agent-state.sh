#!/bin/sh
# installed by herdr
# managed by herdr; reinstalling or updating the integration overwrites this file.
# add custom hooks beside this file instead of editing it.
# HERDR_INTEGRATION_ID=zcode
# HERDR_INTEGRATION_VERSION=1

set -eu

action="${1:-}"
hook_input_file="$(mktemp "${TMPDIR:-/tmp}/herdr-zcode-hook.XXXXXX")" || exit 0
trap 'rm -f "$hook_input_file"' EXIT HUP INT TERM
cat >"$hook_input_file" 2>/dev/null || true

# ZCode has no argv action contract: the event arrives only as stdin JSON, and
# Herdr registers one hook per event. Derive the action from hook_event_name,
# which ZCode writes in Claude's snake_case form, so the parsing below stays
# identical to claude's. A missing name means the payload is not one we handle.
if [ -z "$action" ]; then
  action="$(python3 -c '
import json, sys
try:
    with open(sys.argv[1], encoding="utf-8") as handle:
        event = json.load(handle).get("hook_event_name")
except Exception:
    event = None
print({"SessionStart": "session", "PermissionRequest": "permission"}.get(event, ""))
' "$hook_input_file" 2>/dev/null || true)"
fi

case "$action" in
  session) ;;
  permission) ;;
  *) exit 0 ;;
esac

[ "${HERDR_ENV:-}" = "1" ] || exit 0
[ -n "${HERDR_SOCKET_PATH:-}" ] || exit 0
[ -n "${HERDR_PANE_ID:-}" ] || exit 0
command -v python3 >/dev/null 2>&1 || exit 0

HERDR_ACTION="$action" HERDR_HOOK_INPUT_FILE="$hook_input_file" python3 - <<'PY'
import json
import os
import random
import socket
import time

source = "herdr:zcode"
action = os.environ.get("HERDR_ACTION", "")
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


def call(method, params):
    """Sends one request and returns its decoded response, or None.

    One connection per request: Herdr serves one request per connection, so a
    re-used socket would read the previous response. Every failure returns None
    so the caller degrades instead of leaving a half-written decision on stdout.
    """
    request_id = f"{source}:{int(time.time() * 1000)}:{random.randrange(1_000_000):06d}"
    request = {"id": request_id, "method": method, "params": params}
    try:
        client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        client.settimeout(2.0)
        client.connect(socket_path)
        client.sendall((json.dumps(request) + "\n").encode())
        buffer = b""
        while b"\n" not in buffer:
            chunk = client.recv(65536)
            if not chunk:
                break
            buffer += chunk
        client.close()
    except Exception:
        return None
    if not buffer:
        return None
    try:
        return json.loads(buffer.split(b"\n", 1)[0].decode("utf-8", "replace"))
    except Exception:
        return None


hook_event_name = str(hook_input.get("hook_event_name") or "")
is_subagent = bool(hook_input.get("agent_id"))
if is_subagent:
    raise SystemExit(0)
# ZCode's hook event set has no SubagentStop; a subagent finishing must not
# revive an idle pane, and ZCode reports subagent work through its own events.
# (ZCode contracts/src/hooks/index.ts:7-15)


def summarise(tool_input):
    """A readable rendering of what is being approved.

    This is the text the reader judges, so the usual single-value cases are
    shown as-is rather than as escaped JSON.
    """
    if isinstance(tool_input, dict):
        for key in ("command", "cmd", "file_path", "path", "url", "pattern", "query"):
            value = tool_input.get(key)
            if isinstance(value, str) and value.strip():
                return value
    try:
        return json.dumps(tool_input, ensure_ascii=False, sort_keys=True)
    except Exception:
        return ""


def request_permission():
    """Publishes the approval as a structured request and waits for an answer.

    The hook runs before Claude draws its own permission prompt, so the wait is
    bounded: when it ends without an answer the request is withdrawn and nothing
    is printed, which hands the prompt back to Claude's own UI.

    Returns the decided option id, or None when the user did not decide.
    """
    tool_name = str(hook_input.get("tool_name") or "tool")
    try:
        wait_ms = int(os.environ.get("HERDR_CLAUDE_PERMISSION_WAIT_MS", "3000"))
    except Exception:
        wait_ms = 3000
    wait_ms = max(0, min(wait_ms, 600_000))

    request_id = f"{source}:permission:{int(time.time() * 1000)}:{random.randrange(1_000_000):06d}"
    params = {
        "pane_id": pane_id,
        "source": source,
        "request_id": request_id,
        "kind": "approval",
        "title": f"Allow {tool_name}?",
        "summary": summarise(hook_input.get("tool_input")),
        "created_unix_ms": int(time.time() * 1000),
        "seq": time.time_ns(),
        # The request must not outlive the wait: once the hook has exited nobody
        # can collect an answer, so a lingering panel would offer a choice that
        # goes nowhere.
        "ttl_ms": wait_ms + 5_000,
        "questions": [
            {
                "id": "decision",
                "header": tool_name,
                "question": f"Allow {tool_name} to run?",
                # Option ids are ours, so the answer cannot be confused with
                # anything the agent wrote.
                "options": [
                    {"id": "allow", "label": "Allow"},
                    {"id": "deny", "label": "Deny"},
                ],
            }
        ],
    }
    if call("pane.report_interaction", params) is None:
        return None

    decision = None
    deadline = time.monotonic() + (wait_ms / 1000.0)
    try:
        while decision is None:
            poll = call(
                "pane.take_interaction_answer",
                {"pane_id": pane_id, "source": source, "request_id": request_id},
            )
            if poll is not None:
                result = poll.get("result") or {}
                for answer in result.get("answers") or []:
                    if answer.get("question_id") != "decision":
                        continue
                    for option_id in answer.get("option_ids") or []:
                        if option_id in ("allow", "deny"):
                            decision = option_id
                            break
                    if decision:
                        break
                # No answer this poll. `pending` distinguishes "the user has not
                # decided yet" from "the question is gone" (answered elsewhere,
                # withdrawn, or expired); only the latter ends the wait early.
                if decision is None and not result.get("pending"):
                    break
            if time.monotonic() >= deadline:
                break
            if decision is None:
                time.sleep(0.05)
    finally:
        # Withdraw either way: on success taking the answer already cleared it,
        # and on timeout this is what stops a panel outliving the hook.
        call(
            "pane.clear_interaction",
            {"pane_id": pane_id, "source": source, "request_id": request_id},
        )
    return decision


if action == "permission":
    decided = request_permission()
    if decided is None:
        # No decision: exit with no output so Claude draws its own permission
        # prompt, exactly as it would without this hook.
        raise SystemExit(0)
    # The decision must be nested under `hookSpecificOutput` as
    # `decision.behavior`. Claude validates this shape explicitly: a top-level
    # `decision` is its legacy approve/block field, and a `behavior` outside
    # `decision` is rejected without taking effect.
    decision = {"behavior": decided}
    if decided == "deny":
        decision["message"] = "Denied in the Herdr web UI."
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PermissionRequest",
        "decision": decision,
    }}))
    raise SystemExit(0)

request_id = f"{source}:{int(time.time() * 1000)}:{random.randrange(1_000_000):06d}"
report_seq = time.time_ns()
session_id = hook_input.get("session_id")
agent_session_id = session_id if isinstance(session_id, str) and session_id else None
# ZCode does expose transcript_path, but it is a throwaway file holding only the
# current message and it is deleted when the hook returns
# (configured-runner-input.ts:25-29,63-66). Reporting it would persist a path
# that is gone by the next read, so only the session id is reported.
session_start_source = hook_input.get("source") if hook_event_name == "SessionStart" else None
if not isinstance(session_start_source, str) or not session_start_source:
    session_start_source = None
if not agent_session_id:
    raise SystemExit(0)
params = {
    "pane_id": pane_id,
    "source": source,
    "agent": "zcode",
    "seq": report_seq,
    "agent_session_id": agent_session_id,
}
if session_start_source:
    params["session_start_source"] = session_start_source
call("pane.report_agent_session", params)
PY

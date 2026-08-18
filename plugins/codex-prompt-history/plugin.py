#!/usr/bin/env python3
"""Search and insert submitted prompts from the active Codex rollout."""

from __future__ import annotations

from dataclasses import dataclass
import glob
import json
import os
from pathlib import Path
import select
import shutil
import socket
import sys
import termios
import time
import tty
from typing import Any, Iterable


PLUGIN_ID = "local.codex-prompt-history"
MAX_API_RESPONSE = 4 * 1024 * 1024
MAX_RESULTS = 100
PREVIEW_LIMIT = 180


@dataclass(frozen=True)
class Prompt:
    """A submitted user prompt and its order in the rollout."""

    text: str
    sequence: int
    timestamp: str | None = None


def context() -> dict[str, Any]:
    """Read the invocation context injected by Herdr."""
    try:
        value = json.loads(os.environ.get("HERDR_PLUGIN_CONTEXT_JSON", "{}"))
    except json.JSONDecodeError:
        return {}
    return value if isinstance(value, dict) else {}


def herdr_bin() -> str:
    return os.environ.get("HERDR_BIN_PATH") or shutil.which("herdr") or "herdr"


def api_request(method: str, params: dict[str, Any]) -> dict[str, Any]:
    """Send one request to Herdr's Unix socket and return its JSON object."""
    socket_path = os.environ.get("HERDR_SOCKET_PATH")
    if not socket_path:
        raise RuntimeError("HERDR_SOCKET_PATH is not available.")
    request = {
        "id": f"{PLUGIN_ID}:{time.time_ns()}",
        "method": method,
        "params": params,
    }
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    client.settimeout(2.0)
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
    except OSError as error:
        raise RuntimeError(f"could not connect to Herdr: {error}") from error
    finally:
        client.close()

    line = bytes(response).split(b"\n", 1)[0]
    if not line:
        raise RuntimeError("Herdr returned an empty response.")
    try:
        value = json.loads(line)
    except json.JSONDecodeError as error:
        raise RuntimeError("Herdr returned invalid JSON.") from error
    if not isinstance(value, dict):
        raise RuntimeError("Herdr returned an invalid response.")
    if isinstance(value.get("error"), dict):
        message = value["error"].get("message") or value["error"].get("code")
        raise RuntimeError(str(message or "Herdr request failed."))
    return value


def response_result(response: dict[str, Any]) -> dict[str, Any]:
    result = response.get("result")
    if not isinstance(result, dict):
        raise RuntimeError("Herdr returned no result.")
    return result


def target_pane_id(ctx: dict[str, Any]) -> str:
    value = os.environ.get("TARGET_PANE_ID") or ctx.get("focused_pane_id")
    if not isinstance(value, str) or not value.strip():
        raise RuntimeError("No target Agent pane was provided.")
    return value.strip()


def load_pane(pane_id: str) -> dict[str, Any]:
    result = response_result(api_request("pane.get", {"pane_id": pane_id}))
    pane = result.get("pane")
    if not isinstance(pane, dict):
        raise RuntimeError("Herdr did not return pane information.")
    return pane


def open_picker() -> int:
    """Open the overlay while preserving the pane that invoked the action."""
    ctx = context()
    try:
        pane_id = target_pane_id(ctx)
    except RuntimeError as error:
        print(str(error), file=sys.stderr)
        return 1
    result = subprocess_run(picker_open_command(pane_id))
    return result


def picker_open_command(pane_id: str) -> list[str]:
    """Build the CLI command that opens an overlay for a target pane."""
    return [
        herdr_bin(),
        "plugin",
        "pane",
        "open",
        "--plugin",
        PLUGIN_ID,
        "--entrypoint",
        "picker",
        "--placement",
        "overlay",
        "--focus",
        "--env",
        f"TARGET_PANE_ID={pane_id}",
    ]


def subprocess_run(argv: list[str]) -> int:
    """Run a Herdr/OS command without making plugin output part of the UI."""
    import subprocess

    completed = subprocess.run(argv, check=False)
    return completed.returncode


def codex_home() -> Path:
    value = os.environ.get("CODEX_HOME")
    if value:
        return Path(value).expanduser()
    return Path.home() / ".codex"


def rollout_matches_session(path: Path, session_id: str) -> bool:
    try:
        with path.open("rb") as handle:
            first = json.loads(handle.readline())
    except (OSError, UnicodeError, json.JSONDecodeError):
        return False
    if not isinstance(first, dict) or first.get("type") != "session_meta":
        return False
    payload = first.get("payload")
    return isinstance(payload, dict) and payload.get("id") == session_id


def find_rollout(home: Path, session_ref: dict[str, Any]) -> Path:
    """Resolve the current Codex session id/path to a rollout file."""
    kind = str(session_ref.get("kind") or "id")
    value = session_ref.get("value")
    if not isinstance(value, str) or not value.strip():
        raise RuntimeError("Codex has not reported a session reference yet.")
    if kind == "path":
        path = Path(value).expanduser()
        if path.is_file():
            return path
        raise RuntimeError(f"Codex rollout file does not exist: {path}")

    session_id = value.strip()
    sessions = home / "sessions"
    pattern = str(sessions / "*" / "*" / "*" / "rollout-*.jsonl")
    candidates: list[Path] = []
    for raw in glob.glob(pattern):
        path = Path(raw)
        try:
            if rollout_matches_session(path, session_id):
                candidates.append(path)
        except OSError:
            continue
    if not candidates:
        raise RuntimeError(
            f"Could not find Codex rollout for session {session_id}. "
            f"Checked {sessions}."
        )
    return max(candidates, key=lambda path: path.stat().st_mtime_ns)


def _text_from_response_item(payload: dict[str, Any]) -> str | None:
    content = payload.get("content")
    if not isinstance(content, list):
        return None
    parts: list[str] = []
    for item in content:
        if not isinstance(item, dict):
            continue
        if item.get("type") == "input_text" and isinstance(item.get("text"), str):
            parts.append(item["text"])
    text = "".join(parts).strip()
    return text or None


def _event_prompt(record: dict[str, Any]) -> str | None:
    if record.get("type") != "event_msg":
        return None
    payload = record.get("payload")
    if not isinstance(payload, dict) or payload.get("type") != "user_message":
        return None
    message = payload.get("message")
    if not isinstance(message, str):
        return None
    message = message.strip()
    return message or None


def _response_prompt(record: dict[str, Any]) -> str | None:
    if record.get("type") != "response_item":
        return None
    payload = record.get("payload")
    if not isinstance(payload, dict) or payload.get("type") != "message":
        return None
    if payload.get("role") != "user":
        return None
    return _text_from_response_item(payload)


def parse_rollout(path: Path) -> list[Prompt]:
    """Extract submitted user prompts, preferring Codex user_message events."""
    events: list[tuple[str, str | None]] = []
    fallback: list[tuple[str, str | None]] = []
    try:
        with path.open("r", encoding="utf-8") as handle:
            for sequence, raw in enumerate(handle):
                try:
                    record = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if not isinstance(record, dict):
                    continue
                timestamp = record.get("timestamp")
                stamp = timestamp if isinstance(timestamp, str) else None
                event = _event_prompt(record)
                if event:
                    events.append((event, stamp))
                fallback_prompt = _response_prompt(record)
                if fallback_prompt:
                    fallback.append((fallback_prompt, stamp))
    except (OSError, UnicodeError) as error:
        raise RuntimeError(f"Could not read Codex rollout: {error}") from error

    selected = events or fallback
    return [Prompt(text=text, sequence=index, timestamp=stamp) for index, (text, stamp) in enumerate(selected)]


def _subsequence_score(query: str, text: str) -> int | None:
    """Return a simple fuzzy score, or None when query is not a subsequence."""
    query_folded = query.casefold()
    text_folded = text.casefold()
    if not query_folded:
        return 0
    positions: list[int] = []
    cursor = 0
    for char in query_folded:
        position = text_folded.find(char, cursor)
        if position < 0:
            return None
        positions.append(position)
        cursor = position + 1

    score = 0
    if text_folded.startswith(query_folded):
        score += 1000
    if query_folded in text_folded:
        score += 500
    if positions and positions[0] == 0:
        score += 150
    for previous, current in zip(positions, positions[1:]):
        if current == previous + 1:
            score += 15
        if current == 0 or text[current - 1].isspace() or text[current - 1] in "-_/:.":
            score += 10
    score -= positions[-1] - positions[0]
    score -= max(0, len(text) - len(query)) // 20
    return score


def fuzzy_matches(prompts: Iterable[Prompt], query: str) -> list[Prompt]:
    scored: list[tuple[int, int, Prompt]] = []
    for prompt in prompts:
        score = _subsequence_score(query, prompt.text)
        if score is not None:
            scored.append((score, -prompt.sequence, prompt))
    scored.sort(key=lambda item: (item[0], item[1]), reverse=True)
    return [prompt for _, _, prompt in scored[:MAX_RESULTS]]


def compact_preview(text: str, limit: int = PREVIEW_LIMIT) -> str:
    one_line = " ".join(text.split())
    if len(one_line) <= limit:
        return one_line
    return one_line[: max(0, limit - 3)].rstrip() + "..."


def read_key(fd: int) -> str:
    first = os.read(fd, 1)
    if not first:
        return "eof"
    if first == b"\x03":
        return "cancel"
    if first in (b"\r", b"\n"):
        return "enter"
    if first in (b"\x7f", b"\x08"):
        return "backspace"
    if first == b"\x1b":
        if select.select([fd], [], [], 0.05)[0]:
            second = os.read(fd, 1)
            if second == b"[" and select.select([fd], [], [], 0.05)[0]:
                third = os.read(fd, 1)
                return {b"A": "up", b"B": "down"}.get(third, "escape")
        return "escape"
    if first == b"\x04":
        return "cancel"
    data = bytearray(first)
    while True:
        try:
            return bytes(data).decode("utf-8")
        except UnicodeDecodeError as error:
            # A terminal sends a UTF-8 character as several bytes. Wait only
            # for the remainder of an incomplete sequence; invalid bytes are
            # ignored instead of blocking the picker indefinitely.
            if error.reason != "unexpected end of data" or len(data) >= 4:
                return ""
            if not select.select([fd], [], [], 0.05)[0]:
                return ""
            data.extend(os.read(fd, 1))


def draw_picker(query: str, matches: list[Prompt], selected: int) -> None:
    columns = shutil.get_terminal_size((100, 24)).columns
    print("\x1b[2J\x1b[H", end="")
    print("Codex prompt history")
    print("Search: " + query)
    print("Up/Down select | Enter insert | Esc cancel")
    print("-" * max(1, min(columns, 100)))
    if not matches:
        print("No submitted prompts match the search.")
        sys.stdout.flush()
        return
    visible = max(1, shutil.get_terminal_size((100, 24)).lines - 6)
    start = max(0, min(selected - visible + 1, len(matches) - visible))
    for index, prompt in enumerate(matches[start : start + visible], start=start):
        marker = ">" if index == selected else " "
        print(f"{marker} {index + 1:>3}: {compact_preview(prompt.text, max(20, columns - 10))}")
    sys.stdout.flush()


def run_menu() -> int:
    ctx = context()
    try:
        pane_id = target_pane_id(ctx)
        pane = load_pane(pane_id)
        agent = str(pane.get("agent") or ctx.get("focused_pane_agent") or "").casefold()
        if agent != "codex":
            raise RuntimeError("This plugin only works with Codex panes.")
        status = str(pane.get("agent_status") or "unknown").casefold()
        if status not in {"idle", "blocked"}:
            raise RuntimeError(
                f"Codex is {status}; prompt insertion is available only when it is idle or blocked."
            )
        session = pane.get("agent_session")
        if not isinstance(session, dict):
            raise RuntimeError("Codex has not reported a native session yet.")
        prompts = parse_rollout(find_rollout(codex_home(), session))
        if not prompts:
            raise RuntimeError("No submitted text prompts were found in this Codex session.")
    except RuntimeError as error:
        print(str(error))
        print("Press any key to close.")
        sys.stdout.flush()
        fd = sys.stdin.fileno()
        old = termios.tcgetattr(fd)
        try:
            tty.setraw(fd)
            os.read(fd, 1)
        finally:
            termios.tcsetattr(fd, termios.TCSADRAIN, old)
        return 1

    query = ""
    selected = 0
    fd = sys.stdin.fileno()
    old = termios.tcgetattr(fd)
    try:
        tty.setraw(fd)
        while True:
            matches = fuzzy_matches(prompts, query)
            if matches:
                selected = min(selected, len(matches) - 1)
            else:
                selected = 0
            draw_picker(query, matches, selected)
            key = read_key(fd)
            if key in {"escape", "cancel", "eof"}:
                return 0
            if key == "up" and matches:
                selected = (selected - 1) % len(matches)
            elif key == "down" and matches:
                selected = (selected + 1) % len(matches)
            elif key == "backspace":
                query = query[:-1]
            elif key == "enter" and matches:
                chosen = matches[selected]
                response = api_request(
                    "pane.send_input",
                    {"pane_id": pane_id, "text": chosen.text, "keys": []},
                )
                response_result(response)
                return 0
            elif len(key) == 1 and key.isprintable():
                query += key
    except (OSError, RuntimeError) as error:
        print(f"\nCould not insert prompt: {error}", file=sys.stderr)
        return 1
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, old)
        # Herdr restores the previous focus when the overlay process exits.


def main() -> int:
    if len(sys.argv) != 2 or sys.argv[1] not in {"open", "menu"}:
        print("usage: plugin.py <open|menu>", file=sys.stderr)
        return 2
    return open_picker() if sys.argv[1] == "open" else run_menu()


if __name__ == "__main__":
    raise SystemExit(main())

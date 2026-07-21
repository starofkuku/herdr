#!/usr/bin/env python3
"""CC Switch provider switch/add and session export for Herdr Agent panes."""

from __future__ import annotations

from datetime import date
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import termios
import tomllib
import tty


# Herdr agent_label -> (cc-switch providers.app_type / DB key, cc-switch --app).
# Availability is NOT hard-gated here: the live set comes from
# `cc-switch apps list` (comma-separated CLI apps).
HERDR_TO_CC_SWITCH: dict[str, tuple[str, str]] = {
    "claude": ("claude", "claude"),
    "codex": ("codex", "codex"),
    "gemini": ("gemini", "gemini"),
    "opencode": ("opencode", "open-code"),
    "openclaw": ("openclaw", "open-claw"),
    "hermes": ("hermes", "hermes"),
    "pi": ("pi", "pi"),
    "grok": ("grok", "grok"),
}


def context() -> dict:
    try:
        value = json.loads(os.environ.get("HERDR_PLUGIN_CONTEXT_JSON", "{}"))
    except json.JSONDecodeError:
        return {}
    return value if isinstance(value, dict) else {}


def herdr_bin() -> str:
    return os.environ.get("HERDR_BIN_PATH") or shutil.which("herdr") or "herdr"


def plugin_id() -> str:
    return os.environ.get("HERDR_PLUGIN_ID", "local.cc-switch-agent")


def parse_apps_list(raw: str) -> set[str]:
    """Parse `cc-switch apps list` stdout: 'claude, codex, open-code, …'."""
    text = raw.strip()
    if not text:
        return set()
    # Tolerate accidental multi-line or trailing punctuation.
    text = text.replace("\n", ",").replace("\r", ",")
    return {part.strip() for part in text.split(",") if part.strip()}


def list_cc_switch_apps() -> set[str]:
    """Return CLI app ids from `cc-switch apps list`."""
    if shutil.which("cc-switch") is None:
        raise RuntimeError("cc-switch is not available on PATH.")
    result = subprocess.run(
        ["cc-switch", "apps", "list"],
        check=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if result.returncode != 0:
        err = (result.stderr or result.stdout or "cc-switch apps list failed").strip()
        raise RuntimeError(err)
    apps = parse_apps_list(result.stdout or "")
    if not apps:
        raise RuntimeError("cc-switch apps list returned no apps.")
    return apps


def resolve_cc_switch_app(herdr_agent: str) -> tuple[str, str] | None:
    """Map a Herdr agent label to (db_app_type, cli_app) if known."""
    agent = herdr_agent.strip().lower()
    if not agent:
        return None
    return HERDR_TO_CC_SWITCH.get(agent)


def require_supported_app(herdr_agent: str) -> tuple[str, str]:
    """Resolve agent and ensure it appears in live `cc-switch apps list`."""
    mapping = resolve_cc_switch_app(herdr_agent)
    if mapping is None:
        raise RuntimeError(
            f"{herdr_agent or 'This pane'} has no Herdr→cc-switch mapping. "
            f"Known Herdr labels: {', '.join(sorted(HERDR_TO_CC_SWITCH))}."
        )
    db_app, cli_app = mapping
    apps = list_cc_switch_apps()
    if cli_app not in apps:
        raise RuntimeError(
            f"cc-switch does not list app {cli_app!r} for agent {herdr_agent!r}. "
            f"apps list: {', '.join(sorted(apps))}."
        )
    return db_app, cli_app


def open_plugin_pane(entrypoint: str) -> int:
    result = subprocess.run(
        [
            herdr_bin(),
            "plugin",
            "pane",
            "open",
            "--plugin",
            plugin_id(),
            "--entrypoint",
            entrypoint,
            "--placement",
            "overlay",
            "--focus",
        ],
        check=False,
    )
    return result.returncode


def open_picker() -> int:
    return open_plugin_pane("provider-picker")


def open_add_provider() -> int:
    return open_plugin_pane("provider-add")


def open_export() -> int:
    return open_plugin_pane("session-export")


def resolve_pane_agent(ctx: dict) -> tuple[str, str]:
    """Return (herdr_agent, cli_app) for the focused pane."""
    pane_id = ctx.get("focused_pane_id")
    agent_label = str(ctx.get("focused_pane_agent") or "").lower()
    agent_info: dict = {}
    if isinstance(pane_id, str) and pane_id:
        try:
            agent_info = load_agent_info(pane_id)
        except RuntimeError:
            agent_info = {}
    agent = str(agent_info.get("agent") or agent_label or "").lower()
    _db_app, cli_app = require_supported_app(agent)
    return agent, cli_app


def cc_switch_db() -> Path:
    explicit = os.environ.get("CC_SWITCH_DB")
    if explicit:
        return Path(explicit).expanduser()
    home = Path(os.environ.get("CC_SWITCH_HOME", "~/.cc-switch")).expanduser()
    return home / "cc-switch.db"


def load_providers(app_type: str) -> list[dict]:
    db = cc_switch_db()
    uri = f"file:{db}?mode=ro"
    try:
        connection = sqlite3.connect(uri, uri=True, timeout=2)
    except sqlite3.Error as error:
        raise RuntimeError(f"cannot open {db}: {error}") from error
    try:
        rows = connection.execute(
            """
            SELECT id, name, settings_config, is_current
            FROM providers
            WHERE app_type = ?
            ORDER BY is_current DESC, sort_index ASC, name COLLATE NOCASE ASC
            """,
            (app_type,),
        ).fetchall()
    except sqlite3.Error as error:
        raise RuntimeError(f"cannot read providers: {error}") from error
    finally:
        connection.close()

    providers = []
    for provider_id, name, raw_config, is_current in rows:
        try:
            config = json.loads(raw_config)
        except (TypeError, json.JSONDecodeError):
            config = {}
        providers.append(
            {
                "id": str(provider_id),
                "name": str(name),
                "model": default_model(app_type, config),
                "current": bool(is_current),
            }
        )
    return providers


def nonempty(value: object) -> str | None:
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def default_model(app_type: str, config: object) -> str | None:
    if not isinstance(config, dict):
        return None
    env = config.get("env")
    if not isinstance(env, dict):
        env = {}

    if app_type == "claude":
        return nonempty(env.get("ANTHROPIC_MODEL"))
    if app_type == "gemini":
        return nonempty(env.get("GEMINI_MODEL"))
    if app_type == "codex":
        direct = nonempty(config.get("model"))
        if direct:
            return direct
        raw_toml = config.get("config")
        if isinstance(raw_toml, str):
            try:
                parsed = tomllib.loads(raw_toml)
            except tomllib.TOMLDecodeError:
                return None
            return nonempty(parsed.get("model"))
        return None
    if app_type == "hermes":
        direct = nonempty(config.get("model"))
        if direct:
            return direct
        models = config.get("models")
        if isinstance(models, list) and models:
            first = models[0]
            if isinstance(first, str):
                return nonempty(first)
            if isinstance(first, dict):
                return nonempty(first.get("id")) or nonempty(first.get("model"))
        model = config.get("model")
        if isinstance(model, dict):
            return nonempty(model.get("default"))
        return None
    if app_type == "opencode":
        models = config.get("models")
        if isinstance(models, dict) and models:
            return nonempty(next(iter(models)))
    return None


def read_key() -> str:
    fd = sys.stdin.fileno()
    previous = termios.tcgetattr(fd)
    try:
        tty.setraw(fd)
        first = os.read(fd, 1)
        if first == b"\x1b":
            second = os.read(fd, 1)
            if second == b"[":
                third = os.read(fd, 1)
                return {b"A": "up", b"B": "down"}.get(third, "escape")
            return "escape"
        if first in (b"\r", b"\n"):
            return "enter"
        if first in (b"q", b"Q", b"\x03"):
            return "escape"
        if first in (b"k", b"K"):
            return "up"
        if first in (b"j", b"J"):
            return "down"
        return "other"
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, previous)


def clear() -> None:
    sys.stdout.write("\x1b[2J\x1b[H")


def pause(message: str) -> None:
    print(f"\n{message}")
    print("\nPress any key to close")
    sys.stdout.flush()
    read_key()


def draw(agent: str, providers: list[dict], selected: int) -> None:
    clear()
    print(f"Switch Provider  |  {agent}")
    print("=" * 56)
    for index, provider in enumerate(providers):
        cursor = ">" if index == selected else " "
        current = " *" if provider["current"] else ""
        model = provider["model"] or "default model"
        print(f"{cursor} {provider['name']}{current}")
        print(f"    {model}")
    print("\nUp/Down or j/k  Select    Enter  Switch    Esc/q  Cancel")
    sys.stdout.flush()


def run_herdr_json(args: list[str]) -> dict:
    result = subprocess.run(
        [herdr_bin(), *args],
        check=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    raw = (result.stdout or "").strip()
    if not raw:
        err = (result.stderr or "").strip() or f"herdr {' '.join(args)} failed"
        raise RuntimeError(err)
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as error:
        raise RuntimeError(f"invalid herdr JSON: {error}") from error
    if not isinstance(payload, dict):
        raise RuntimeError("unexpected herdr response")
    if "error" in payload:
        error = payload.get("error")
        if isinstance(error, dict):
            message = error.get("message") or error.get("code") or str(error)
        else:
            message = str(error)
        raise RuntimeError(message)
    result_obj = payload.get("result")
    if not isinstance(result_obj, dict):
        raise RuntimeError("herdr response missing result")
    return result_obj


def load_agent_info(target: str) -> dict:
    result = run_herdr_json(["agent", "get", target])
    agent = result.get("agent")
    if not isinstance(agent, dict):
        raise RuntimeError("agent get returned no agent object")
    return agent


def session_id_from_agent(agent_info: dict) -> str | None:
    """Return reported native session id, or None if missing/unusable for --id export.

    When official Herdr agent integrations (hooks/plugins) are installed, they
    call pane.report_agent_session with agent_session_id. Herdr stores that as
    agent_session and uses it for resume on restart / session restore.
    """
    session = agent_info.get("agent_session")
    if not isinstance(session, dict):
        return None
    kind = str(session.get("kind") or "").lower()
    value = nonempty(session.get("value"))
    if not value:
        return None
    if kind != "id":
        # Path-kind refs are for Herdr resume (pi/omp), not cc-switch --id.
        return None
    return value


def default_export_dir(ctx: dict, agent_info: dict) -> Path:
    for candidate in (
        agent_info.get("cwd"),
        agent_info.get("foreground_cwd"),
        ctx.get("focused_pane_cwd"),
        ctx.get("workspace_cwd"),
    ):
        text = nonempty(candidate)
        if text:
            path = Path(text).expanduser()
            if path.is_dir():
                return path
    return Path.cwd()


def export_filename(cli_app: str, session_id: str) -> str:
    # Match cc-switch default: ccswitch-<app>-<id8>-<YYYYMMDD>.json
    app_slug = cli_app.replace("_", "-")
    id8 = session_id[:8]
    return f"ccswitch-{app_slug}-{id8}-{date.today().strftime('%Y%m%d')}.json"


def resolve_export_output(ctx: dict, agent_info: dict, cli_app: str, session_id: str) -> Path:
    explicit = nonempty(os.environ.get("CC_SWITCH_EXPORT_DIR"))
    base = Path(explicit).expanduser() if explicit else default_export_dir(ctx, agent_info)
    base.mkdir(parents=True, exist_ok=True)
    return base / export_filename(cli_app, session_id)


def run_cc_switch_export(
    cli_app: str,
    *,
    session_id: str | None,
    output: Path | None,
    cwd: Path | None,
) -> subprocess.CompletedProcess[str]:
    argv = ["cc-switch", "--app", cli_app, "sessions", "export"]
    if session_id:
        argv.extend(["--id", session_id])
    if output is not None:
        argv.extend(["-o", str(output)])
    # Interactive picker needs a real TTY (this overlay pane). Do not capture
    # stdio when selecting a session by hand.
    if session_id is None:
        return subprocess.run(argv, check=False, cwd=str(cwd) if cwd else None)
    return subprocess.run(
        argv,
        check=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        cwd=str(cwd) if cwd else None,
    )


def run_add_provider() -> int:
    """Open the interactive cc-switch provider add wizard for this pane's app."""
    ctx = context()
    pane_id = ctx.get("focused_pane_id")

    clear()
    print("Add Provider")
    print("=" * 56)
    sys.stdout.flush()

    if not isinstance(pane_id, str) or not pane_id:
        pause("No target Agent pane was provided.")
        return 1
    if shutil.which("cc-switch") is None:
        pause("cc-switch is not available on PATH.")
        return 1

    try:
        agent, cli_app = resolve_pane_agent(ctx)
    except RuntimeError as error:
        pause(str(error))
        return 1

    print(f"Agent:  {agent}")
    print(f"App:    {cli_app}")
    print()
    print("Launching: cc-switch --app", cli_app, "provider add")
    print("(interactive wizard; Esc/cancel exits without saving)")
    print()
    sys.stdout.flush()

    # Interactive wizard needs a real TTY — do not capture stdio.
    added = subprocess.run(
        ["cc-switch", "--app", cli_app, "provider", "add"],
        check=False,
    )
    if added.returncode != 0:
        pause(
            "Provider add failed or was cancelled.\n"
            f"You can also run: cc-switch --app {cli_app} provider add"
        )
        return added.returncode

    pause(
        f"Provider add finished for {cli_app}.\n"
        "Use “Switch Agent provider” to select it on this pane."
    )
    return 0


def run_export() -> int:
    ctx = context()
    pane_id = ctx.get("focused_pane_id")
    agent_label = str(ctx.get("focused_pane_agent") or "").lower()

    clear()
    print("Export Session")
    print("=" * 56)
    sys.stdout.flush()

    if not isinstance(pane_id, str) or not pane_id:
        pause("No target Agent pane was provided.")
        return 1
    if shutil.which("cc-switch") is None:
        pause("cc-switch is not available on PATH.")
        return 1

    agent_info: dict = {}
    try:
        agent_info = load_agent_info(pane_id)
    except RuntimeError as error:
        # Still allow interactive export from the context agent label.
        print(f"Note: could not load agent info ({error})")
        sys.stdout.flush()

    agent = str(agent_info.get("agent") or agent_label or "").lower()
    try:
        _db_app, cli_app = require_supported_app(agent)
    except RuntimeError as error:
        pause(str(error))
        return 1

    session_id = session_id_from_agent(agent_info)
    export_dir = default_export_dir(ctx, agent_info)

    if session_id:
        output = resolve_export_output(ctx, agent_info, cli_app, session_id)
        print(f"Agent:    {agent}")
        print(f"Session:  {session_id}  (from Herdr integration)")
        print(f"Output:   {output}")
        print()
        print("Running non-interactive cc-switch sessions export...")
        sys.stdout.flush()
        exported = run_cc_switch_export(
            cli_app, session_id=session_id, output=output, cwd=export_dir
        )
        body = (exported.stdout or "").strip()
        if exported.returncode != 0:
            pause(body or "CC Switch export failed.")
            return exported.returncode
        lines = [
            f"Exported {agent} session {session_id}",
            f"to {output}",
        ]
        if body:
            lines.append("")
            lines.append(body)
        pause("\n".join(lines))
        return 0

    # No official session id: fall back to cc-switch interactive picker.
    print(f"Agent:    {agent}")
    print("Session:  (not reported by Herdr integration)")
    print(f"Cwd:      {export_dir}")
    print()
    print("Opening cc-switch session picker.")
    print("Select a session and press Enter to export.")
    print("Esc cancels.")
    print()
    sys.stdout.flush()

    exported = run_cc_switch_export(
        cli_app, session_id=None, output=None, cwd=export_dir
    )
    if exported.returncode != 0:
        pause(
            "CC Switch interactive export failed or was cancelled.\n"
            "Install the official Herdr agent integration so this pane reports "
            "a session id, or run:\n"
            f"  cc-switch --app {cli_app} sessions export"
        )
        return exported.returncode

    pause(
        f"Export finished for {agent}.\n"
        f"File written under {export_dir} "
        f"(ccswitch-{cli_app}-<id8>-YYYYMMDD.json by default)."
    )
    return 0


def run_menu() -> int:
    ctx = context()
    pane_id = ctx.get("focused_pane_id")
    agent = str(ctx.get("focused_pane_agent") or "").lower()
    status = str(ctx.get("focused_pane_status") or "unknown").lower()
    if not isinstance(pane_id, str) or not pane_id:
        pause("No target Agent pane was provided.")
        return 1
    if status != "idle":
        pause(f"{agent} is {status}; provider switching requires Idle.")
        return 1
    if shutil.which("cc-switch") is None:
        pause("cc-switch is not available on PATH.")
        return 1

    try:
        db_app, cli_app = require_supported_app(agent)
    except RuntimeError as error:
        pause(str(error))
        return 1
    try:
        providers = load_providers(db_app)
    except RuntimeError as error:
        pause(str(error))
        return 1
    if not providers:
        pause(f"No CC Switch providers are configured for {agent}.")
        return 1

    selected = next(
        (index for index, provider in enumerate(providers) if provider["current"]),
        0,
    )
    while True:
        draw(agent, providers, selected)
        key = read_key()
        if key == "escape":
            return 0
        if key == "up":
            selected = (selected - 1) % len(providers)
        elif key == "down":
            selected = (selected + 1) % len(providers)
        elif key == "enter":
            break

    provider = providers[selected]
    clear()
    print(f"Switching {agent} to {provider['name']}...")
    sys.stdout.flush()
    switched = subprocess.run(
        ["cc-switch", "--app", cli_app, "provider", "switch", provider["id"]],
        check=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    if switched.returncode != 0:
        pause((switched.stdout or "CC Switch failed").strip())
        return switched.returncode

    restarted = subprocess.run(
        [herdr_bin(), "agent", "restart", pane_id],
        check=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    if restarted.returncode != 0:
        pause((restarted.stdout or "Herdr could not restart the Agent").strip())
        return restarted.returncode

    print(f"Provider switched to {provider['name']}. Agent restart scheduled.")
    sys.stdout.flush()
    return 0


def main() -> int:
    if len(sys.argv) != 2 or sys.argv[1] not in {
        "open",
        "menu",
        "add-open",
        "add",
        "export-open",
        "export",
    }:
        print(
            "usage: plugin.py <open|menu|add-open|add|export-open|export>",
            file=sys.stderr,
        )
        return 2
    command = sys.argv[1]
    if command == "open":
        return open_picker()
    if command == "menu":
        return run_menu()
    if command == "add-open":
        return open_add_provider()
    if command == "add":
        return run_add_provider()
    if command == "export-open":
        return open_export()
    return run_export()


if __name__ == "__main__":
    raise SystemExit(main())

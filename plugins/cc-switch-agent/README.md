# CC Switch Agent

Herdr plugin that uses a fork of **cc-switch** CLI against local Agent panes.

## Install

Requirements: `herdr` and `cc-switch` on `PATH` (Python 3.11+ for the plugin).

From GitHub (after this directory is on `master`):

```bash
herdr plugin install starofkuku/herdr/plugins/cc-switch-agent
# non-interactive:
herdr plugin install starofkuku/herdr/plugins/cc-switch-agent --yes
```

Local development (checkout of this repo):

```bash
herdr plugin link /path/to/herdr/plugins/cc-switch-agent
```

If a local link already exists, unlink or uninstall it before a GitHub install:

```bash
herdr plugin unlink local.cc-switch-agent
# or
herdr plugin uninstall local.cc-switch-agent
```

Uninstall a GitHub-managed install:

```bash
herdr plugin uninstall starofkuku/herdr/plugins/cc-switch-agent
# or by id:
herdr plugin uninstall local.cc-switch-agent
```

## Actions

| Context menu title | Action id | Behavior |
|---|---|---|
| Switch Agent provider | `switch` | Overlay provider picker → `cc-switch provider switch` → `herdr agent restart` |
| Add provider | `add-provider` | Overlay → interactive `cc-switch --app <app> provider add` wizard |
| Export current session | `export-session` | Overlay → `cc-switch sessions export` (by session id or picker) |

Both actions declare `contexts = ["pane"]`, so they appear on Agent pane
right-click menus (Herdr 0.7.8+).

## Supported apps (dynamic)

The plugin does **not** hardcode the live app set. At runtime it runs:

```bash
cc-switch apps list
# example:
# claude, codex, gemini, open-code, hermes, open-claw, pi, grok
```

An action is allowed only when:

1. The pane’s Herdr `agent` label has a known mapping to a cc-switch `--app`, and
2. That `--app` appears in `cc-switch apps list`.

Herdr label → `(DB app_type, --app)` mapping currently in `plugin.py`:

| Herdr `agent` | DB / providers | `cc-switch --app` |
|---|---|---|
| `claude` | `claude` | `claude` |
| `codex` | `codex` | `codex` |
| `gemini` | `gemini` | `gemini` |
| `opencode` | `opencode` | `open-code` |
| `openclaw` | `openclaw` | `open-claw` |
| `hermes` | `hermes` | `hermes` |
| `pi` | `pi` | `pi` |
| `grok` | `grok` | `grok` |

If cc-switch adds a new app, extend the mapping once; the live allow-list still comes from `apps list`.

## Switch providers

Requirements:

- `cc-switch` on `PATH`
- Python 3.11 or newer
- the Herdr build that provides `herdr agent restart`
- mapped agent present in `cc-switch apps list`
- pane status must be **Idle**

## Add provider (添加渠道)

Opens the same interactive wizard as:

```bash
cc-switch --app <app> provider add
```

`<app>` is derived from the focused pane’s Herdr agent label and checked against
`cc-switch apps list`. Stdio is not captured so the TTY wizard works inside the
overlay. Does **not** require Idle and does **not** auto-switch or restart the
agent after add — use **Switch Agent provider** when you want the new channel
active on the pane.

Optional keybinding:

```toml
[[keys.command]]
key = "prefix+a"
type = "plugin_action"
command = "local.cc-switch-agent.add-provider"
description = "add Agent provider channel"
```

## Export current session

### How Herdr session ids work

When an agent is installed with the **official Herdr integration** (hooks /
plugins that call `pane.report_agent_session` / `pane.report-agent` with
`agent_session_id`), Herdr stores that native session on the pane/terminal.

That same stored session is what enables **resume**:

- `herdr agent restart <pane>` rebuilds argv like `codex resume <id>` /
  `claude --resume <id>` from the reported session.
- Closing Herdr and reopening the session restores the saved `agent_session`
  snapshot and can resume the same native conversation when the agent process
  is started again.

If the integration is missing or has not reported yet, `herdr agent get`
shows no `agent_session` field (common for agents without hooks, or before the
first report).

### Export flow

1. Read focused pane from `HERDR_PLUGIN_CONTEXT_JSON`.
2. Call `herdr agent get <pane_id>`.
3. **If** `agent_session.kind == "id"` is present → non-interactive:

```bash
cc-switch --app <app> sessions export --id <session-id> -o <path>
```

4. **Else** (no integration / no session id) → interactive picker in the
   overlay (same as `cc-switch --app <app> sessions export`):

```bash
cc-switch --app <app> sessions export
```

   Run with cwd = pane/workspace directory so the default filename lands there.
   You pick the session in the terminal UI (↑/↓, Enter, Esc).

Default non-interactive output path:

```text
<pane-cwd>/ccswitch-<app>-<id8>-<YYYYMMDD>.json
```

Override the directory with `CC_SWITCH_EXPORT_DIR`.

Export does **not** require Idle.

See `sessions-export.md` in the herdr checkout for the fork CLI contract.

## Install

Link the local plugin from this repo:

```bash
herdr plugin link /path/to/herdr/plugins/cc-switch-agent
```

After editing the manifest, re-link or restart the Herdr server so the new
action is loaded into the session plugin registry.

Optional keybindings in `config.toml`:

```toml
[[keys.command]]
key = "prefix+m"
type = "plugin_action"
command = "local.cc-switch-agent.switch"
description = "switch Agent provider"

[[keys.command]]
key = "prefix+e"
type = "plugin_action"
command = "local.cc-switch-agent.export-session"
description = "export current Agent session"
```

## Privacy

Provider switch reads Provider names and default models from the local CC Switch
SQLite database and never displays, copies, or changes API keys.

Session export writes a normalized `ccswitch-session` JSON (user/assistant text
only). The file may include `sourcePath` and `projectDir`; strip those before
sharing if needed.

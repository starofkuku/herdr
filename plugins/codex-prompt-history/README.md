# Codex Prompt History

This Herdr plugin searches submitted text prompts from the current Codex
session and inserts a selected prompt into the Codex input area without
submitting it.

## Install

From a checkout of this repository:

```bash
herdr plugin link /path/to/herdr/plugins/codex-prompt-history
```

The plugin runs on the Herdr server host. For a remote Herdr session, install
or link it on the remote machine, because that machine owns the Codex pane,
Herdr socket, and Codex rollout files.

Requirements:

- Herdr 0.7.11 or newer
- Python 3.11 or newer
- Codex sessions stored under `$CODEX_HOME/sessions` or `~/.codex/sessions`
- Linux or macOS

## Use

The action is available from an Agent pane's context menu as **Search Codex
prompt history**. It opens a temporary overlay:

1. Type to fuzzy-search submitted prompts from the current Codex session.
2. Use Up/Down to select a result.
3. Press Enter to insert the selected text into Codex without pressing Enter
   in the Codex pane.
4. Press Escape to cancel.

Optional keybinding:

```toml
[[keys.command]]
key = "prefix+e"
type = "plugin_action"
command = "local.codex-prompt-history.open"
description = "search Codex prompt history"
```

On macOS, a direct `command+e` binding can be captured by the outer terminal
or remote terminal chain. `prefix+e` is the reliable fallback.

## Scope and limitations

- Only already-submitted text prompts in the current Codex rollout are shown;
  the current unsent draft cannot be read reliably through a generic PTY.
- Image attachments are not replayed by this first version. If a prompt also
  contains text, only its text is inserted.
- Insertion is allowed when Codex is `idle` or `blocked`; while it is working,
  the plugin leaves the input untouched to avoid mixing with an active turn.
- This is a terminal-rendered plugin overlay, not a native Herdr modal.

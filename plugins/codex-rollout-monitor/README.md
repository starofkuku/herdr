# Codex rollout monitor

This first-party Herdr plugin watches the rollout JSONL for Codex sessions that
are running inside Herdr. It reports structured pane diagnostics without
changing Herdr's agent lifecycle state or sending input to Codex.

Install it together with the Codex integration:

```bash
herdr integration install codex
```

The user config is written once to the plugin config directory as
`config.toml`. A suspected stall is reported when an active tool or command has
not produced a meaningful rollout event for the configured threshold. Herdr
notifies once per stall episode; any later progress closes that episode.

The file groups runtime thresholds under `[monitor]`, notification behavior
under `[notification]`, and diagnostic presentation under `[diagnostic]`.
`monitor.enabled` pauses monitoring without disabling or unregistering the
plugin service itself.

The monitor runs on the Herdr server host. Remote clients receive only the
structured diagnostic fields that Herdr displays; they do not read or transfer
the raw rollout JSONL. Linux and macOS are supported; native Windows is outside
the current Herdr plugin scope.

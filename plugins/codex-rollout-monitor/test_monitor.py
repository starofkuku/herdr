import json
from pathlib import Path
import tempfile
import unittest

import monitor


def line(event_type, payload, timestamp="2026-08-14T00:00:00Z"):
    return json.dumps({"timestamp": timestamp, "type": event_type, "payload": payload}) + "\n"


class RolloutMonitorTests(unittest.TestCase):
    def test_grouped_config_is_parsed_and_clamped(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "config.toml"
            path.write_text(
                "[monitor]\n"
                "enabled = false\n"
                "silent_after_seconds = 0\n"
                "suspected_stalled_after_seconds = 1\n"
                "startup_grace_seconds = -1\n"
                "poll_interval_ms = 100\n"
                "\n"
                "[notification]\n"
                "enabled = false\n"
                "\n"
                "[diagnostic]\n"
                "include_command = false\n",
                encoding="utf-8",
            )

            config = monitor.parse_config(path)

            self.assertFalse(config["enabled"])
            self.assertEqual(config["silent_after_seconds"], 1)
            self.assertEqual(config["suspected_stalled_after_seconds"], 2)
            self.assertEqual(config["startup_grace_seconds"], 0)
            self.assertEqual(config["poll_interval_ms"], 250)
            self.assertFalse(config["notify"])
            self.assertFalse(config["include_command"])

    def test_grouped_config_overrides_legacy_test_keys(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "config.toml"
            path.write_text(
                "enabled = false\n"
                "notify = false\n"
                "[monitor]\n"
                "enabled = true\n"
                "[notification]\n"
                "enabled = true\n",
                encoding="utf-8",
            )

            config = monitor.parse_config(path)

            self.assertTrue(config["enabled"])
            self.assertTrue(config["notify"])

    def test_standard_command_yield_and_poll_completion(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "rollout.jsonl"
            path.write_text(
                line("response_item", {
                    "type": "function_call",
                    "name": "exec_command",
                    "arguments": json.dumps({"cmd": "cargo test"}),
                    "call_id": "exec-1",
                })
                + line("response_item", {
                    "type": "function_call_output",
                    "call_id": "exec-1",
                    "output": "Process running with session ID 42",
                })
                + line("response_item", {
                    "type": "function_call",
                    "name": "write_stdin",
                    "arguments": json.dumps({"session_id": 42}),
                    "call_id": "poll-1",
                })
                + line("response_item", {
                    "type": "function_call_output",
                    "call_id": "poll-1",
                    "output": "Process exited with code 0",
                }),
                encoding="utf-8",
            )
            tracker = monitor.RolloutTracker("p1", "session", path, 0)
            self.assertTrue(tracker.read_new_events(1_000))
            self.assertIsNone(tracker.current_call())

    def test_custom_exec_and_item_completed_are_supported(self):
        tracker = monitor.RolloutTracker("p1", "session", Path("unused"), 0)
        tracker.apply_event({
            "type": "response_item",
            "payload": {
                "type": "custom_tool_call",
                "name": "exec",
                "input": 'await tools.exec_command({cmd:"cargo test"})',
                "call_id": "exec-2",
            },
        }, 1_000)
        self.assertEqual(tracker.current_call()["name"], "exec")
        tracker.apply_event({
            "type": "event_msg",
            "payload": {"type": "item_completed", "item": {"type": "CommandExecution"}},
        }, 2_000)
        self.assertIsNone(tracker.current_call())

    def test_partial_jsonl_is_held_until_newline(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "rollout.jsonl"
            event = line("event_msg", {"type": "task_started"})
            path.write_bytes(event[:-1].encode())
            tracker = monitor.RolloutTracker("p1", "session", path, 0)
            self.assertFalse(tracker.read_new_events(1_000))
            self.assertFalse(tracker.turn_active)
            with path.open("ab") as handle:
                handle.write(b"\n")
            self.assertTrue(tracker.read_new_events(2_000))
            self.assertTrue(tracker.turn_active)

    def test_non_object_rollout_records_are_ignored(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "rollout.jsonl"
            path.write_text(
                "[]\n" + line("event_msg", {"type": "task_started"}),
                encoding="utf-8",
            )
            tracker = monitor.RolloutTracker("p1", "session", path, 0)

            self.assertTrue(tracker.read_new_events(1_000))
            self.assertTrue(tracker.turn_active)

            meta = Path(temp) / "meta.jsonl"
            meta.write_text("[]\n", encoding="utf-8")
            self.assertFalse(monitor.rollout_matches_session(meta, "session"))

    def test_parent_id_match_rejects_subagent_rollout(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            parent = root / "parent.jsonl"
            child = root / "child.jsonl"
            parent.write_text(line("session_meta", {
                "id": "shared", "session_id": "legacy", "source": "cli", "thread_source": "user"
            }), encoding="utf-8")
            child.write_text(line("session_meta", {
                "id": "shared", "session_id": "shared", "source": "cli",
                "thread_source": {"subagent": {"depth": 1}}
            }), encoding="utf-8")
            self.assertTrue(monitor.rollout_matches_session(parent, "shared"))
            self.assertFalse(monitor.rollout_matches_session(child, "shared"))

    def test_stall_notifies_once_until_progress(self):
        tracker = monitor.RolloutTracker("p1", "session", Path("unused"), 0)
        tracker.active_calls["call"] = {
            "name": "exec_command", "command": "cargo test", "started_ms": 0, "last_activity_ms": 0
        }
        config = dict(monitor.DEFAULTS)
        first, first_notify = tracker.diagnostic(181_000, config)
        second, second_notify = tracker.diagnostic(182_000, config)
        self.assertEqual(first["state"], "suspected_stalled")
        self.assertTrue(first_notify)
        self.assertTrue(second_notify)
        tracker.mark_notified()
        _, third_notify = tracker.diagnostic(182_500, config)
        self.assertFalse(third_notify)
        tracker.active_calls["call"]["last_activity_ms"] = 183_000
        recovered, recovered_notify = tracker.diagnostic(183_000, config)
        self.assertEqual(recovered["state"], "recovered")
        self.assertFalse(recovered_notify)

    def test_initial_replay_clamps_old_activity_to_monitor_start(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "rollout.jsonl"
            path.write_text(
                line("response_item", {
                    "type": "function_call",
                    "name": "exec_command",
                    "arguments": json.dumps({"cmd": "cargo test"}),
                    "call_id": "exec-old",
                }, timestamp="2020-01-01T00:00:00Z"),
                encoding="utf-8",
            )
            started_ms = 2_000_000_000_000
            tracker = monitor.RolloutTracker("p1", "session", path, started_ms)
            self.assertTrue(tracker.read_new_events(started_ms))
            state, _ = tracker.classify(started_ms, dict(monitor.DEFAULTS))
            self.assertEqual(state, "tool_running")


if __name__ == "__main__":
    unittest.main()

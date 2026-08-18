import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest


ROOT = Path(__file__).parent
SPEC = importlib.util.spec_from_file_location("codex_prompt_history", ROOT / "plugin.py")
assert SPEC and SPEC.loader
PLUGIN = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = PLUGIN
SPEC.loader.exec_module(PLUGIN)


class RolloutParsingTests(unittest.TestCase):
    def write_rollout(self, records):
        path = Path(self.tmp.name) / "rollout.jsonl"
        path.write_text("".join(json.dumps(record) + "\n" for record in records), encoding="utf-8")
        return path

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.tmp.cleanup()

    def test_event_messages_are_the_submitted_prompt_source(self):
        path = self.write_rollout(
            [
                {"type": "session_meta", "payload": {"id": "s1"}},
                {
                    "type": "response_item",
                    "payload": {
                        "type": "message",
                        "role": "user",
                        "content": [{"type": "input_text", "text": "context"}],
                    },
                },
                {
                    "timestamp": "2026-01-01T00:00:00Z",
                    "type": "event_msg",
                    "payload": {"type": "user_message", "message": "first prompt"},
                },
                {
                    "type": "event_msg",
                    "payload": {"type": "user_message", "message": "  second\n prompt  "},
                },
            ]
        )
        self.assertEqual(
            [prompt.text for prompt in PLUGIN.parse_rollout(path)],
            ["first prompt", "second\n prompt"],
        )

    def test_legacy_response_items_are_used_only_without_events(self):
        path = self.write_rollout(
            [
                {
                    "type": "response_item",
                    "payload": {
                        "type": "message",
                        "role": "assistant",
                        "content": [{"type": "output_text", "text": "ignore"}],
                    },
                },
                {
                    "type": "response_item",
                    "payload": {
                        "type": "message",
                        "role": "user",
                        "content": [{"type": "input_text", "text": "legacy prompt"}],
                    },
                },
            ]
        )
        self.assertEqual([p.text for p in PLUGIN.parse_rollout(path)], ["legacy prompt"])

    def test_find_rollout_matches_session_meta(self):
        home = Path(self.tmp.name)
        sessions = home / "sessions" / "2026" / "01" / "02"
        sessions.mkdir(parents=True)
        expected = sessions / "rollout-2026-01-02T00-00-00-s1.jsonl"
        expected.write_text(
            json.dumps({"type": "session_meta", "payload": {"id": "s1"}}) + "\n",
            encoding="utf-8",
        )
        result = PLUGIN.find_rollout(home, {"kind": "id", "value": "s1"})
        self.assertEqual(result, expected)


class FuzzyMatchingTests(unittest.TestCase):
    def test_matches_subsequences_and_returns_best_match_first(self):
        prompts = [
            PLUGIN.Prompt("commit and push", 0),
            PLUGIN.Prompt("check status", 1),
            PLUGIN.Prompt("commit then push", 2),
        ]
        result = PLUGIN.fuzzy_matches(prompts, "cp")
        self.assertEqual(result[0].text, "commit and push")
        self.assertEqual([p.text for p in PLUGIN.fuzzy_matches(prompts, "xyz")], [])

    def test_preview_flattens_multiline_text(self):
        self.assertEqual(PLUGIN.compact_preview("one\n two"), "one two")


class ManifestTests(unittest.TestCase):
    def test_manifest_declares_codex_overlay_action(self):
        import tomllib

        manifest = tomllib.loads((ROOT / "herdr-plugin.toml").read_text(encoding="utf-8"))
        self.assertEqual(manifest["id"], "local.codex-prompt-history")
        self.assertEqual(manifest["actions"][0]["contexts"], ["pane"])
        self.assertEqual(manifest["panes"][0]["placement"], "overlay")

    def test_picker_command_preserves_original_pane_id(self):
        command = PLUGIN.picker_open_command("w1:p2")
        self.assertEqual(command[-2:], ["--env", "TARGET_PANE_ID=w1:p2"])


if __name__ == "__main__":
    unittest.main()

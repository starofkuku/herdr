import importlib.util
from pathlib import Path
import unittest
from unittest import mock


SPEC = importlib.util.spec_from_file_location(
    "cc_switch_agent_plugin", Path(__file__).with_name("plugin.py")
)
PLUGIN = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PLUGIN)


class DefaultModelTests(unittest.TestCase):
    def test_claude_model(self):
        self.assertEqual(
            PLUGIN.default_model(
                "claude", {"env": {"ANTHROPIC_MODEL": "claude-sonnet-4-6"}}
            ),
            "claude-sonnet-4-6",
        )

    def test_codex_toml_model(self):
        self.assertEqual(
            PLUGIN.default_model(
                "codex",
                {"config": 'model_provider = "custom"\nmodel = "gpt-5.4"\n'},
            ),
            "gpt-5.4",
        )

    def test_hermes_first_model(self):
        self.assertEqual(
            PLUGIN.default_model(
                "hermes", {"models": [{"id": "openrouter/model"}]}
            ),
            "openrouter/model",
        )

    def test_hermes_direct_model(self):
        self.assertEqual(
            PLUGIN.default_model("hermes", {"model": "mimo-v2.5"}),
            "mimo-v2.5",
        )

    def test_opencode_first_model(self):
        self.assertEqual(
            PLUGIN.default_model(
                "opencode", {"models": {"model-a": {"name": "Model A"}}}
            ),
            "model-a",
        )


class OpenPickerTests(unittest.TestCase):
    @mock.patch.object(PLUGIN.subprocess, "run")
    def test_overlay_open_does_not_pass_target_pane(self, run):
        run.return_value.returncode = 0
        with mock.patch.dict(
            PLUGIN.os.environ,
            {
                "HERDR_BIN_PATH": "/tmp/herdr",
                "HERDR_PLUGIN_ID": "local.cc-switch-agent",
            },
            clear=False,
        ):
            self.assertEqual(PLUGIN.open_picker(), 0)

        argv = run.call_args.args[0]
        self.assertIn("overlay", argv)
        self.assertNotIn("--target-pane", argv)

    @mock.patch.object(PLUGIN.subprocess, "run")
    def test_export_open_uses_session_export_entrypoint(self, run):
        run.return_value.returncode = 0
        with mock.patch.dict(
            PLUGIN.os.environ,
            {
                "HERDR_BIN_PATH": "/tmp/herdr",
                "HERDR_PLUGIN_ID": "local.cc-switch-agent",
            },
            clear=False,
        ):
            self.assertEqual(PLUGIN.open_export(), 0)

        argv = run.call_args.args[0]
        self.assertIn("session-export", argv)
        self.assertIn("overlay", argv)

    @mock.patch.object(PLUGIN.subprocess, "run")
    def test_add_open_uses_provider_add_entrypoint(self, run):
        run.return_value.returncode = 0
        with mock.patch.dict(
            PLUGIN.os.environ,
            {
                "HERDR_BIN_PATH": "/tmp/herdr",
                "HERDR_PLUGIN_ID": "local.cc-switch-agent",
            },
            clear=False,
        ):
            self.assertEqual(PLUGIN.open_add_provider(), 0)

        argv = run.call_args.args[0]
        self.assertIn("provider-add", argv)
        self.assertIn("overlay", argv)


class AppsListTests(unittest.TestCase):
    def test_parse_apps_list(self):
        self.assertEqual(
            PLUGIN.parse_apps_list(
                "claude, codex, gemini, open-code, hermes, open-claw, pi, grok"
            ),
            {
                "claude",
                "codex",
                "gemini",
                "open-code",
                "hermes",
                "open-claw",
                "pi",
                "grok",
            },
        )

    def test_herdr_opencode_maps_to_open_code(self):
        self.assertEqual(
            PLUGIN.resolve_cc_switch_app("opencode"),
            ("opencode", "open-code"),
        )

    def test_require_supported_app_uses_live_list(self):
        with mock.patch.object(
            PLUGIN,
            "list_cc_switch_apps",
            return_value={"claude", "codex", "open-code", "grok"},
        ):
            self.assertEqual(
                PLUGIN.require_supported_app("opencode"),
                ("opencode", "open-code"),
            )
            self.assertEqual(
                PLUGIN.require_supported_app("grok"),
                ("grok", "grok"),
            )

    def test_require_supported_app_rejects_missing_from_list(self):
        with mock.patch.object(
            PLUGIN, "list_cc_switch_apps", return_value={"claude"}
        ):
            with self.assertRaises(RuntimeError) as ctx:
                PLUGIN.require_supported_app("codex")
            self.assertIn("does not list app", str(ctx.exception))


class SessionExportHelpersTests(unittest.TestCase):
    def test_session_id_from_agent_path_kind_is_unavailable(self):
        self.assertIsNone(
            PLUGIN.session_id_from_agent(
                {"agent_session": {"kind": "path", "value": "/tmp/session"}}
            )
        )

    def test_session_id_from_agent_missing_is_none(self):
        self.assertIsNone(PLUGIN.session_id_from_agent({}))

    def test_session_id_from_agent_reads_value(self):
        self.assertEqual(
            PLUGIN.session_id_from_agent(
                {
                    "agent_session": {
                        "kind": "id",
                        "value": "019f5a43-4f04-7950-83a8-b55a56fc6e27",
                    }
                }
            ),
            "019f5a43-4f04-7950-83a8-b55a56fc6e27",
        )

    def test_export_filename_uses_id_prefix_and_date(self):
        name = PLUGIN.export_filename(
            "open-code", "019f5a43-4f04-7950-83a8-b55a56fc6e27"
        )
        self.assertTrue(name.startswith("ccswitch-open-code-019f5a43-"))
        self.assertTrue(name.endswith(".json"))

    @mock.patch.object(PLUGIN, "pause")
    @mock.patch.object(PLUGIN.shutil, "which", return_value="/usr/bin/cc-switch")
    @mock.patch.object(
        PLUGIN,
        "list_cc_switch_apps",
        return_value={"codex", "claude", "open-code", "grok"},
    )
    @mock.patch.object(PLUGIN, "load_agent_info")
    @mock.patch.object(PLUGIN.subprocess, "run")
    def test_run_export_invokes_cc_switch_with_id(
        self, run, load_agent_info, _apps, _which, pause
    ):
        load_agent_info.return_value = {
            "agent": "codex",
            "cwd": "/tmp",
            "agent_session": {
                "kind": "id",
                "value": "019f5a43-4f04-7950-83a8-b55a56fc6e27",
            },
        }
        run.return_value = mock.Mock(returncode=0, stdout="ok\n")
        with mock.patch.dict(
            PLUGIN.os.environ,
            {
                "HERDR_PLUGIN_CONTEXT_JSON": (
                    '{"focused_pane_id":"w9:p1","focused_pane_agent":"codex"}'
                ),
                "CC_SWITCH_EXPORT_DIR": "/tmp",
            },
            clear=False,
        ):
            self.assertEqual(PLUGIN.run_export(), 0)

        argv = run.call_args.args[0]
        self.assertEqual(
            argv[:6],
            ["cc-switch", "--app", "codex", "sessions", "export", "--id"],
        )
        self.assertEqual(argv[6], "019f5a43-4f04-7950-83a8-b55a56fc6e27")
        self.assertEqual(argv[7], "-o")
        self.assertTrue(argv[8].startswith("/tmp/ccswitch-codex-019f5a43-"))
        pause.assert_called_once()

    @mock.patch.object(PLUGIN, "pause")
    @mock.patch.object(PLUGIN.shutil, "which", return_value="/usr/bin/cc-switch")
    @mock.patch.object(
        PLUGIN,
        "list_cc_switch_apps",
        return_value={"codex", "claude", "grok"},
    )
    @mock.patch.object(PLUGIN, "load_agent_info")
    @mock.patch.object(PLUGIN.subprocess, "run")
    def test_run_add_provider_invokes_interactive_wizard(
        self, run, load_agent_info, _apps, _which, pause
    ):
        load_agent_info.return_value = {"agent": "codex", "cwd": "/tmp"}
        run.return_value = mock.Mock(returncode=0)
        with mock.patch.dict(
            PLUGIN.os.environ,
            {
                "HERDR_PLUGIN_CONTEXT_JSON": (
                    '{"focused_pane_id":"w9:p1","focused_pane_agent":"codex"}'
                ),
            },
            clear=False,
        ):
            self.assertEqual(PLUGIN.run_add_provider(), 0)

        argv = run.call_args.args[0]
        self.assertEqual(
            argv, ["cc-switch", "--app", "codex", "provider", "add"]
        )
        # Interactive wizard must keep TTY (no stdout capture).
        self.assertNotIn("stdout", run.call_args.kwargs)
        pause.assert_called_once()

    @mock.patch.object(PLUGIN, "pause")
    @mock.patch.object(PLUGIN.shutil, "which", return_value="/usr/bin/cc-switch")
    @mock.patch.object(
        PLUGIN,
        "list_cc_switch_apps",
        return_value={"grok", "codex", "claude"},
    )
    @mock.patch.object(PLUGIN, "load_agent_info")
    @mock.patch.object(PLUGIN.subprocess, "run")
    def test_run_export_falls_back_to_interactive_picker(
        self, run, load_agent_info, _apps, _which, pause
    ):
        load_agent_info.return_value = {
            "agent": "grok",
            "cwd": "/tmp",
        }
        run.return_value = mock.Mock(returncode=0)
        with mock.patch.dict(
            PLUGIN.os.environ,
            {
                "HERDR_PLUGIN_CONTEXT_JSON": (
                    '{"focused_pane_id":"w7:p1","focused_pane_agent":"grok"}'
                ),
            },
            clear=False,
        ):
            self.assertEqual(PLUGIN.run_export(), 0)

        argv = run.call_args.args[0]
        self.assertEqual(
            argv, ["cc-switch", "--app", "grok", "sessions", "export"]
        )
        self.assertNotIn("--id", argv)
        self.assertNotIn("stdout", run.call_args.kwargs)
        self.assertEqual(run.call_args.kwargs.get("cwd"), "/tmp")
        pause.assert_called_once()


if __name__ == "__main__":
    unittest.main()

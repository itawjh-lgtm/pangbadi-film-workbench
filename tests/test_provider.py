"""Protocol and lifecycle checks; fake CLI scripts do not call any model."""
import json
import os
from pathlib import Path
import signal
import sys
import tempfile
import threading
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server.provider import CodexProvider, DISABLED_FEATURES, ProviderError


class ProviderTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="studio-provider-test-")
        self.root = Path(self.temp.name)
        self.workdir = self.root / "isolated"
        self.workdir.mkdir()

    def tearDown(self):
        self.temp.cleanup()

    def provider(self, program, timeout=2):
        executable = self.root / "fake-codex"
        executable.write_text("#!" + sys.executable + "\n" + program, encoding="utf-8")
        executable.chmod(0o700)
        return CodexProvider(str(executable), model="test-model", timeout=timeout, health_timeout=2)

    def generate(self, provider, **kwargs):
        return provider.generate("角色仅负责文稿", "写一句中文", self.workdir, **kwargs)

    def test_final_response_filters_reasoning_and_reports_usage(self):
        provider = self.provider('''import json, sys
sys.stdin.read()
for event in [
 {"type":"turn.started"},
 {"type":"item.completed","item":{"type":"reasoning","text":"private-reasoning"}},
 {"type":"item.completed","item":{"type":"error","message":"Skill descriptions were shortened to fit the skills context budget."}},
 {"type":"item.completed","item":{"type":"agent_message","text":"初步答复"}},
 {"type":"item.completed","item":{"type":"agent_message","text":"最终剧本\\n第一幕"}},
 {"type":"turn.completed","usage":{"input_tokens":9,"output_tokens":4,"reasoning_output_tokens":99,"token":"credential"}}
]: print(json.dumps(event), flush=True)
''')
        events = []
        result = self.generate(provider, on_event=events.append)
        self.assertEqual(result["text"], "最终剧本\n第一幕")
        self.assertEqual(result["usage"], {"input_tokens":9, "output_tokens":4})
        self.assertEqual(result["model"], "test-model")
        rendered = json.dumps(events)
        self.assertNotIn("private-reasoning", rendered)
        self.assertNotIn("credential", rendered)
        self.assertNotIn("Skill descriptions", rendered)
        self.assertNotIn("reasoning_output_tokens", rendered)
        self.assertEqual(events[-1]["type"], "completed")

    def test_prompt_is_stdin_and_command_disables_tools(self):
        provider = self.provider('''import json, sys
request = sys.stdin.read()
print(json.dumps({"type":"item.completed","item":{"type":"agent_message","text":json.dumps({"argv":sys.argv[1:],"input":request})}}))
print('{"type":"turn.completed"}')
''')
        prompt = "$(touch /tmp/forbidden); `echo nope` 中文"
        result = provider.generate("可信角色配置", prompt, self.workdir)
        capture = json.loads(result["text"])
        args = capture["argv"]
        self.assertEqual(capture["input"], "# 本轮角色配置\n可信角色配置\n\n# 本轮任务与项目材料\n" + prompt)
        self.assertNotIn(prompt, args)
        self.assertFalse(any("可信角色配置" in argument for argument in args))
        self.assertEqual(args[-1], "-")
        for flag in ("--ephemeral", "--ignore-user-config", "--json", "--skip-git-repo-check"):
            self.assertIn(flag, args)
        self.assertEqual(args[args.index("--sandbox")+1], "read-only")
        for feature in DISABLED_FEATURES:
            self.assertIn(feature, args)
        self.assertIn('web_search="disabled"', args)
        self.assertIn("tools.view_image=false", args)

    def test_partial_output_or_failed_turn_never_counts_as_success(self):
        provider = self.provider('''import sys
sys.stdin.read()
print('{"type":"item.completed","item":{"type":"agent_message","text":"只写一半"}}')
''')
        with self.assertRaises(ProviderError) as context:
            self.generate(provider)
        self.assertEqual(context.exception.code, "incomplete_output")
        provider = self.provider('''import sys
sys.stdin.read()
print('{"type":"turn.failed","error":{"message":"rate limit sk-private-secret"}}')
''')
        with self.assertRaises(ProviderError) as context:
            self.generate(provider)
        self.assertEqual(context.exception.code, "rate_limit")
        self.assertNotIn("secret", str(context.exception))

    def test_unexpected_tool_aborts_without_forwarding_contents(self):
        provider = self.provider('''import sys, time
sys.stdin.read()
print('{"type":"item.started","item":{"type":"command_execution","command":"secret-command"}}',flush=True)
time.sleep(20)
''')
        events = []
        with self.assertRaises(ProviderError) as context:
            self.generate(provider, on_event=events.append)
        self.assertEqual(context.exception.code, "unexpected_tool")
        self.assertNotIn("secret-command", json.dumps(events))

    def test_cancel_and_timeout_kill_launcher_and_child(self):
        for cancel in (False, True):
            with self.subTest(cancel=cancel):
                pid_file = self.root / ("child-cancel" if cancel else "child-timeout")
                program = '''import subprocess, sys, time
sys.stdin.read()
child=subprocess.Popen([sys.executable,"-c","import time; time.sleep(30)"])
from pathlib import Path
Path(%s).write_text(str(child.pid))
print('{"type":"turn.started"}',flush=True)
time.sleep(30)
''' % repr(str(pid_file))
                provider = self.provider(program, timeout=1.2 if not cancel else 3)
                event = threading.Event()
                started = time.monotonic()
                with self.assertRaises(ProviderError) as context:
                    self.generate(provider, cancel_event=event,
                                  on_event=lambda update: event.set() if cancel and update["type"] == "status" else None)
                self.assertEqual(context.exception.code, "cancelled" if cancel else "timeout")
                self.assertLess(time.monotonic()-started, 2.5)
                self.assertTrue(pid_file.exists())
                pid = int(pid_file.read_text())
                # Reparented process reaping can be briefly delayed on macOS.
                for _ in range(30):
                    try: os.kill(pid, 0)
                    except ProcessLookupError: break
                    time.sleep(.02)
                else:
                    self.fail("Provider left its child process alive")

    def test_cancel_before_start_and_invalid_workdir(self):
        provider = CodexProvider(binary="/definitely/not/a/program")
        event = threading.Event()
        event.set()
        with self.assertRaises(ProviderError) as context:
            self.generate(provider, cancel_event=event)
        self.assertEqual(context.exception.code, "cancelled")
        with self.assertRaises(ProviderError) as context:
            provider.generate("角色", "任务", self.root / "missing")
        self.assertEqual(context.exception.code, "invalid_workdir")

    def test_health_never_returns_raw_credentials(self):
        provider = self.provider('''import sys
print("Logged in using ChatGPT", file=sys.stderr)
print("Bearer private-value", file=sys.stderr)
''')
        result = provider.health()
        self.assertTrue(result["authenticated"])
        self.assertTrue(result["available"])
        self.assertNotIn("private-value", json.dumps(result))
        provider = self.provider("import time; time.sleep(30)")
        provider.health_timeout = .25
        self.assertFalse(provider.health()["authenticated"])
        self.assertFalse(CodexProvider(binary="/does/not/exist").health()["available"])

    def test_no_api_keys_or_thread_handles_are_inherited(self):
        provider = CodexProvider()
        before = os.environ.get("OPENAI_API_KEY")
        os.environ["OPENAI_API_KEY"] = "test-only"
        try:
            environment = provider._environment()
            self.assertNotIn("OPENAI_API_KEY", environment)
            self.assertNotIn("CODEX_APP_TOOLS_PIPE_PATH", environment)
            self.assertNotIn("CODEX_THREAD_ID", environment)
        finally:
            if before is None: os.environ.pop("OPENAI_API_KEY", None)
            else: os.environ["OPENAI_API_KEY"] = before


if __name__ == "__main__":
    unittest.main()

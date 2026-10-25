import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from server import httpd


class PortableStartTests(unittest.TestCase):
    def test_default_arguments_preserve_existing_service_and_role_paths(self):
        args = httpd.parse_args([])
        self.assertEqual(args.port, 8767)
        self.assertEqual(args.data_dir, httpd.ROOT / "data" / "runtime")
        self.assertIsNone(args.film_dir)
        self.assertIsNone(args.game_dir)

    def test_custom_role_paths_are_parsed_without_rewriting_spaces_or_unicode(self):
        args = httpd.parse_args([
            "--port", "8768", "--data-dir", "/tmp/便携 工作台/data",
            "--film-dir", "/tmp/便携 工作台/prompts/影视Agent团队提示词",
            "--game-dir", "/tmp/便携 工作台/prompts/游戏Agent团队提示词",
        ])
        self.assertEqual(args.port, 8768)
        self.assertEqual(args.film_dir, Path("/tmp/便携 工作台/prompts/影视Agent团队提示词"))
        self.assertEqual(args.game_dir, Path("/tmp/便携 工作台/prompts/游戏Agent团队提示词"))

    def test_main_passes_custom_paths_to_catalog_without_starting_generation(self):
        with tempfile.TemporaryDirectory() as temp:
            film = Path(temp) / "影视 提示词"
            game = Path(temp) / "游戏 提示词"
            catalog = Mock()
            server = Mock()
            with patch.object(httpd, "StudioServer", return_value=server), \
                 patch.object(httpd, "RoleCatalog", return_value=catalog) as factory, \
                 patch.object(httpd, "CodexProvider", return_value=Mock()), \
                 patch.object(httpd, "Runtime", side_effect=RuntimeError("stop-before-initialization")) as runtime:
                with self.assertRaisesRegex(RuntimeError, "stop-before-initialization"):
                    httpd.main(["--data-dir", temp, "--film-dir", str(film), "--game-dir", str(game)])
                factory.assert_called_once_with(film_dir=film, game_dir=game)
                self.assertIs(runtime.call_args.args[1], catalog)
                server.serve_forever.assert_not_called()
                server.server_close.assert_called_once()

    def test_launcher_resolves_its_own_folder_and_passes_isolated_paths(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "便携 工作台"
            (root / "scripts").mkdir(parents=True)
            for team in ("影视Agent团队提示词", "游戏Agent团队提示词"):
                (root / "prompts" / team).mkdir(parents=True)
            script = root / "scripts" / "start-portable.command"
            shutil.copyfile(httpd.ROOT / "scripts" / script.name, script)
            capture = Path(temp) / "arguments.txt"
            interpreter = Path(temp) / "fake-python"
            interpreter.write_text('#!/bin/sh\nprintf "%s\\n" "$@" > "$PORTABLE_CAPTURE"\n', encoding="utf-8")
            interpreter.chmod(0o700)
            env = {**os.environ, "STUDIO_PYTHON": str(interpreter), "PORTABLE_CAPTURE": str(capture)}
            env.pop("STUDIO_PORT", None)
            result = subprocess.run(["bash", str(script)], cwd=temp, env=env, capture_output=True, text=True, check=True)
            self.assertIn("http://127.0.0.1:8768/", result.stdout)
            self.assertEqual(capture.read_text().splitlines(), [
                "-m", "server.httpd", "--port", "8768",
                "--data-dir", str(root / "data" / "portable-runtime"),
                "--film-dir", str(root / "prompts" / "影视Agent团队提示词"),
                "--game-dir", str(root / "prompts" / "游戏Agent团队提示词"),
            ])


if __name__ == "__main__":
    unittest.main()

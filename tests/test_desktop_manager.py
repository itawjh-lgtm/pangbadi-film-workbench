import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch

from desktop import service_manager as manager


class DesktopManagerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "server").mkdir()
        (self.root / "server/httpd.py").touch()
        (self.root / "index.html").touch()
        self.good = {"ok": True, "service": "dream-studio-runtime", "version": "0.6",
                     "projectId": manager.identity(self.root), "pid": 321}

    def test_reuses_same_project_without_launching(self):
        with patch.object(manager, "health", return_value=self.good), patch.object(manager.subprocess, "Popen") as launch:
            answer = manager.ensure(self.root, 8767)
        self.assertTrue(answer["ok"])
        self.assertFalse(answer["owned"])
        launch.assert_not_called()

    def test_other_project_and_old_versions_are_not_replaced(self):
        for data in ({**self.good, "projectId": "other"}, {**self.good, "version": "0.4"}, {"service": "dream-studio-runtime", "version": "0.4"}):
            with patch.object(manager, "health", return_value=data), patch.object(manager.subprocess, "Popen") as launch:
                self.assertFalse(manager.ensure(self.root, 8767)["ok"])
                launch.assert_not_called()

    def test_busy_port_is_not_touched(self):
        with patch.object(manager, "health", return_value=None), patch.object(manager, "occupied", return_value=True), patch.object(manager.subprocess, "Popen") as launch:
            answer = manager.ensure(self.root, 8767)
        self.assertFalse(answer["ok"])
        self.assertIn("占用", answer["reason"])
        launch.assert_not_called()

    def test_missing_project_has_actionable_error(self):
        answer = manager.ensure(self.root / "missing", 8767)
        self.assertFalse(answer["ok"])
        self.assertIn("文件夹", answer["reason"])

    def test_starts_detached_and_reports_verified_identity(self):
        with patch.object(manager, "health", side_effect=[None, self.good]), patch.object(manager, "occupied", return_value=False), patch.object(manager.subprocess, "Popen") as launch:
            answer = manager.ensure(self.root, 8767)
        self.assertTrue(answer["ok"])
        self.assertTrue(answer["owned"])
        self.assertEqual(answer["pid"], 321)
        self.assertTrue(launch.call_args.kwargs["start_new_session"])
        self.assertEqual(launch.call_args.kwargs["cwd"], self.root.resolve())


if __name__ == "__main__":
    unittest.main()

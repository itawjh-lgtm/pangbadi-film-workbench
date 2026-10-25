import json
import tempfile
import threading
import time
import unittest
from pathlib import Path

from server.runtime import InputError, Runtime


class Catalog:
    def get_role(self, key):
        if key not in ["R03", "R04", "R11", "G01"]:
            raise KeyError(key)
        return dict(id=key, name=key, available=True, hash="role-hash", shared_hash="shared-hash", version="2", source="source.md")

    def build_instructions(self, key):
        return "FULL_SHARED + FULL_ROLE:" + key


class Provider:
    def __init__(self):
        self.calls = []
        self.wait = False
        self.failure = False

    def health(self):
        return {"available": True, "authenticated": True}

    def generate(self, instructions, prompt, workdir, cancel_event=None):
        self.calls.append((instructions, prompt, str(workdir)))
        if self.failure:
            raise RuntimeError("测试失败")
        while self.wait and not cancel_event.is_set():
            time.sleep(.01)
        if cancel_event.is_set():
            raise RuntimeError("cancelled")
        return {"text": "# 完整交付\n" + "长正文" * 4500, "usage": {"output_tokens": 17}}


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.provider = Provider()
        self.runtime = Runtime(self.temp.name, Catalog(), self.provider)

    def tearDown(self):
        self.runtime.close()
        for _ in range(100):
            if not self.runtime.cancel_events:
                break
            time.sleep(.01)
        self.temp.cleanup()

    def payload(self, **updates):
        result = dict(requestId="request-one", mode="produce", peerId="R03", project=None, agentIds=["R03"], prompt="写一个短剧", history=[], inputArtifacts=[])
        result.update(updates)
        return result

    def wait(self, run):
        for _ in range(200):
            result = self.runtime.get("run", run["id"])
            if result["status"] not in ("queued", "running"):
                return result
            time.sleep(.01)
        self.fail("run did not finish")

    def test_full_text_persists_and_no_acceptance_is_forged(self):
        run = self.wait(self.runtime.start(self.payload()))
        self.assertEqual(run["status"], "succeeded")
        artifact = run["artifacts"][0]
        self.assertGreater(len(artifact["body"]), 12000)
        self.assertEqual(artifact["reviewStatus"], "pending")
        self.assertEqual(self.runtime.artifact(artifact["id"])["body"], artifact["body"])
        restored = Runtime(self.temp.name, Catalog(), Provider())
        self.assertEqual(restored.get("run", run["id"]), run)
        restored.close()
        self.assertIn("FULL_SHARED", self.provider.calls[0][0])

    def test_idempotence_and_same_scope_busy(self):
        self.provider.wait = True
        run = self.runtime.start(self.payload())
        self.assertEqual(self.runtime.start(self.payload())["id"], run["id"])
        with self.assertRaises(InputError) as error:
            self.runtime.start(self.payload(requestId="second"))
        self.assertEqual(error.exception.status, 409)
        self.runtime.cancel(run["id"])

    def test_dm_cannot_include_project_or_task_context(self):
        for extra in ({"project": {"id": "secret"}}, {"tasks": [{"title": "secret"}]}, {"agentIds": ["R03", "R04"]}):
            with self.assertRaises(InputError):
                self.runtime.start(self.payload(**extra))

    def test_dependency_and_decision_gate(self):
        project = dict(id="p", kind="film", members=["R03", "R04"])
        task = dict(id="t", projectId="p", ownerId="R03", reviewerId="R04", dependencies=["up"])
        data = self.payload(peerId=None, project=project, task=task)
        with self.assertRaises(InputError):
            self.runtime.start(data)
        data["tasks"] = [dict(id="up", projectId="p", status="done", evidence="已保存稿件", reviewNote="本轮已复核")]
        task["decisionId"] = "d"
        with self.assertRaises(InputError):
            self.runtime.start(data)
        data["decisions"] = [dict(id="d", projectId="p", status="approved")]
        self.assertEqual(self.wait(self.runtime.start(data))["status"], "succeeded")
        self.assertNotIn("status", task)

    def test_team_order_and_real_handoff(self):
        data = self.payload(peerId=None, project=dict(id="p", kind="film", members=["R03", "R04"]), agentIds=["R03", "R04"], mode="team")
        run = self.wait(self.runtime.start(data))
        self.assertEqual([a["authorId"] for a in run["artifacts"]], ["R03", "R04"])
        self.assertIn(run["artifacts"][0]["hash"], self.provider.calls[1][1])
        self.assertIn("完整交付", self.provider.calls[1][1])

    def test_cancel_retains_terminal_status(self):
        self.provider.wait = True
        run = self.runtime.start(self.payload())
        self.runtime.cancel(run["id"])
        time.sleep(.05)
        result = self.runtime.get("run", run["id"])
        self.assertEqual(result["status"], "cancelled")
        self.assertEqual(result["artifacts"], [])

    def test_failure_skips_following_roles(self):
        self.provider.failure = True
        data = self.payload(peerId=None, project=dict(id="p", kind="film", members=["R03", "R04"]), agentIds=["R03", "R04"])
        result = self.wait(self.runtime.start(data))
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["steps"][1]["status"], "skipped")
        self.assertEqual(result["artifacts"], [])

    def test_restart_marks_unfinished_run_failed(self):
        self.provider.wait = True
        run = self.runtime.start(self.payload())
        self.runtime.cancel(run["id"])
        time.sleep(.05)
        interrupted = self.runtime.get("run", run["id"])
        interrupted["status"] = "running"
        interrupted["steps"][0]["status"] = "running"
        self.runtime.save("run", interrupted)
        restored = Runtime(self.temp.name, Catalog(), Provider())
        result = restored.get("run", run["id"])
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["steps"][0]["status"], "interrupted")
        restored.close()

    def test_service_close_cancels_active_work_and_waits_for_cleanup(self):
        self.provider.wait = True
        run = self.runtime.start(self.payload())
        self.runtime.close()
        self.assertEqual(self.runtime.get("run", run["id"])["status"], "cancelled")
        self.assertEqual(self.runtime.cancel_events, {})


if __name__ == "__main__":
    unittest.main()

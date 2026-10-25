"""Regression checks for execution boundaries found during runtime review."""
import copy
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from server import httpd
from server.runtime import InputError, Runtime


class ReviewCatalog:
    def get_role(self, agent):
        if agent not in ("R03", "R04", "R11", "G01"):
            raise KeyError(agent)
        return {"id": agent, "name": agent, "available": True, "hash": "role",
                "shared_hash": "shared", "version": "test", "source": "local-role.md"}

    def build_instructions(self, agent):
        return "Role " + agent


class ReviewProvider:
    def __init__(self):
        self.calls = []
        self.entered = threading.Event()
        self.release = threading.Event()
        self.release.set()

    def health(self):
        return {"available": True, "authenticated": True}

    def generate(self, instructions, prompt, workdir, cancel_event=None):
        self.calls.append(prompt)
        self.entered.set()
        self.release.wait(2)
        # Deliberately return after cancellation to exercise the server's guard.
        return {"text": "可核对的文字成果", "usage": {"output_tokens": 5}}


class RuntimeReviewTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="studio-runtime-boundary-")
        self.provider = ReviewProvider()
        self.runtime = Runtime(self.temp.name, ReviewCatalog(), self.provider)

    def tearDown(self):
        self.runtime.close()
        self.provider.release.set()
        deadline = time.monotonic() + 3
        while self.runtime.cancel_events and time.monotonic() < deadline:
            time.sleep(.01)
        self.runtime.db.close()
        self.temp.cleanup()

    def payload(self, **changes):
        data = {"requestId": "boundary-test", "mode": "produce", "peerId": None,
                "project": {"id": "project-a", "kind": "film", "members": ["R03", "R04", "R11"]},
                "agentIds": ["R03"], "prompt": "写一份文稿", "history": [],
                "inputArtifacts": [], "tasks": [], "decisions": []}
        data.update(changes)
        return data

    def wait_run(self, run):
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            value = self.runtime.get("run", run["id"])
            if value["status"] not in ("queued", "running"):
                return value
            time.sleep(.01)
        self.fail("Run did not settle")

    def seed_artifact(self, project="project-a"):
        artifact = {"id": "trusted-artifact", "body": "CANONICAL_SERVER_BODY", "hash": "canonical-hash",
                    "authorId": "R03", "runId": "earlier-run", "filename": "saved.md"}
        self.runtime.save("run", {"id": "earlier-run", "projectId": project, "peerId": None,
                                 "status": "succeeded", "messages": [], "artifacts": [artifact], "steps": []})

    def test_explicit_foreign_scope_rejected_in_every_context_channel(self):
        cases = [
            {"tasks": [{"id": "foreign", "projectId": "project-b"}]},
            {"decisions": [{"id": "foreign", "projectId": "project-b"}]},
            {"history": [{"projectId": "project-b", "text": "PRIVATE_PROJECT_B"}]},
            {"history": [{"peerId": "R04", "text": "PRIVATE_DM"}]},
            {"inputArtifacts": [{"id": "foreign", "projectId": "project-b", "body": "PRIVATE_PROJECT_B"}]},
        ]
        for extra in cases:
            with self.subTest(extra=extra):
                with self.assertRaises(InputError):
                    self.runtime.start(self.payload(**extra))
        self.assertEqual(self.provider.calls, [])

    def test_dm_rejects_foreign_material_but_allows_explicit_unscoped_notes(self):
        dm = self.payload(project=None, peerId="R03")
        for key, value in (("history", {"peerId": "R04", "text": "PRIVATE_DM"}),
                           ("inputArtifacts", {"projectId": "project-b", "body": "PRIVATE_PROJECT"})):
            with self.subTest(key=key):
                with self.assertRaises(InputError):
                    self.runtime.start({**dm, key: [value]})
        dm["inputArtifacts"] = [{"title": "用户主动提供的参考", "body": "EXPLICIT_MANUAL_REFERENCE"}]
        result = self.wait_run(self.runtime.start(dm))
        self.assertEqual(result["status"], "succeeded")
        self.assertIn("EXPLICIT_MANUAL_REFERENCE", self.provider.calls[0])

    def test_known_artifact_scope_cannot_be_hidden_by_omitting_metadata(self):
        self.seed_artifact(project="project-b")
        with self.assertRaises(InputError):
            self.runtime.start(self.payload(inputArtifacts=[{"id": "trusted-artifact", "body": "FORGED_COPY"}]))
        self.assertEqual(self.provider.calls, [])

    def test_known_artifact_uses_server_body_instead_of_browser_copy(self):
        self.seed_artifact()
        run = self.wait_run(self.runtime.start(self.payload(inputArtifacts=[{"id": "trusted-artifact", "body": "FORGED_BROWSER_BODY"}])))
        self.assertEqual(run["status"], "succeeded")
        self.assertIn("CANONICAL_SERVER_BODY", self.provider.calls[0])
        self.assertNotIn("FORGED_BROWSER_BODY", self.provider.calls[0])

    def test_done_dependency_requires_current_evidence_and_review(self):
        task = {"id": "next", "projectId": "project-a", "ownerId": "R03", "reviewerId": "R04", "dependencies": ["up"]}
        valid = {"id": "up", "projectId": "project-a", "status": "done", "evidence": "已核对的具体版本", "reviewNote": "独立复核意见"}
        for override in ({"evidence": ""}, {"reviewNote": ""}, {"reviewNote": "需复核：上游已变更"}):
            with self.subTest(override=override):
                with self.assertRaises(InputError):
                    self.runtime.start(self.payload(task=task, tasks=[{**valid, **override}]))
        result = self.wait_run(self.runtime.start(self.payload(task=task, tasks=[valid])))
        self.assertEqual(result["status"], "succeeded")
        self.assertNotIn("status", task)

    def test_cancel_wins_even_if_provider_returns_success_after_cancel(self):
        self.provider.release.clear()
        run = self.runtime.start(self.payload())
        self.assertTrue(self.provider.entered.wait(2))
        self.runtime.cancel(run["id"])
        self.provider.release.set()
        deadline = time.monotonic() + 2
        while self.runtime.cancel_events and time.monotonic() < deadline:
            time.sleep(.01)
        result = self.runtime.get("run", run["id"])
        self.assertEqual(result["status"], "cancelled")
        self.assertEqual(result["artifacts"], [])
        self.assertEqual(result["messages"], [])

    def test_concurrent_same_request_executes_once_and_changed_request_is_rejected(self):
        self.provider.release.clear()
        data = self.payload()
        result_ids, failures = [], []
        def submit():
            try:
                result_ids.append(self.runtime.start(copy.deepcopy(data))["id"])
            except Exception as error:
                failures.append(error)
        threads = [threading.Thread(target=submit) for _ in range(5)]
        for thread in threads: thread.start()
        for thread in threads: thread.join(2)
        self.assertEqual(failures, [])
        self.assertEqual(len(result_ids), 5)
        self.assertEqual(len(set(result_ids)), 1)
        with self.assertRaises(InputError) as error:
            self.runtime.start({**data, "prompt": "修改后的不同请求"})
        self.assertEqual(error.exception.status, 409)
        self.assertTrue(self.provider.entered.wait(2))
        self.provider.release.set()
        self.wait_run({"id": result_ids[0]})
        self.assertEqual(len(self.provider.calls), 1)


class StaticFileBoundaryTests(unittest.TestCase):
    def test_allowed_url_cannot_symlink_to_private_file_inside_project(self):
        with tempfile.TemporaryDirectory(prefix="studio-static-boundary-") as directory:
            root = Path(directory)
            (root / "assets").mkdir()
            (root / "data" / "runtime").mkdir(parents=True)
            private = root / "data" / "runtime" / "connections.json"
            private.write_text('{"private":"TEST_SENTINEL"}', encoding="utf-8")
            (root / "assets" / "linked.json").symlink_to(private)
            handler = httpd.Handler.__new__(httpd.Handler)
            sent = []
            handler.send = lambda *args, **kwargs: sent.append((args, kwargs))
            with patch.object(httpd, "ROOT", root):
                with self.assertRaises(InputError) as error:
                    handler.static("/assets/linked.json")
            self.assertEqual(error.exception.status, 404)
            self.assertEqual(sent, [])


if __name__ == "__main__":
    unittest.main()

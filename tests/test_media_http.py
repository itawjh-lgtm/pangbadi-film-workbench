"""Submission deduplication at the HTTP boundary; no external API is called."""
import json
from pathlib import Path
import tempfile
import threading
import unittest
from http.client import HTTPConnection

from server.httpd import Handler, StudioServer
from server.media import MediaRequestError, MediaRegistry
from server.runtime import InputError, Runtime
from server.workspace import Workspace
from test_runtime import Catalog, Provider


class Media:
    def __init__(self, uncertain=False):
        self.calls = 0
        self.uncertain = uncertain

    def estimate(self, provider, data):
        return {"known": True, "estimatedCost": 1, "currency": "CNY"}

    def submit(self, provider, data):
        self.calls += 1
        if self.uncertain:
            raise MediaRequestError("网络结果不明", outcome_unknown=True)
        return {"task_id": "123", "status": "queued"}


class MediaHttpTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.runtime = Runtime(self.temp.name, Catalog(), Provider())
        self.handler = object.__new__(Handler)
        self.handler.server = type("Server", (), {})()
        self.handler.server.runtime = self.runtime
        self.handler.server.media = Media()
        self.handler.server.workspace = Workspace(self.runtime)
        self.handler.server.workspace.save({"expectedRevision": 0, "state": {"version": 3,
            "projects": [{"id": "film-project", "kind": "film"}], "tasks": [], "decisions": [],
            "artifacts": [], "messages": [], "activity": [], "favorites": []}})
        self.responses = []
        self.handler.send = lambda status, body: self.responses.append((status, body))
        self.payload = dict(requestId="media-test", provider="runninghub", workflowId="1234", confirmCost=True, nodeInfoList=[], budget=2)

    def tearDown(self):
        self.runtime.close()
        self.temp.cleanup()

    def test_duplicate_submission_returns_saved_platform_task(self):
        self.handler.submit_media(self.payload)
        self.handler.submit_media(self.payload)
        self.assertEqual(self.handler.server.media.calls, 1)
        self.assertEqual(self.responses[-1][1]["job"]["task_id"], "123")
        self.assertEqual(self.responses[-1][1]["job"]["workflowId"], "1234")
        with self.assertRaises(InputError):
            self.handler.submit_media({**self.payload, "workflowId": "different"})

    def test_uncertain_submission_is_preserved_and_never_retried(self):
        self.handler.server.media.uncertain = True
        with self.assertRaises(MediaRequestError):
            self.handler.submit_media(self.payload)
        self.handler.submit_media(self.payload)
        self.assertEqual(self.handler.server.media.calls, 1)
        job = self.responses[-1][1]["job"]
        self.assertEqual(job["status"], "unknown")
        self.assertNotIn("task_id", job)
        self.assertEqual(len(self.runtime.all("media")), 1)

    def test_submission_preserves_project_association(self):
        self.handler.submit_media({**self.payload, "projectId": "film-project"})
        self.assertEqual(self.responses[-1][1]["job"]["projectId"], "film-project")

    def test_invalid_project_rejected_before_submit(self):
        with self.assertRaises(InputError):
            self.handler.submit_media({**self.payload, "projectId": {"invalid": True}})
        self.assertEqual(self.handler.server.media.calls, 0)


class MediaDiscoveryHttpTests(unittest.TestCase):
    """Real local HTTP boundary with temporary storage and fake external API."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.runtime = Runtime(self.temp.name, Catalog(), Provider())
        self.calls = []
        self.secret = "http-fixture-key"
        self.media = MediaRegistry(Path(self.temp.name) / "connections.json", self.transport)
        self.media.configure("runninghub", {"apiKey": self.secret})
        self.server = StudioServer(("127.0.0.1", 0), self.runtime, self.media)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(3)
        self.runtime.close()
        self.temp.cleanup()

    def transport(self, url, payload, headers, timeout):
        self.calls.append(url)
        if url.endswith("/accountStatus"):
            return {"code": 0, "data": {"remainCoins": "100", "apiType": "NORMAL"}}
        if url.endswith("/getJsonApiFormat"):
            return {"code": 0, "data": {"prompt": json.dumps({"6": {"class_type": "CLIPTextEncode", "inputs": {"text": "原创纸船", "clip": ["4", 1]}}})}}
        raise AssertionError("Read-only requests must never generate")

    def request(self, path, data, *, token=True, origin=None):
        headers = {"Content-Type": "application/json"}
        if token:
            headers["X-Studio-Token"] = self.server.csrf
        if origin:
            headers["Origin"] = origin
        conn = HTTPConnection("127.0.0.1", self.server.server_port, timeout=3)
        conn.request("POST", path, json.dumps(data), headers)
        response = conn.getresponse()
        status, raw = response.status, response.read().decode()
        conn.close()
        self.assertNotIn(self.secret, raw)
        return status, json.loads(raw)

    def test_read_only_discovery_routes_return_safe_results(self):
        status, result = self.request("/api/connections/runninghub/verify", {})
        self.assertEqual(status, 200)
        self.assertTrue(result["verification"]["verified"])
        self.assertNotIn("remainCoins", json.dumps(result))
        status, result = self.request("/api/connections/runninghub/workflow", {"workflowId": "123456"})
        self.assertEqual(status, 200)
        self.assertEqual(result["workflow"]["workflowId"], "123456")
        self.assertEqual(result["workflow"]["nodeInfoList"], [{"nodeId": "6", "fieldName": "text", "fieldValue": "原创纸船"}])
        self.assertEqual(len(self.calls), 2)
        self.assertEqual(self.runtime.all("media"), [])

    def test_discovery_keeps_same_origin_and_csrf_protection(self):
        for path, body in (("/api/connections/runninghub/verify", {}), ("/api/connections/runninghub/workflow", {"workflowId": "123"})):
            self.assertEqual(self.request(path, body, token=False)[0], 403)
            self.assertEqual(self.request(path, body, origin="https://untrusted.example")[0], 403)
        self.assertEqual(self.calls, [])

    def test_discovery_rejects_inline_keys_and_generation_options(self):
        self.assertEqual(self.request("/api/connections/runninghub/verify", {"apiKey": "unwanted"})[0], 400)
        self.assertEqual(self.request("/api/connections/runninghub/workflow", {"workflowId": "123", "confirmCost": True})[0], 400)
        self.assertEqual(self.calls, [])


if __name__ == "__main__":
    unittest.main()

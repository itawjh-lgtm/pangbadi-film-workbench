"""Model task persistence and HTTP routing without opening sockets."""

from copy import deepcopy
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from server.httpd import Handler
from server.media import MediaRegistry, MediaRequestError
from server.runtime import InputError, Runtime
from server.workspace import Workspace
from test_runtime import Catalog, Provider


class ModelHttpTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.runtime = Runtime(self.temp.name, Catalog(), Provider())
        self.calls = []
        self.fail_submission = False
        self.media = MediaRegistry(Path(self.temp.name) / "connections.json", self.transport)
        self.media.configure("runninghub", {"apiKey": "fake-workflow-key", "modelApiKey": "fake-model-key"})
        self.handler = object.__new__(Handler)
        self.handler.server = type("Server", (), {"runtime": self.runtime, "media": self.media})()
        self.handler.server.workspace = Workspace(self.runtime)
        self.handler.server.workspace.save({"expectedRevision": 0, "state": {"version": 3,
            "projects": [{"id": "test-project", "kind": "film"}], "tasks": [], "decisions": [],
            "artifacts": [], "messages": [], "activity": [], "favorites": []}})
        self.responses = []
        self.handler.send = lambda status, body: self.responses.append((status, deepcopy(body)))
        self.handler.guard = lambda write=False: None
        self.payload = {"provider": "runninghub", "requestId": "model-request-1", "projectId": "test-project",
                        "mode": "model_api", "modelId": "seedream-v4.7/text-to-image",
                        "parameters": {"prompt": "一只原创纸船"}, "quantity": 1, "budget": 2}

    def tearDown(self):
        self.runtime.close()
        self.temp.cleanup()

    def transport(self, url, payload, headers, timeout):
        self.calls.append((url, deepcopy(payload), deepcopy(headers)))
        if "/price-preview/" in url:
            return {"estimatedPrice": 0.5, "currency": "CNY", "isFreeThisCall": False}
        if url.endswith("/query"):
            return {"taskId": payload["taskId"], "status": "SUCCESS", "results": []}
        if self.fail_submission:
            raise TimeoutError("fake network failure")
        return {"taskId": "model-task-1", "status": "QUEUED"}

    def quote(self):
        self.payload["estimateToken"] = self.media.estimate("runninghub", self.payload)["estimateToken"]
        self.payload["confirmCost"] = True

    def test_catalog_route_is_read_only(self):
        self.handler.path = "/api/media/models"
        self.handler.handle_request(False)
        self.assertEqual(self.responses[-1][0], 200)
        self.assertEqual(len(self.responses[-1][1]["models"]), 311)
        self.assertEqual(sum(model["available"] for model in self.responses[-1][1]["models"]), 305)
        self.assertEqual(self.calls, [])

    def test_submit_persists_model_snapshot_and_deduplicates(self):
        self.quote()
        self.handler.submit_media(self.payload)
        self.handler.submit_media(self.payload)
        self.assertEqual(len(self.calls), 2)  # One price preview, one creation.
        job = self.responses[-1][1]["job"]
        self.assertEqual(job["mode"], "model_api")
        self.assertEqual(job["modelId"], self.payload["modelId"])
        self.assertEqual(job["projectId"], "test-project")
        self.assertEqual(job["mediaKind"], "image")
        self.assertEqual(job["parameters"]["width"], 2048)
        self.assertTrue(job["name"])
        self.assertNotIn("fake-model-key", json.dumps(job))
        self.assertNotIn("fake-workflow-key", json.dumps(job))
        with self.assertRaises(InputError):
            self.handler.submit_media({**self.payload, "parameters": {"prompt": "changed"}})

    def test_refresh_uses_persisted_mode_and_legacy_jobs_default_to_workflow(self):
        self.quote()
        self.handler.submit_media(self.payload)
        job = self.responses[-1][1]["job"]
        path = f"/api/media/jobs/{job['id']}/refresh"
        self.handler.post(path, path.strip("/").split("/"), {})
        self.assertEqual(self.calls[-1][2]["Authorization"], "Bearer fake-model-key")
        self.assertEqual(self.responses[-1][1]["job"]["status"], "succeeded")
        self.runtime.save("media", {"id": "legacy-task", "provider": "runninghub", "task_id": "legacy-platform-task"})
        path = "/api/media/jobs/legacy-task/refresh"
        self.handler.post(path, path.strip("/").split("/"), {})
        self.assertEqual(self.calls[-1][2]["Authorization"], "Bearer fake-workflow-key")

    def test_unknown_submission_is_persisted_and_not_retried(self):
        self.quote()
        self.fail_submission = True
        with self.assertRaises(MediaRequestError):
            self.handler.submit_media(self.payload)
        self.handler.submit_media(self.payload)
        self.assertEqual(len(self.calls), 2)
        job = self.responses[-1][1]["job"]
        self.assertEqual(job["status"], "unknown")
        self.assertEqual(job["mode"], "model_api")
        self.assertEqual(job["parameters"]["width"], 2048)

    def test_text_tool_outputs_are_saved_on_submit_and_refresh(self):
        self.quote()
        response = {"taskId": "text-task", "status": "SUCCESS", "results": [
            {"text": '{"sessionId":"fake-session"}', "outputType": "json"}]}
        with patch.object(self.media, "_transport", return_value=response):
            self.handler.submit_media(self.payload)
            job = self.responses[-1][1]["job"]
            self.assertEqual(job["textOutputs"][0]["text"], '{"sessionId":"fake-session"}')
            self.assertEqual(self.runtime.get("media", job["id"])["textOutputs"], job["textOutputs"])
            path = f"/api/media/jobs/{job['id']}/refresh"
            self.handler.post(path, path.strip("/").split("/"), {})
            saved = self.runtime.get("media", job["id"])
            self.assertEqual(saved["textOutputs"], job["textOutputs"])
            self.assertEqual(saved["evidence"]["textOutputCount"], 1)
            self.assertEqual(saved["outputs"], [])

    def test_verify_route_supports_model_mode_without_inline_credentials(self):
        path = "/api/connections/runninghub/verify"
        self.handler.post(path, path.strip("/").split("/"), {"mode": "model_api"})
        self.assertEqual(self.responses[-1][1]["verification"]["scope"], "price_preview")
        self.assertEqual(len(self.calls), 1)
        with self.assertRaises(InputError):
            self.handler.post(path, path.strip("/").split("/"), {"mode": "model_api", "modelApiKey": "unwanted"})
        self.assertEqual(len(self.calls), 1)


if __name__ == "__main__":
    unittest.main()

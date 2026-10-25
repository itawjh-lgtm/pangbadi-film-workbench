"""Personal-key workflow API round trips with fake RunningHub responses only.

The HTTP server and SQLite database are isolated and temporary. No production
configuration is read, no external request is made, and no media is generated.
"""

from copy import deepcopy
from http.client import HTTPConnection
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.error import URLError

from server.httpd import StudioServer
from server.media import MediaRegistry
from server.runtime import Runtime
from test_runtime import Catalog, Provider


FAKE_KEY = "personal-e2e-fixture-not-a-real-key"
BASE = "https://www.runninghub.cn"


class PersonalWorkflowE2ETests(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.tasks = {}
        self.query_counts = {}
        self.uncertain_create = False
        self.csrf = None
        self.temp = tempfile.TemporaryDirectory(prefix="studio-personal-e2e-")
        self.addCleanup(self.temp.cleanup)
        # A missed transport injection must fail instead of reaching the network.
        guard = patch("server.media._default_transport", side_effect=AssertionError("External transport is forbidden in this test"))
        guard.start()
        self.addCleanup(guard.stop)
        self.provider = Provider()
        self.runtime = Runtime(self.temp.name, Catalog(), self.provider)
        self.addCleanup(self.runtime.close)
        self.media = MediaRegistry(Path(self.temp.name) / "connections.json", self.transport)
        self.server = StudioServer(("127.0.0.1", 0), self.runtime, self.media)
        self.addCleanup(self.server.server_close)
        self.server.workspace.save({"expectedRevision": 0, "state": {"version": 3,
            "projects": [{"id": "qa-personal-only", "name": "隔离测试项目", "kind": "film"}],
            "tasks": [], "decisions": [], "artifacts": [], "messages": [], "activity": [], "favorites": []}})
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop_server)

    def stop_server(self):
        self.server.shutdown()
        self.thread.join(3)

    def transport(self, url, payload, headers, timeout):
        self.calls.append((url, deepcopy(payload), deepcopy(headers)))
        if url == BASE + "/uc/openapi/accountStatus":
            self.assertEqual(payload, {"apikey": FAKE_KEY})
            self.assertEqual(headers["Authorization"], "Bearer " + FAKE_KEY)
            return {"code": 0, "data": {"remainCoins": "100", "apiType": "NORMAL"}}
        if url == BASE + "/api/openapi/getJsonApiFormat":
            self.assertEqual(payload["apiKey"], FAKE_KEY)
            self.assertEqual(headers["Authorization"], "Bearer " + FAKE_KEY)
            self.assertIn(payload["workflowId"], ("qa-image-workflow", "qa-video-workflow"))
            return {"code": 0, "data": {"prompt": json.dumps({
                "6": {"class_type": "CLIPTextEncode", "inputs": {"text": "原始模拟提示词", "clip": ["4", 1]}},
                "5": {"class_type": "EmptyLatentImage", "inputs": {"width": 512, "height": 512, "batch_size": 1}},
            }, ensure_ascii=False)}}
        if url == BASE + "/task/openapi/create":
            self.assertEqual(payload["apiKey"], FAKE_KEY)
            self.assertNotIn("Authorization", headers)
            self.assertNotIn("budget", payload)
            self.assertNotIn("estimateToken", payload)
            self.assertNotIn("modelApiKey", payload)
            if self.uncertain_create:
                raise URLError("simulated connection lost after submission")
            task_id = "qa-task-" + str(len(self.tasks) + 1)
            self.tasks[task_id] = deepcopy(payload)
            return {"code": 0, "data": {"taskId": task_id, "taskStatus": "QUEUED"}}
        if url == BASE + "/openapi/v2/query":
            self.assertEqual(headers["Authorization"], "Bearer " + FAKE_KEY)
            self.assertEqual(set(payload), {"taskId"})
            task_id = payload["taskId"]
            self.assertIn(task_id, self.tasks)
            count = self.query_counts.get(task_id, 0) + 1
            self.query_counts[task_id] = count
            if count == 1:
                return {"taskId": task_id, "status": "RUNNING", "results": None}
            extension = "mp4" if self.tasks[task_id]["workflowId"] == "qa-video-workflow" else "png"
            return {"taskId": task_id, "status": "SUCCESS", "results": [
                {"url": "https://media.example.invalid/" + task_id + "." + extension, "outputType": extension},
            ]}
        raise AssertionError("Unexpected external endpoint in isolated test")

    def request(self, method, path, data=None):
        headers = {"Origin": "http://127.0.0.1:" + str(self.server.server_port)}
        body = None
        if data is not None:
            headers["Content-Type"] = "application/json"
            headers["X-Studio-Token"] = self.csrf or ""
            body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        connection = HTTPConnection("127.0.0.1", self.server.server_port, timeout=3)
        try:
            connection.request(method, path, body=body, headers=headers)
            response = connection.getresponse()
            raw = response.read().decode("utf-8")
            self.assertNotIn(FAKE_KEY, raw)
            return response.status, json.loads(raw)
        finally:
            connection.close()

    def prepare(self, workflow_id):
        status, health = self.request("GET", "/api/health")
        self.assertEqual(status, 200)
        self.csrf = health["csrfToken"]
        status, result = self.request("POST", "/api/connections/runninghub", {
            "apiKey": FAKE_KEY, "workflowId": workflow_id, "unitPrice": 0.1, "unit": "次", "currency": "CNY",
        })
        self.assertEqual(status, 200)
        self.assertTrue(result["connection"]["keyConfigured"])
        self.assertFalse(result["connection"]["modelConnection"]["keyConfigured"])
        status, result = self.request("POST", "/api/connections/runninghub/verify", {})
        self.assertEqual(status, 200)
        self.assertTrue(result["verification"]["verified"])
        self.assertEqual(result["verification"]["scope"], "account")
        status, catalog = self.request("GET", "/api/connections")
        self.assertEqual(status, 200)
        runninghub = next(item for item in catalog["providers"] if item["id"] == "runninghub")
        self.assertTrue(runninghub["verified"])
        self.assertFalse(runninghub["modelConnection"]["verified"])
        status, result = self.request("POST", "/api/connections/runninghub/workflow", {
            "workflowId": BASE + "/workflow/" + workflow_id,
        })
        self.assertEqual(status, 200)
        workflow = result["workflow"]
        self.assertEqual(workflow["workflowId"], workflow_id)
        self.assertEqual(len(workflow["fields"]), 4)
        self.assertFalse(any(field["fieldName"] == "clip" for field in workflow["fields"]))
        prompt = "模拟测试：蓝色纸船在白色水盆中轻轻漂动"
        nodes = deepcopy(workflow["nodeInfoList"])
        next(node for node in nodes if node["fieldName"] == "text")["fieldValue"] = prompt
        payload = {"provider": "runninghub", "mode": "workflow_api", "projectId": "qa-personal-only",
                   "workflowId": workflow_id, "nodeInfoList": nodes, "quantity": 1, "budget": 0.2}
        status, result = self.request("POST", "/api/media/estimate", payload)
        self.assertEqual(status, 200)
        estimate = result["estimate"]
        self.assertTrue(estimate["known"])
        self.assertEqual(estimate["estimatedCost"], 0.1)
        self.assertEqual(estimate["pricingSource"], "user_estimate")
        self.assertTrue(estimate["withinBudget"])
        self.assertFalse(estimate["hardBudgetCap"])
        self.assertEqual(len(self.calls), 2)  # Discovery only; estimate is local.
        self.assertEqual(self.runtime.all("media"), [])
        return {**payload, "requestId": "qa-request-" + workflow_id,
                "estimateToken": estimate["estimateToken"], "confirmCost": True}, prompt

    def assert_round_trip(self, workflow_id, extension):
        payload, prompt = self.prepare(workflow_id)
        status, result = self.request("POST", "/api/media/jobs", payload)
        self.assertEqual(status, 202)
        created = result["job"]
        self.assertEqual(created["status"], "queued")
        self.assertEqual(created["mode"], "workflow_api")
        self.assertEqual(created["projectId"], "qa-personal-only")
        submitted = self.tasks[created["task_id"]]
        self.assertEqual(next(node for node in submitted["nodeInfoList"] if node["fieldName"] == "text")["fieldValue"], prompt)
        self.assertEqual(created["outputs"], [])
        status, repeated = self.request("POST", "/api/media/jobs", payload)
        self.assertEqual(status, 200)
        self.assertEqual(repeated["job"]["id"], created["id"])
        changed = deepcopy(payload)
        changed["nodeInfoList"][0]["fieldValue"] = "changed request cannot reuse its ID"
        self.assertEqual(self.request("POST", "/api/media/jobs", changed)[0], 409)
        self.assertEqual(len(self.tasks), 1)
        path = "/api/media/jobs/" + created["id"]
        status, result = self.request("POST", path + "/refresh", {})
        self.assertEqual(status, 200)
        self.assertEqual(result["job"]["status"], "running")
        self.assertEqual(result["job"]["outputs"], [])
        status, result = self.request("POST", path + "/refresh", {})
        self.assertEqual(status, 200)
        complete = result["job"]
        self.assertEqual(complete["status"], "succeeded")
        self.assertEqual(complete["outputs"], [{
            "url": "https://media.example.invalid/" + created["task_id"] + "." + extension,
            "outputType": extension, "storage": "provider", "downloaded": False,
        }])
        self.assertEqual(self.request("GET", path)[1]["job"], complete)
        self.assertEqual(self.request("GET", "/api/media/jobs")[1]["jobs"], [complete])
        self.assertNotIn(FAKE_KEY, json.dumps(self.runtime.all("media")))
        self.assertEqual(len(self.calls), 5)  # Account, graph, create, two polls.
        self.assertFalse(any("price-preview" in call[0] for call in self.calls))
        self.assertEqual(self.provider.calls, [])

    def test_personal_image_workflow_full_http_round_trip_and_deduplication(self):
        self.assert_round_trip("qa-image-workflow", "png")

    def test_personal_video_workflow_full_http_round_trip_and_deduplication(self):
        self.assert_round_trip("qa-video-workflow", "mp4")

    def test_uncertain_personal_submission_keeps_record_without_resubmitting(self):
        payload, _ = self.prepare("qa-image-workflow")
        self.uncertain_create = True
        self.assertEqual(self.request("POST", "/api/media/jobs", payload)[0], 400)
        status, repeated = self.request("POST", "/api/media/jobs", payload)
        self.assertEqual(status, 200)
        job = repeated["job"]
        self.assertEqual(job["status"], "unknown")
        self.assertNotIn("task_id", job)
        self.assertEqual(len(self.calls), 3)
        self.assertEqual(len(self.runtime.all("media")), 1)
        self.assertEqual(self.request("POST", "/api/media/jobs/" + job["id"] + "/refresh", {})[0], 409)
        self.assertEqual(len(self.calls), 3)


if __name__ == "__main__":
    unittest.main()

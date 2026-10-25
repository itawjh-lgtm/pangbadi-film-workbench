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
        self.handler.server.media_locks = {}
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
        self.handler.submit_media({**self.payload, "projectId": "film-project", "title": "镜头01", "mediaType": "video"})
        job = self.responses[-1][1]["job"]
        self.assertEqual(job["projectId"], "film-project")
        self.assertEqual((job["title"], job["mediaType"], job["source"]), ("镜头01", "video", "api"))
        self.assertEqual([event["type"] for event in job["history"]], ["created", "submitted"])
        self.assertTrue(all(isinstance(event["at"], int) for event in job["history"]))

    def test_refresh_records_observed_states_and_stops_after_terminal(self):
        self.handler.submit_media(self.payload)
        job_id = self.responses[-1][1]["job"]["id"]
        results = iter([{"status": "running", "outputs": []},
                        {"status": "running", "outputs": []},
                        {"status": "succeeded", "outputs": [{"url": "https://media.example.com/1.png"}]}])
        self.handler.server.media.poll = lambda *args: next(results)
        for _ in range(4):
            self.handler.refresh_media(job_id)
        job = self.runtime.get("media", job_id)
        self.assertEqual(job["status"], "succeeded")
        self.assertEqual([event["type"] for event in job["history"]], ["created", "submitted", "status", "status", "outputs"])
        self.assertTrue(job["checkedAt"] >= job["createdAt"])
        self.assertEqual(job["lastSuccessfulCheckAt"], job["checkedAt"])

    def test_success_from_create_is_queried_once_to_obtain_outputs(self):
        self.handler.server.media.submit = lambda *args: {"task_id": "123", "status": "succeeded", "outputs": []}
        self.handler.submit_media(self.payload)
        job_id = self.responses[-1][1]["job"]["id"]
        results = iter([{"status": "succeeded", "outputs": [{"url": "https://media.example.com/1.png"}]}])
        self.handler.server.media.poll = lambda *args: next(results)
        self.handler.refresh_media(job_id)
        self.handler.refresh_media(job_id)
        self.assertEqual(len(self.runtime.get("media", job_id)["outputs"]), 1)

    def test_restart_marks_pending_submission_unknown_with_event(self):
        self.runtime.save("media", {"id": "recovery-job", "requestId": "recovery-request", "status": "submitting", "outputs": [], "history": []})
        self.runtime.close()
        self.runtime = Runtime(self.temp.name, Catalog(), Provider())
        self.handler.server.runtime = self.runtime
        job = self.runtime.get("media", "recovery-job")
        self.assertEqual(job["status"], "unknown")
        self.assertEqual(job["history"][-1]["type"], "interrupted")
        self.assertEqual(job["history"][-1]["at"], job["updatedAt"])
        self.assertEqual(self.handler.server.media.calls, 0)

    def test_query_failure_preserves_status_and_outputs_then_recovers(self):
        self.handler.submit_media(self.payload)
        job_id = self.responses[-1][1]["job"]["id"]
        def fail(*args):
            raise MediaRequestError("查询暂时不可用", "QUERY_FAILED")
        self.handler.server.media.poll = fail
        self.handler.refresh_media(job_id)
        self.handler.refresh_media(job_id)
        job = self.runtime.get("media", job_id)
        self.assertEqual(job["status"], "queued")
        self.assertEqual(job["outputs"], [])
        self.assertEqual(job["lastRefreshError"], "查询暂时不可用")
        self.assertEqual([e["type"] for e in job["history"]].count("refresh_error"), 1)
        self.handler.server.media.poll = lambda *args: {"status": "running", "outputs": []}
        self.handler.refresh_media(job_id)
        job = self.runtime.get("media", job_id)
        self.assertNotIn("lastRefreshError", job)
        self.assertEqual(job["history"][-1]["type"], "refresh_recovered")

    def test_external_import_deduplicates_without_any_provider_calls(self):
        data = {"requestId": "import-1", "projectId": "film-project", "title": "外部小样", "mediaType": "image", "url": "https://media.example.com/result.png", "sourceUrl": "https://www.runninghub.cn/project/canvas/123", "taskId": "123"}
        self.handler.import_media(data)
        self.handler.import_media(data)
        job = self.responses[-1][1]["job"]
        self.assertEqual(job["source"], "external")
        self.assertEqual(job["externalTaskId"], "123")
        self.assertNotIn("task_id", job)
        self.assertTrue(job["evidence"]["registeredOnly"])
        self.assertFalse(job["evidence"]["availabilityChecked"])
        self.assertEqual(self.handler.server.media.calls, 0)
        self.assertEqual(len(self.runtime.all("media")), 1)
        with self.assertRaises(InputError):
            self.handler.refresh_media(job["id"])
        with self.assertRaises(InputError):
            self.handler.import_media({**data, "url": "https://media.example.com/other.png"})

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

    def test_import_route_registers_links_and_enforces_csrf(self):
        data = {"requestId": "external-http", "projectId": "film", "title": "视频小样", "mediaType": "video", "url": "https://cdn.example.com/result.mp4"}
        self.assertEqual(self.request("/api/media/import", data, token=False)[0], 403)
        self.assertEqual(self.request("/api/media/import", data, origin="https://untrusted.example")[0], 403)
        status, result = self.request("/api/media/import", data)
        self.assertEqual(status, 201)
        self.assertEqual(result["job"]["source"], "external")
        self.assertEqual(result["job"]["outputs"][0]["outputType"], "video")
        self.assertEqual(self.calls, [])
        status, result = self.request("/api/media/jobs/" + result["job"]["id"] + "/refresh", {})
        self.assertEqual(status, 409)
        self.assertEqual(self.calls, [])

    def test_import_route_rejects_private_and_credential_urls(self):
        data = {"requestId": "external-unsafe", "projectId": "film", "title": "小样", "mediaType": "image"}
        for url in ("http://example.com/1.png", "https://localhost/1.png", "https://localhost./1.png", "https://127.1/1.png", "https://2130706433/1.png", "https://0x7f000001/1.png", "https://192.168.1.4/1.png", "https://169.254.169.254/a", "https://[::1]/a", "https://host.local/a", "https://u:p@example.com/a", "https://example.com:8767/a", "https://example.com\\@127.0.0.1/a"):
            with self.subTest(url=url):
                self.assertEqual(self.request("/api/media/import", {**data, "url": url})[0], 400)
        self.assertEqual(self.runtime.all("media"), [])
        self.assertEqual(self.calls, [])


if __name__ == "__main__":
    unittest.main()

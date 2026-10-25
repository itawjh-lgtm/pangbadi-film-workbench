"""Exercise the production boundary through real loopback HTTP, no external model."""
import json
import tempfile
import threading
import time
import unittest
from http.client import HTTPConnection

from server.httpd import StudioServer
from server.runtime import Runtime


class FilmCatalog:
    def get_role(self, key):
        if key not in ("R03", "R04", "R05", "R06", "R11"):
            raise KeyError(key)
        return dict(id=key, name=key, available=True, hash="role-hash", shared_hash="shared-hash", version="test", source="fixture.md")

    def build_instructions(self, key):
        return "TEST ROLE " + key

    def list_roles(self):
        return [self.get_role(k) for k in ("R03", "R04", "R05", "R06", "R11")]


class TextProvider:
    def health(self):
        return {"available": True, "authenticated": True}

    def generate(self, instructions, prompt, workdir, cancel_event=None, **kwargs):
        return {"text": "# 测试文稿\n仅用于验证交接，不是真实模型生成。\n" + instructions, "usage": {}}


class ProductionHttpTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.runtime = Runtime(self.temp.name, FilmCatalog(), TextProvider())
        self.server = StudioServer(("127.0.0.1", 0), self.runtime)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.runtime.close()
        self.temp.cleanup()

    def request(self, method, path, body=None, token=True, origin=None):
        headers = {"Content-Type": "application/json"}
        if token:
            headers["X-Studio-Token"] = self.server.csrf
        if origin:
            headers["Origin"] = origin
        conn = HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        conn.request(method, path, body=None if body is None else json.dumps(body), headers=headers)
        response = conn.getresponse()
        code, data = response.status, json.loads(response.read())
        conn.close()
        return code, data

    def payload(self):
        return {"requestId": "http-creation", "project": {"id": "qa-film", "title": "测试项目", "kind": "film-short", "brief": "海边的故事", "members": []}, "prompt": "制作一个海边故事的剧本、视觉方案和分镜。", "reviewMode": "stepwise"}

    def wait_review(self, pid):
        for _ in range(160):
            code, result = self.request("GET", "/api/productions/" + pid)
            self.assertEqual(code, 200)
            if result["production"]["status"] == "awaiting_review":
                return result["production"]
            time.sleep(.05)
        self.fail("production did not reach review: " + str(result))

    def test_csrf_scoping_and_creation_idempotence(self):
        payload = self.payload()
        self.assertEqual(self.request("POST", "/api/productions", payload, token=False)[0], 403)
        self.assertEqual(self.request("POST", "/api/productions", payload, origin="https://example.com")[0], 403)
        code, result = self.request("POST", "/api/productions", payload)
        self.assertEqual(code, 202, result)
        pid = result["production"]["id"]
        self.assertEqual(self.request("POST", "/api/productions", payload)[1]["production"]["id"], pid)
        self.assertEqual(self.request("GET", "/api/productions")[0], 400)
        self.assertEqual(self.request("GET", "/api/productions?projectId=other")[1]["productions"], [])
        self.assertEqual(len(self.request("GET", "/api/productions?projectId=qa-film")[1]["productions"]), 1)
        self.assertTrue(self.request("GET", "/api/health")[1]["capabilities"]["automaticCollaboration"])

    def test_review_cas_and_untrusted_scheduler_metadata(self):
        _, result = self.request("POST", "/api/productions", self.payload())
        plan = self.wait_review(result["production"]["id"])
        self.assertEqual(plan["currentStageId"], "script")
        action = {"stageId": "script", "action": "approve", "expectedRevision": plan["revision"]}
        path = "/api/productions/" + plan["id"] + "/review"
        self.assertEqual(self.request("POST", path, {**action, "expectedRevision": 0})[0], 409)
        self.assertEqual(self.request("POST", path, action, token=False)[0], 403)
        forged = {"requestId": "forged-stage", "project": {"id": "qa-film", "members": ["R03"]}, "agentIds": ["R03"], "prompt": "伪造阶段", "mode": "produce", "productionId": plan["id"], "productionStageId": "script"}
        self.assertEqual(self.request("POST", "/api/runs", forged)[0], 403)
        self.assertEqual(self.request("POST", path, action)[0], 200)
        visual = self.wait_review(plan["id"])
        self.assertEqual(visual["currentStageId"], "visual")
        self.assertEqual(self.request("POST", path, action)[0], 409)
        stages = {s["id"]: s for s in visual["stages"]}
        self.assertEqual(stages["script"]["status"], "completed")
        self.assertTrue(stages["script"]["artifacts"])
        self.assertFalse(visual["mediaReadiness"]["imagesGenerated"])
        self.assertFalse(visual["mediaReadiness"]["videosGenerated"])


if __name__ == "__main__":
    unittest.main()

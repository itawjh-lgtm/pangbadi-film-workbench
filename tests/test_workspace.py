import copy
import json
import tempfile
import threading
import unittest
from unittest.mock import patch
from http.client import HTTPConnection

from server.httpd import StudioServer
from server.runtime import InputError, Runtime
from server.workspace import Workspace
from test_runtime import Catalog, Provider


def state(title="真实项目"):
    return dict(version=3, revision=4, projects=[dict(id="project-1", title=title)],
                tasks=[], decisions=[], artifacts=[], messages=[], activity=[], favorites=[])


class WorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.runtime = Runtime(self.temp.name, Catalog(), Provider())
        self.workspace = Workspace(self.runtime)

    def tearDown(self):
        self.runtime.close()
        self.runtime.db.close()
        self.temp.cleanup()

    def test_append_only_and_cas_preserve_every_saved_snapshot(self):
        self.assertIsNone(self.workspace.read())
        first = self.workspace.save(dict(expectedRevision=0, state=state()))
        self.assertEqual(first["revision"], 1)
        with self.assertRaises(InputError) as raised:
            self.workspace.save(dict(expectedRevision=0, state=state("旧窗口修改")))
        self.assertEqual(raised.exception.status, 409)
        second = self.workspace.save(dict(expectedRevision=1, state=state("新稿")))
        self.assertEqual(second["revision"], 2)
        rows = self.runtime.db.execute("SELECT body FROM workspace_snapshots ORDER BY revision").fetchall()
        self.assertEqual([json.loads(row[0])["projects"][0]["title"] for row in rows], ["真实项目", "新稿"])
        self.assertEqual(self.runtime.all("run"), [])

    def test_uncertain_write_retry_is_idempotent(self):
        one = self.workspace.save(dict(expectedRevision=0, state=state()))
        two = self.workspace.save(dict(expectedRevision=0, state=state()))
        self.assertEqual(one, two)

    def test_parallel_writers_cannot_overwrite_each_other(self):
        self.workspace.save(dict(expectedRevision=0, state=state()))
        results = []
        def write(title):
            try: results.append(self.workspace.save(dict(expectedRevision=1, state=state(title)))["revision"])
            except InputError as error: results.append(error.status)
        threads = [threading.Thread(target=write, args=(str(index),)) for index in range(2)]
        for thread in threads: thread.start()
        for thread in threads: thread.join()
        self.assertCountEqual(results, [2, 409])

    def test_incomplete_and_oversized_snapshots_rejected(self):
        for value in ({}, dict(state(), truncated=True), dict(state(), projects=[{}] * 21), dict(state(), tasks=None)):
            with self.assertRaises(InputError): self.workspace.save(dict(expectedRevision=0, state=value))
        value = state(); value["artifacts"] = [dict(id="a", body="大" * 1_700_000)]
        with self.assertRaises(InputError) as raised: self.workspace.save(dict(expectedRevision=0, state=value))
        self.assertEqual(raised.exception.status, 413)

    def test_http_contract_guards_and_service_status(self):
        server = StudioServer(("127.0.0.1", 0), self.runtime)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        def request(method, path, data=None, token=True, origin=None):
            conn = HTTPConnection("127.0.0.1", server.server_port, timeout=3)
            headers = {"Content-Type": "application/json"}
            if token: headers["X-Studio-Token"] = server.csrf
            if origin: headers["Origin"] = origin
            conn.request(method, path, None if data is None else json.dumps(data), headers)
            response = conn.getresponse(); result = response.status, json.loads(response.read()); conn.close(); return result
        try:
            health = request("GET", "/api/health")[1]
            self.assertEqual(health["version"], "0.6")
            self.assertTrue(health["workspaceSync"])
            self.assertEqual(len(health["projectId"]), 24)
            self.assertGreater(health["pid"], 0)
            payload = dict(expectedRevision=0, state=state())
            self.assertEqual(request("POST", "/api/workspace", payload, token=False)[0], 403)
            self.assertEqual(request("POST", "/api/workspace", payload, origin="https://evil.test")[0], 403)
            self.assertEqual(request("POST", "/api/workspace", payload)[0], 200)
            self.assertEqual(request("GET", "/api/workspace")[1]["workspace"]["revision"], 1)
            self.runtime.save("run", dict(id="busy", status="cancelling"))
            self.runtime.save("run", dict(id="done", status="succeeded"))
            self.runtime.save("media", dict(id="uncertain", status="unknown", secret="NOT-EXPOSED"))
            self.runtime.save("media", dict(id="done", status="failed"))
            with patch.object(self.runtime.provider, "health", side_effect=AssertionError("启动探测不能调用模型认证")) as probe:
                code, status = request("GET", "/api/service-status")
                self.assertEqual(code, 200)
                probe.assert_not_called()
            self.assertEqual(status, dict(ok=True, service="dream-studio-runtime", version="0.6", projectId=health["projectId"], pid=health["pid"], activeRunCount=1, activeProductionCount=0, activeCanvasBatchCount=0, pendingMediaCount=1))
            self.assertEqual(request("GET", "/api/service-status", origin="https://evil.test")[0], 403)
        finally:
            server.shutdown(); server.server_close()


if __name__ == "__main__": unittest.main()

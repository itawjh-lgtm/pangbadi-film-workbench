import json
import tempfile
import threading
import unittest
from http.client import HTTPConnection

from server.httpd import StudioServer
from server.runtime import Runtime
from test_runtime import Catalog, Provider


class HttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.runtime = Runtime(cls.temp.name, Catalog(), Provider())
        cls.server = StudioServer(("127.0.0.1", 0), cls.runtime)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.runtime.close()
        cls.temp.cleanup()

    def request(self, method, path, body=None, headers=None):
        conn = HTTPConnection("127.0.0.1", self.server.server_port, timeout=3)
        conn.request(method, path, body=json.dumps(body) if body is not None else None, headers=headers or {})
        response = conn.getresponse()
        result = (response.status, dict(response.getheaders()), response.read())
        conn.close()
        return result

    def test_health_and_static_page(self):
        status, _, body = self.request("GET", "/api/health")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["service"], "dream-studio-runtime")
        status, _, body = self.request("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn(b"StudioRuntime", self.request("GET", "/lib/runtime.js")[2])

    def test_cross_origin_host_and_missing_csrf_rejected(self):
        for headers in ({"Host": "evil.test"}, {"Origin": "https://evil.test"}, {"Sec-Fetch-Site": "cross-site"}):
            self.assertEqual(self.request("GET", "/api/health", headers=headers)[0], 403)
        self.assertEqual(self.request("POST", "/api/runs", {}, {"Content-Type": "application/json"})[0], 403)

    def test_runtime_sources_secrets_and_traversal_never_served(self):
        for path in ("/data/runtime/connections.json", "/data/runtime/studio.sqlite3", "/server/provider.py", "/docs/archive/", "/lib/%2e%2e/server/provider.py", "/lib/../data/employees.js", "/assets/.private"):
            self.assertEqual(self.request("GET", path)[0], 404, path)

    def test_write_requires_json_and_scoped_query(self):
        headers = {"X-Studio-Token": self.server.csrf}
        self.assertEqual(self.request("POST", "/api/runs", {}, headers)[0], 415)
        self.assertEqual(self.request("GET", "/api/runs?projectId=x&peerId=R03")[0], 400)
        self.assertEqual(self.request("GET", "/api/runs?peerId=R03")[0], 200)


if __name__ == "__main__":
    unittest.main()

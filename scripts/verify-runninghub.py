"""Isolated RunningHub UI fixture. Never contacts RunningHub or production data."""
import argparse
import json
from pathlib import Path
import signal
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tests"))
from server.httpd import StudioServer
from server.media import MediaRegistry
from server.runtime import Runtime
from test_runtime import Catalog, Provider


class FixtureCatalog(Catalog):
    def list_roles(self):
        return [self.get_role(key) for key in ("R03", "R04", "R11", "G01")]


def transport(url, payload, headers, timeout):
    if url.endswith("/accountStatus"):
        return {"code": 0, "data": {"remainCoins": "100", "apiType": "NORMAL"}}
    if url.endswith("/getJsonApiFormat"):
        return {"code": 0, "data": {"prompt": json.dumps({
            "6": {"class_type": "CLIPTextEncode", "_meta": {"title": "提示词"}, "inputs": {"text": "蓝色纸船，白色背景", "clip": ["4", 1]}},
            "5": {"class_type": "EmptyLatentImage", "_meta": {"title": "画布尺寸"}, "inputs": {"width": 512, "height": 512, "batch_size": 1}},
        }, ensure_ascii=False)}}
    if url.endswith("/task/openapi/create"):
        return {"code": 0, "data": {"taskId": "qa-fictional-task", "taskStatus": "QUEUED"}}
    if url.endswith("/openapi/v2/query"):
        return {"status": "SUCCESS", "results": []}
    raise AssertionError("Unexpected fixture endpoint")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8877)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="dream-studio-runninghub-qa-") as directory:
        runtime = Runtime(directory, FixtureCatalog(), Provider())
        media = MediaRegistry(Path(directory) / "connections.json", transport=transport)
        media.configure("runninghub", {"apiKey": "isolated-ui-fixture-not-a-real-key", "workflowId": "123456", "unitPrice": 0.1, "currency": "CNY"})
        server = StudioServer(("127.0.0.1", args.port), runtime, media)
        server.workspace.save({"expectedRevision": 0, "state": {
            "version": 3, "revision": 0, "presentationVersion": 1, "view": "connections", "activeProjectId": "qa-rh-only", "favorites": [],
            "projects": [{"id": "qa-rh-only", "title": "隔离测试 · 非真实生成", "brief": "全部使用模拟响应，不连接 RunningHub，不消费额度。", "kind": "film", "members": ["R11"], "isDemo": False, "createdAt": 1}],
            "tasks": [], "decisions": [], "artifacts": [], "messages": [], "activity": [],
        }})
        signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
        print(f"仅隔离测试，不连接真实 RunningHub：http://127.0.0.1:{args.port}/", flush=True)
        try:
            server.serve_forever()
        finally:
            server.server_close()
            runtime.close()


if __name__ == "__main__":
    main()

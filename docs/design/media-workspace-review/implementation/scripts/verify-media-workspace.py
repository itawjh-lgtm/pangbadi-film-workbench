"""Isolated media UI fixture: local samples, fake RunningHub, temporary database.

Run with --port 8878, then open that local URL. Ctrl+C or SIGTERM cleans up.
This script never reads production connections or writes production records.
"""
from __future__ import annotations

import argparse
from collections import defaultdict
import json
import mimetypes
from pathlib import Path
import re
import signal
import sys
import tempfile
import threading
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))

from server.httpd import Handler, StudioServer
from server.media import MediaRegistry
from server.runtime import Runtime, now
from test_runtime import Catalog, Provider

PROJECT_ID = "qa-media-only"
ASSETS = {"/assets/qa-media/sample.png": ROOT / "tests/fixtures/media-workspace/sample.png",
          "/assets/qa-media/sample.mp4": ROOT / "tests/fixtures/media-workspace/sample.mp4"}
FAKE_ASSETS = {"https://fixture.invalid/sample.png": "/assets/qa-media/sample.png",
               "https://fixture.invalid/sample.mp4": "/assets/qa-media/sample.mp4"}


class FixtureCatalog(Catalog):
    def list_roles(self):
        return [self.get_role(key) for key in ("R03", "R04", "R11", "G01")]


class FixtureTransport:
    """Every query is deterministic; even unknown task IDs stay in the fixture."""
    def __init__(self):
        self.counts = defaultdict(int)
        self.media_types = {}
        self.lock = threading.Lock()

    def __call__(self, url, payload, headers, timeout):
        if url.endswith("/accountStatus"):
            return {"code": 0, "data": {"remainCoins": "100", "apiType": "NORMAL"}}
        if url.endswith("/getJsonApiFormat"):
            return {"code": 0, "data": {"prompt": json.dumps({
                "6": {"class_type": "CLIPTextEncode", "_meta": {"title": "隔离验证提示词"},
                      "inputs": {"text": "仅验证页面：几何图形样本，不是真实生成", "clip": ["4", 1]}},
                "5": {"class_type": "EmptyLatentImage", "_meta": {"title": "尺寸"},
                      "inputs": {"width": 640, "height": 360, "batch_size": 1}},
            }, ensure_ascii=False)}}
        if url.endswith("/task/openapi/create"):
            task_id = "qa-submission-" + uuid.uuid4().hex[:12]
            with self.lock:
                self.media_types[task_id] = "video" if str(payload.get("workflowId")) == "654321" else "image"
            return {"code": 0, "data": {"taskId": task_id, "taskStatus": "QUEUED"}}
        if url.endswith("/openapi/v2/query"):
            task_id = payload["taskId"]
            with self.lock:
                index = self.counts[task_id]
                self.counts[task_id] += 1
                kind = self.media_types.get(task_id, "video" if "video" in task_id else "image")
            status = ("QUEUED", "RUNNING", "RUNNING", "SUCCESS")[min(index, 3)]
            suffix = "mp4" if kind == "video" else "png"
            outputs = [{"url": f"https://fixture.invalid/sample.{suffix}", "outputType": suffix}] if status == "SUCCESS" else []
            return {"taskId": task_id, "status": status, "results": outputs}
        raise AssertionError("Unexpected fixture endpoint: no network request was made")


class FixtureMediaRegistry(MediaRegistry):
    def poll(self, provider, task_id):
        result = super().poll(provider, task_id)
        # Only this fixture maps validated fake provider results to local test files.
        # Production URL validation and production media adapters remain unchanged.
        for output in result["outputs"]:
            output["url"] = FAKE_ASSETS[output["url"]]
            output["storage"] = "qa-fixture"
        result["evidence"]["fixtureOnly"] = True
        return result


class FixtureHandler(Handler):
    def static(self, path):
        if path not in ASSETS:
            return super().static(path)
        data = ASSETS[path].read_bytes()
        mime = mimetypes.guess_type(path)[0] or "application/octet-stream"
        header = self.headers.get("Range")
        if not header:
            return self.send(200, data, mime, {"Accept-Ranges": "bytes"})
        match = re.fullmatch(r"bytes=(\d*)-(\d*)", header)
        if not match or not any(match.groups()):
            return self.send(416, b"", mime, {"Content-Range": f"bytes */{len(data)}"})
        lower, upper = match.groups()
        start = int(lower) if lower else max(0, len(data) - int(upper))
        end = min(int(upper), len(data) - 1) if lower and upper else len(data) - 1
        if start > end or start >= len(data):
            return self.send(416, b"", mime, {"Content-Range": f"bytes */{len(data)}"})
        return self.send(206, data[start:end + 1], mime,
                         {"Accept-Ranges": "bytes", "Content-Range": f"bytes {start}-{end}/{len(data)}"})


def seed(server):
    timestamp = now()
    server.workspace.save({"expectedRevision": 0, "state": {
        "version": 3, "revision": 0, "presentationVersion": 1, "view": "project",
        "projectTab": "media", "activeProjectId": PROJECT_ID, "favorites": [],
        "projects": [{"id": PROJECT_ID, "title": "影像制作验证 · 仅测试样本",
                      "brief": "隔离 QA：图片和 2 秒视频由本机绘制用于预览与播放验证。任务状态为模拟响应，不调用 RunningHub，不产生真实费用。",
                      "kind": "film", "members": ["R03", "R04", "R11"], "isDemo": False, "createdAt": timestamp}],
        "tasks": [], "decisions": [], "artifacts": [], "messages": [], "activity": [],
    }})
    cases = [("image-complete", "图片预览 · 本机验证样本", "image", "succeeded"),
             ("video-complete", "视频播放 · 2 秒本机验证样本", "video", "succeeded"),
             ("image-progress", "生图过程 · 模拟排队至完成", "image", "queued"),
             ("video-progress", "生视频过程 · 模拟排队至完成", "video", "queued"),
             ("failed", "失败状态 · 模拟错误", "image", "failed"),
             ("unknown", "待核对 · 模拟提交中断", "video", "unknown")]
    for offset, (name, title, kind, status) in enumerate(cases):
        created_at = timestamp - (len(cases) - offset) * 1000
        suffix = "mp4" if kind == "video" else "png"
        outputs = [{"url": f"/assets/qa-media/sample.{suffix}", "outputType": suffix,
                    "storage": "qa-fixture", "downloaded": False}] if status == "succeeded" else []
        job = {"id": "qa-" + name, "requestId": "fixture-" + name, "provider": "runninghub",
               "source": "api", "projectId": PROJECT_ID, "title": title, "mediaType": kind,
               "status": status, "providerStatus": "SUCCESS" if status == "succeeded" else status.upper(),
               "workflowId": "654321" if kind == "video" else "123456", "outputs": outputs,
               "createdAt": created_at, "updatedAt": timestamp,
               "history": [{"id": uuid.uuid4().hex, "type": "created", "status": "submitting",
                            "text": "隔离验证任务；没有调用真实生成服务", "at": created_at},
                           {"id": uuid.uuid4().hex, "type": "status", "status": status,
                            "text": "模拟状态：" + status, "at": timestamp}],
               "parameters": {"nodeInfoList": [{"nodeId": "6", "fieldName": "text", "fieldValue": "仅验证页面与播放器的几何样本"}],
                              "quantity": 1, "unitPrice": 0.1, "unit": "task", "currency": "CNY", "budget": 1},
               "estimate": {"known": True, "estimatedCost": 0.1, "currency": "CNY", "withinBudget": True, "budget": 1},
               "evidence": {"fixtureOnly": True, "downloaded": False, "qualityChecked": False},
               "billingUrl": "https://www.runninghub.cn"}
        if status != "unknown":
            job["task_id"] = "fixture-" + name
        if status == "succeeded":
            job.update(checkedAt=timestamp, lastSuccessfulCheckAt=timestamp)
        if status == "failed":
            job["error"] = {"code": "QA_FAILED", "message": "这是失败状态验证样本，没有真实生成失败。"}
        if status == "unknown":
            job["error"] = "这是提交中断验证样本；没有平台任务编号，不能自动重复提交。"
        server.runtime.save("media", job)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8878)
    args = parser.parse_args()
    if args.port == 8767:
        parser.error("8767 is the production port; choose a separate QA port")
    for fixture in ASSETS.values():
        if not fixture.is_file():
            parser.error("missing local media fixture: " + str(fixture))
    with tempfile.TemporaryDirectory(prefix="dream-studio-media-qa-") as directory:
        runtime = Runtime(directory, FixtureCatalog(), Provider())
        media = FixtureMediaRegistry(Path(directory) / "connections.json", transport=FixtureTransport())
        media.configure("runninghub", {"apiKey": "isolated-ui-fixture-not-a-real-key",
                                      "workflowId": "123456", "unitPrice": 0.1, "currency": "CNY"})
        server = StudioServer(("127.0.0.1", args.port), runtime, media)
        server.RequestHandlerClass = FixtureHandler
        seed(server)
        signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
        print(f"隔离影像验证：http://127.0.0.1:{args.port}/", flush=True)
        print("仅本机样本、模拟任务；不连接真实服务、不写正式数据库。Ctrl+C 停止。", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            server.server_close()
            runtime.close()


if __name__ == "__main__":
    main()

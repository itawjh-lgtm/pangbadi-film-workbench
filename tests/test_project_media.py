"""Project-owned storyboard extraction and media association, entirely offline."""

from copy import deepcopy
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from server.httpd import Handler
from server.media import MediaRegistry, MediaValidationError
from server.runtime import InputError
from server.storyboard import media_project_metadata, project_storyboard


BOARD = """# 分镜工作稿
| 镜号／所属场次 | 时间码／预计时长 | 画面内容与人物动作 |
|---|---:|---|
| **S01／海边** | **00:00—00:05／5秒** | 纸船驶向灯塔。<br>海风轻吹。 |
| **S02／灯塔** | **00:05—00:10／5秒** | 灯塔亮起。 |
"""
PROMPTS = """## S01｜海边纸船
### 镜头信息
| 项目 | 内容 |
|---|---|
| 时间 | 00:00—00:05，5秒 |
| 唯一信息 | 纸船向灯塔行进 |
### 生图提示词
```text
一艘白色纸船，在清晨的海面。
```
### 视频动作提示词
```text
纸船缓慢前进，摄影机固定。
```
## S02｜灯塔亮起
### 生图提示词
```text
海边的白色灯塔，暖色灯光。
```
### 视频动作提示词
```text
灯塔亮起，海浪缓慢移动。
```
"""

HIERARCHICAL_BOARD = "| 镜号／所属场次 | 时间码／预计时长 | 画面内容与人物动作 |\n|---|---|---|\n" + "\n".join(
    f"| **S01-{i:03d}**／走廊 | {2 * (i - 1)}—{2 * i}／2.0 秒 | 本镜动作 {i} |" for i in range(1, 13))
HIERARCHICAL_PROMPTS = """> 暂定画幅：9:16
> 执行状态：未调用任何模型
### 4. 统一视觉提示前缀
下列前缀适用于全部生图提示词，实际使用时与对应镜头正文合并：
> 9:16 竖屏二维漫画，冷灰蓝，清楚主轮廓线。
### 5. 全片统一限制
- 不要把这一整节作为提示词。
""" + "\n".join(f"""## S01-{i:03d}｜镜头动作{i}｜00:{2 * (i - 1):02d}—00:{2 * i:02d}
### 生图提示词
> 少女在走廊完成动作{i}。
### 视频动作提示词
> 固定机位，手部动作{i}。
### 可调参数
- 这是人工执行说明，不应进入模型。
""" for i in range(1, 13))


class MemoryRuntime:
    def __init__(self):
        self.lock = threading.RLock()
        self.records = {}

    def all(self, kind):
        return deepcopy([record for (record_kind, _), record in self.records.items() if record_kind == kind])

    def get(self, kind, key):
        if (kind, key) not in self.records:
            raise InputError("记录不存在", 404)
        return deepcopy(self.records[(kind, key)])

    def save(self, kind, record):
        self.records[(kind, record["id"])] = deepcopy(record)

    def by_request(self, kind, key):
        return next((record for record in self.all(kind) if record.get("requestId") == key), None)


class MemoryWorkspace:
    def __init__(self):
        self.state = {"projects": [{"id": "p", "kind": "film"}, {"id": "other", "kind": "film"},
                                   {"id": "demo", "kind": "film", "isDemo": True}],
                      "tasks": [{"id": "task-p", "projectId": "p", "status": "queued"},
                                {"id": "task-other", "projectId": "other", "status": "queued"}]}

    def read(self):
        return {"revision": 1, "state": deepcopy(self.state)}


class ProjectMediaFixture:
    def setUp(self):
        self.runtime, self.workspace = MemoryRuntime(), MemoryWorkspace()
        self.add_document("board-p", "R04", BOARD, 10)
        self.add_document("prompts-p", "R06", PROMPTS, 20)
        self.add_document("board-other", "R04", BOARD.replace("海边", "other-only"), 50, project="other")
        self.add_document("summary-p", "R11", BOARD.replace("S01", "S99"), 100)

    def add_document(self, artifact_id, author, body, created, project="p", production=None):
        artifact = {"id": artifact_id, "authorId": author, "body": body, "createdAt": created,
                    "title": author + " source", "url": "https://untrusted.example/not-used"}
        run = {"id": "run-" + artifact_id, "projectId": project, "status": "succeeded", "artifacts": [artifact]}
        if production:
            run["productionId"] = production
        self.runtime.save("run", run)
        return artifact

    def context(self, **updates):
        value = {"projectId": "p", "taskId": "task-p", "shotId": "S01", "sourceArtifactId": "board-p",
                 "promptArtifactId": "prompts-p", "name": "S01 · 图片", "mediaKind": "image"}
        value.update(updates)
        return value


class ProjectMediaTests(ProjectMediaFixture, unittest.TestCase):
    def test_hierarchical_shots_pair_quoted_prompts_and_visual_prefix(self):
        self.add_document("hier-board", "R04", HIERARCHICAL_BOARD, 30)
        self.add_document("hier-prompts", "R06", HIERARCHICAL_PROMPTS, 40)
        result = project_storyboard(self.runtime, self.workspace, "p")
        self.assertEqual(len(result["shots"]), 12)
        self.assertEqual(result["warnings"], [])
        for i, shot in enumerate(result["shots"], 1):
            self.assertEqual(shot["id"], f"S01-{i:03d}")
            self.assertEqual(shot["title"], f"镜头动作{i}")
            self.assertEqual(shot["targetDuration"], 2)
            self.assertEqual(shot["aspectRatio"], "9:16")
            self.assertEqual(shot["imagePrompt"].count("9:16 竖屏二维漫画"), 1)
            self.assertTrue(shot["imagePrompt"].endswith(f"少女在走廊完成动作{i}。"))
            self.assertEqual(shot["videoPrompt"], f"固定机位，手部动作{i}。")
            self.assertNotIn("执行说明", shot["imagePrompt"] + shot["videoPrompt"])

    def test_plain_prompt_paragraph_and_timecode_duration(self):
        self.runtime.records.pop(("run", "run-board-p"))
        self.add_document("paragraph-prompts", "R06", """## S02-001｜抬头｜00:02.0—00:03.5
### 生图提示词
女孩在窗前抬头。
眼神坚定。
### 视频动作提示词
她慢慢抬头。
### 执行说明
请确认平台、价格和权重。
""", 40)
        shot = project_storyboard(self.runtime, self.workspace, "p")["shots"][0]
        self.assertEqual(shot["imagePrompt"], "女孩在窗前抬头。\n眼神坚定。")
        self.assertEqual(shot["videoPrompt"], "她慢慢抬头。")
        self.assertEqual(shot["targetDuration"], 1.5)

    def test_reads_only_project_r04_r06_and_keeps_exact_prompt_text(self):
        result = project_storyboard(self.runtime, self.workspace, "p")
        self.assertEqual([shot["id"] for shot in result["shots"]], ["S01", "S02"])
        self.assertEqual([source["id"] for source in result["sources"]], ["board-p", "prompts-p"])
        first = result["shots"][0]
        self.assertEqual(first["imagePrompt"], "一艘白色纸船，在清晨的海面。")
        self.assertEqual(first["videoPrompt"], "纸船缓慢前进，摄影机固定。")
        self.assertEqual(first["description"], "纸船驶向灯塔。\n海风轻吹。")
        self.assertEqual(first["sourceArtifactId"], "board-p")
        self.assertEqual(first["promptArtifactId"], "prompts-p")
        self.assertNotIn("accepted", json.dumps(result))
        self.assertTrue(all(source["url"].startswith("/api/artifacts/") for source in result["sources"]))

    def test_current_production_stages_take_priority_and_body_is_canonical(self):
        board = self.add_document("production-board", "R04", BOARD.replace("海边", "当前原稿"), 5, production="plan-p")
        prompts = self.add_document("production-prompts", "R06", PROMPTS, 6, production="plan-p")
        self.runtime.save("production", {"id": "plan-p", "projectId": "p", "createdAt": 100,
            "stages": [{"id": "storyboard", "agentId": "R04", "artifacts": [{**board, "body": "forged copy"}]},
                       {"id": "prompts", "agentId": "R06", "artifacts": [prompts]}]})
        result = project_storyboard(self.runtime, self.workspace, "p")
        self.assertEqual(result["shots"][0]["sourceArtifactId"], "production-board")
        self.assertEqual(result["shots"][0]["title"], "当前原稿")

    def test_cross_project_artifact_in_production_is_not_adopted(self):
        self.runtime.save("production", {"id": "plan-p", "projectId": "p", "createdAt": 100,
            "stages": [{"id": "storyboard", "artifacts": [{"id": "board-other", "body": BOARD}]}]})
        result = project_storyboard(self.runtime, self.workspace, "p")
        self.assertNotIn("board-other", [source["id"] for source in result["sources"]])

    def test_r11_summary_cannot_impersonate_storyboard_stage(self):
        self.runtime.save("production", {"id": "plan-p", "projectId": "p", "createdAt": 100,
            "stages": [{"id": "storyboard", "agentId": "R04", "artifacts": [{"id": "summary-p"}]}]})
        result = project_storyboard(self.runtime, self.workspace, "p")
        self.assertNotIn("summary-p", [source["id"] for source in result["sources"]])
        self.assertNotIn("S99", [shot["id"] for shot in result["shots"]])

    def test_retired_production_stage_does_not_reappear_as_fallback(self):
        self.runtime.records.pop(("run", "run-board-p"))
        self.runtime.records.pop(("run", "run-prompts-p"))
        old = self.add_document("old-stage", "R04", BOARD, 10, production="plan-p")
        self.runtime.save("production", {"id": "plan-p", "projectId": "p", "createdAt": 100,
            "stages": [{"id": "storyboard", "artifacts": [], "history": [{"artifacts": [old]}]}]})
        result = project_storyboard(self.runtime, self.workspace, "p")
        self.assertEqual(result["shots"], [])
        self.assertEqual(result["sources"], [])
        self.assertTrue(result["warnings"])

    def test_unsupported_format_retains_source_without_inventing_shots(self):
        self.add_document("unsupported", "R04", "这是散文式分镜，没有可解析的镜头表。", 15)
        result = project_storyboard(self.runtime, self.workspace, "p")
        self.assertEqual(result["shots"], [])
        self.assertIn("unsupported", [source["id"] for source in result["sources"]])
        self.assertTrue(any("无法解析" in warning for warning in result["warnings"]))

    def test_older_prompts_are_not_applied_to_new_storyboard(self):
        self.add_document("new-board", "R04", BOARD, 30)
        result = project_storyboard(self.runtime, self.workspace, "p")
        self.assertTrue(result["shots"])
        self.assertTrue(all(not shot["imagePrompt"] and shot["promptArtifactId"] is None for shot in result["shots"]))
        self.assertTrue(any("早于" in warning for warning in result["warnings"]))

    def test_prompt_only_source_uses_explicit_section_ids(self):
        self.runtime.records.pop(("run", "run-board-p"))
        result = project_storyboard(self.runtime, self.workspace, "p")
        self.assertEqual([shot["id"] for shot in result["shots"]], ["S01", "S02"])
        self.assertTrue(all(shot["sourceArtifactId"] == "prompts-p" for shot in result["shots"]))

    def test_demo_and_missing_projects_do_not_read_real_artifacts(self):
        self.add_document("demo-board", "R04", BOARD, 1, project="demo")
        self.assertEqual(project_storyboard(self.runtime, self.workspace, "demo")["sources"], [])
        with self.assertRaises(InputError):
            project_storyboard(self.runtime, self.workspace, "missing")

    def test_association_rejects_missing_foreign_and_stale_targets(self):
        for updates in ({"projectId": "missing"}, {"projectId": "demo"}, {"taskId": "task-other"},
                        {"sourceArtifactId": "board-other"}, {"promptArtifactId": "board-other"},
                        {"sourceArtifactId": None}, {"shotId": "S99"}, {"name": ""}, {"mediaKind": "audio"}):
            with self.subTest(updates=updates), self.assertRaises(InputError):
                media_project_metadata(self.runtime, self.workspace, self.context(**updates))
        self.assertEqual(media_project_metadata(self.runtime, self.workspace, self.context()), self.context())
        self.add_document("updated-board", "R04", BOARD, 40)
        with self.assertRaises(InputError):
            media_project_metadata(self.runtime, self.workspace, self.context())

    def test_unscoped_generation_is_compatible_but_cannot_claim_links(self):
        self.assertEqual(media_project_metadata(self.runtime, self.workspace, {}), {})
        for data in ({"taskId": "task-p"}, {"sourceArtifactId": "board-p"}, {"projectId": ""}, {"mediaKind": "invalid"}):
            with self.assertRaises(InputError):
                media_project_metadata(self.runtime, self.workspace, data)


class ProjectMediaHttpTests(ProjectMediaFixture, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.calls = []
        self.media = MediaRegistry(Path(self.temp.name) / "connections.json", self.transport)
        self.media.configure("runninghub", {"apiKey": "fake-test-key"})
        self.handler = object.__new__(Handler)
        self.handler.server = type("Server", (), {"runtime": self.runtime, "workspace": self.workspace, "media": self.media})()
        self.responses = []
        self.handler.send = lambda status, body: self.responses.append((status, deepcopy(body)))
        self.handler.guard = lambda write=False: None
        self.payload = {"provider": "runninghub", "requestId": "media-one", "workflowId": "123", "nodeInfoList": [],
                        "quantity": 1, "unitPrice": 1, "unit": "次", "currency": "CNY", "budget": 2,
                        **self.context()}

    def transport(self, url, payload, headers, timeout):
        self.calls.append((url, deepcopy(payload)))
        if url.endswith("/query"):
            return {"taskId": "platform-one", "status": "SUCCESS", "results": [{"url": "https://cdn.example.com/one.png", "outputType": "png"}]}
        return {"code": 0, "data": {"taskId": "platform-one", "taskStatus": "QUEUED"}}

    def quote(self):
        self.handler.post("/api/media/estimate", ["api", "media", "estimate"], self.payload)
        self.payload["estimateToken"] = self.responses[-1][1]["estimate"]["estimateToken"]
        self.payload["confirmCost"] = True

    def test_storyboard_route_and_estimate_validate_project_without_generation(self):
        self.handler.path = "/api/projects/p/storyboard"
        self.handler.handle_request(False)
        self.assertEqual(len(self.responses[-1][1]["shots"]), 2)
        with self.assertRaises(InputError):
            self.handler.post("/api/media/estimate", ["api", "media", "estimate"], {**self.payload, "taskId": "task-other"})
        self.assertEqual(self.calls, [])

    def test_submit_and_refresh_preserve_association_without_changing_workspace(self):
        before = deepcopy(self.workspace.state)
        self.quote()
        self.handler.submit_media(self.payload)
        self.handler.submit_media(self.payload)
        job = self.responses[-1][1]["job"]
        self.assertEqual(len(self.calls), 1)
        for field, value in self.context().items():
            self.assertEqual(job[field], value)
        self.assertNotIn("fake-test-key", json.dumps(job))
        path = "/api/media/jobs/" + job["id"] + "/refresh"
        self.handler.post(path, path.strip("/").split("/"), {})
        refreshed = self.responses[-1][1]["job"]
        self.assertEqual(refreshed["status"], "succeeded")
        self.assertEqual(refreshed["shotId"], "S01")
        self.assertFalse(refreshed["outputs"][0]["downloaded"])
        self.assertEqual(self.workspace.state, before)

    def test_changed_context_requires_new_quote(self):
        self.quote()
        with self.assertRaises(MediaValidationError):
            self.handler.submit_media({**self.payload, "shotId": "S02"})
        self.assertEqual(self.calls, [])

    def test_stale_source_rejected_before_submission(self):
        self.quote()
        self.add_document("new-board-p", "R04", BOARD, 30)
        with self.assertRaises(InputError):
            self.handler.submit_media(self.payload)
        self.assertEqual(self.calls, [])
        self.assertEqual(self.runtime.all("media"), [])

    def test_existing_job_remains_readable_after_source_changes(self):
        self.quote()
        self.handler.submit_media(self.payload)
        self.add_document("new-board-p", "R04", BOARD, 30)
        self.handler.submit_media(self.payload)
        self.assertEqual(len(self.calls), 1)
        self.runtime.save("media", {"id": "legacy", "status": "succeeded", "outputs": []})
        self.handler.path = "/api/media/jobs"
        self.handler.handle_request(False)
        self.assertEqual(len(self.responses[-1][1]["jobs"]), 2)


if __name__ == "__main__":
    unittest.main()

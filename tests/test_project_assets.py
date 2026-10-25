"""Project characters use real confirmed outputs; fake media only, no network."""
from copy import deepcopy
import unittest
from unittest.mock import patch

from server.canvas import _hash, DEFAULT_MODELS, CHARACTER_IMAGE_MODEL, SHOT_VIDEO_MODEL
from server.httpd import Handler
from server.media import MediaValidationError
from server.project_assets import character_drafts, image_output
from server.runtime import InputError
from server.trash import TrashManager
import test_canvas as canvas_fixtures


VISUAL = """# 本项目原创占位美术设定
## 三、整体风格规则
二维漫画，低饱和冷灰蓝色，清楚的轮廓。
## 四、角色视觉设定
## 4.1 少女｜主角占位设计
16至18岁观感，短椭圆脸，左额发缺口，深棕黑及肩发。灰蓝开衫、米白衬衫、灰裙、旧白鞋。
## 4.2 女生甲｜对立角色占位设计
窄长脸，深栗长发，右鬓收耳后。海军蓝外层、暗酒红领结、乐福鞋。
## 4.3 围观同学｜群像占位设计
三位不同身高、肩形、书包的同学，避免复制同一张脸。
## 资产摘要
| 编号 | 人物 | 状态 |
|---|---|---|
| CHR-MAIN-PLACEHOLDER | 少女 | 未生成 |
| CHR-ANT-PLACEHOLDER | 女生甲 | 未生成 |
| CHR-CROWD-01 | 围观同学 | 未生成 |
"""
PROMPTS = """# 逐镜提示词
#### 主角少女｜`CHR-MAIN-PLACEHOLDER`
脸型、发型、服装保持 R05 设定。
#### 女生甲｜`CHR-ANT-PLACEHOLDER`
右鬓收耳后。
#### 围观同学｜`CHR-CROWD-01`
三位同学各不相同。
| 参考图 | 内容 |
|---|---|
| CH-MAIN-01 | 少女头部 |
| CH-MAIN-02 | 少女全身 |
| CH-ANT-01 | 女生甲头部全身 |
| CH-GRP-01 | 围观同学群像 |
## S01-001｜对峙
**引用角色／场景：** 主角少女、女生甲局部。
**所需参考图：** CH-MAIN-01/02、CH-ANT-01。
### 生图提示词
> 9:16 竖屏二维漫画，少女站在走廊，女生甲在画面左侧。
### 视频动作提示词
> 固定机位，少女缓慢抬头看向左侧。
## S01-002｜空镜
**引用角色／场景：** 无人物，仅走廊。
### 生图提示词
> 9:16 竖屏二维漫画，空无一人的学校走廊。
### 视频动作提示词
> 固定机位，窗外树影微微移动。
## S01-003｜群像
**所需参考图：** CH-GRP-01。
### 生图提示词
> 9:16 竖屏二维漫画，三个不同身高的同学站在走廊右侧。
### 视频动作提示词
> 固定机位，同学们缓慢转过头。
"""
BOARD = """| 镜号／所属场次 | 时间码／预计时长 | 画面内容与人物动作 |
|---|---|---|
| S01-001／走廊 | 00:00—00:02／2秒 | 少女与女生甲对峙。 |
| S01-002／走廊 | 00:02—00:04／2秒 | 空走廊。 |
| S01-003／走廊 | 00:04—00:06／2秒 | 同学们围观。 |
"""


class ProjectAssetTests(unittest.TestCase):
    setUp = canvas_fixtures.CanvasTests.setUp
    transport = canvas_fixtures.CanvasTests.transport
    add_confirmed_sources = canvas_fixtures.CanvasTests.add_confirmed_sources
    save_nodes = canvas_fixtures.CanvasTests.save_nodes
    step = canvas_fixtures.CanvasTests.step

    def sources(self):
        self.add_confirmed_sources(BOARD, PROMPTS)
        artifact = {"id": "visual-source", "authorId": "R05", "body": VISUAL, "createdAt": 15}
        self.runtime.save("run", {"id": "run-visual", "projectId": "p", "productionId": "production-p",
                                  "status": "succeeded", "artifacts": [artifact]})
        plan = self.runtime.get("production", "production-p")
        plan["stages"].insert(1, {"id": "visual", "agentId": "R05", "status": "completed",
            "artifacts": [artifact], "outputArtifactIds": [artifact["id"]]})
        self.runtime.save("production", plan)
        return self.manager.get("p")

    def job(self, node, ident="image-job", **changes):
        execution = self.manager._request("p", node, None) if node.get("nodeKind") == "shot" and node["mediaKind"] == "image" else {}
        job = {"id": ident, "projectId": "p", "canvasNodeId": node["id"], "mediaKind": "image",
               "canvasNodeHash": _hash(self.manager._execution_node(node)), "status": "succeeded",
               "parameters": execution.get("parameters", {}), "characterReferenceSnapshot": execution.get("characterReferenceSnapshot", []),
               "outputs": [{"url": "https://cdn.example.com/" + ident + ".png", "outputType": "png"}], **changes}
        self.runtime.save("media", job)
        canvas = self.manager._stored("p")
        stored = next(n for n in canvas["nodes"] if n["id"] == node["id"])
        stored.setdefault("jobIds", []).append(ident)
        self.runtime.save("canvas", canvas)
        return job

    def confirm(self, asset, job):
        return self.manager.confirm_asset("p", asset["id"], {"expectedRevision": self.manager._stored("p")["revision"],
                                         "jobId": job["id"], "outputIndex": 0})

    def ready_all(self):
        canvas = self.sources()
        for asset in canvas["characterAssets"]:
            node = next(n for n in canvas["nodes"] if n["id"] == asset["nodeId"])
            self.confirm(asset, self.job(node, "job-" + asset["sourceAssetId"]))
        return self.manager.get("p")

    def test_confirmed_text_extracts_three_traceable_drafts_without_generation(self):
        canvas = self.sources()
        assets = canvas["characterAssets"]
        self.assertEqual([a["name"] for a in assets], ["少女", "女生甲", "围观同学"])
        self.assertEqual({a["status"] for a in assets}, {"draft"})
        self.assertTrue(all(a["sourceArtifactId"] == "visual-source" and a["sourceRange"] for a in assets))
        self.assertTrue(all(a["sourceNature"] == "placeholder" for a in assets))
        self.assertTrue(all("走廊" not in a["prompt"] for a in assets))
        self.assertEqual(len(canvas["nodes"]), 9)
        self.assertEqual(sum(n["selected"] for n in canvas["nodes"]), 3)
        first, empty, group = [n for n in canvas["nodes"] if n.get("nodeKind") == "shot" and n["mediaKind"] == "image"]
        self.assertEqual(first["characterAssetIds"], [a["id"] for a in assets[:2]])
        self.assertEqual(group["characterAssetIds"], [assets[2]["id"]])
        self.assertEqual(empty["characterAssetIds"], [])
        self.assertEqual(first["modelId"], CHARACTER_IMAGE_MODEL)
        self.assertEqual(empty["modelId"], DEFAULT_MODELS["image"])
        self.assertEqual((first["parameters"]["width"], first["parameters"]["height"]), (1152, 2048))
        self.assertNotIn("resolution", first["parameters"])
        self.assertIn("正面、侧面、背面", assets[0]["prompt"])
        self.assertIn("无文字定妆", assets[0]["prompt"])
        self.assertIn("禁止复制同一张脸", assets[2]["prompt"])
        self.assertIn("尚未生成或审图", assets[0]["prompt"])
        with self.assertRaisesRegex(InputError, "先生成并确认人物"):
            self.manager._request("p", first, None)
        self.assertEqual(self.manager._request("p", empty, None)["parameters"]["prompt"], empty["prompt"])
        self.assertEqual(self.calls, [])
        self.assertEqual(self.runtime.all("media"), [])
        self.assertEqual(self.manager.get("p")["revision"], canvas["revision"])

    def test_visual_review_can_import_before_final_storyboard_but_is_not_image_approval(self):
        self.sources()
        plan = self.runtime.get("production", "production-p")
        plan["status"] = "running"
        visual = next(s for s in plan["stages"] if s["id"] == "visual")
        visual["review"] = {"action": "approve", "reviewer": "user", "artifactIds": ["visual-source"]}
        plan["stages"][-1]["review"] = None
        self.runtime.save("production", plan)
        source = character_drafts(self.runtime, "p")
        self.assertEqual(len(source["assets"]), 3)
        self.assertTrue(all("referenceUrl" not in a for a in source["assets"]))
        visual["review"]["artifactIds"] = ["old-version"]
        self.runtime.save("production", plan)
        self.assertEqual(character_drafts(self.runtime, "p")["assets"], [])

    def test_manual_asset_and_actual_image_confirmation_are_project_scoped(self):
        canvas = self.manager.get("p")
        canvas = self.manager.add_asset("p", {"name": "小满", "prompt": "卷发的小满，米白外套，中性背景完整人物造型", "expectedRevision": canvas["revision"]})
        asset, node = canvas["characterAssets"][0], canvas["nodes"][0]
        self.assertTrue(asset["manual"])
        self.assertEqual(node["nodeKind"], "character")
        for index, change in enumerate(({"projectId": "other"}, {"canvasNodeId": "other-node"}, {"canvasNodeHash": "old"},
                       {"status": "running"}, {"mediaKind": "video"}, {"outputs": [{"url": "https://cdn.example.com/file.mp4"}]})):
            with self.subTest(change=change):
                job = self.job(node, "invalid-" + str(index), **change)
                with self.assertRaises(InputError):
                    self.confirm(asset, job)
        job = self.job(node)
        self.assertEqual(self.manager.get("p")["characterAssets"][0]["status"], "pending_review")
        ready = self.confirm(asset, job)["characterAssets"][0]
        self.assertEqual(ready["status"], "ready")
        self.assertEqual(ready["referenceUrl"], job["outputs"][0]["url"])
        self.assertEqual(self.calls, [])
        self.assertEqual(self.tasks, {})

    def test_confirmed_references_are_recomputed_and_cannot_be_cleared_by_client(self):
        canvas = self.ready_all()
        image = next(n for n in canvas["nodes"] if n.get("shotId") == "S01-001" and n["mediaKind"] == "image")
        image["characterAssetIds"] = []
        image["parameters"]["imageUrls"] = ["https://cdn.example.com/forged.png"]
        image["shotId"] = None
        image["sourceVersion"] = ""
        image["sourceArtifactId"] = None
        saved = self.save_nodes(canvas["nodes"])
        actual = next(n for n in saved["nodes"] if n["id"] == image["id"])
        self.assertEqual(actual["shotId"], "S01-001")
        self.assertEqual(actual["sourceArtifactId"], "storyboard-source")
        request = self.manager._request("p", actual, None)
        self.assertEqual(request["parameters"]["imageUrls"], [a["referenceUrl"] for a in saved["characterAssets"][:2]])
        self.assertEqual(self.calls, [])
        self.assertEqual(self.tasks, {})

    def test_editing_confirmed_character_invalidates_reference_but_keeps_history(self):
        canvas = self.ready_all()
        asset = canvas["characterAssets"][0]
        original_url = asset["referenceUrl"]
        node = next(n for n in canvas["nodes"] if n["id"] == asset["nodeId"])
        node["prompt"] += "，眼睛更有神"
        node["parameters"]["prompt"] = node["prompt"]
        saved = self.save_nodes(canvas["nodes"])
        self.assertEqual(saved["characterAssets"][0]["status"], "stale")
        image = next(n for n in saved["nodes"] if n.get("shotId") == "S01-001" and n["mediaKind"] == "image")
        with self.assertRaisesRegex(InputError, "提示词或参数已修改"):
            self.manager._request("p", image, None)
        new_job = self.job(next(n for n in saved["nodes"] if n["id"] == node["id"]), "updated-character")
        candidate = self.manager.get("p")["characterAssets"][0]
        self.assertEqual(candidate["status"], "pending_review")
        self.assertEqual(candidate["reviewCandidate"], {"jobId": new_job["id"], "outputIndex": 0, "url": new_job["outputs"][0]["url"]})
        self.assertEqual(candidate["referenceUrl"], original_url)
        self.assertFalse(candidate["referenceUsable"])
        updated = self.confirm(asset, new_job)["characterAssets"][0]
        self.assertEqual(updated["status"], "ready")
        self.assertEqual(updated["version"], 2)
        self.assertEqual(updated["history"][0]["referenceUrl"], original_url)
        self.assertEqual(updated["referenceUrl"], new_job["outputs"][0]["url"])
        self.assertNotIn("reviewCandidate", updated)
        self.assertTrue(updated["referenceUsable"])

    def test_video_requires_successful_current_same_shot_image(self):
        canvas = self.ready_all()
        image = next(n for n in canvas["nodes"] if n.get("shotId") == "S01-001" and n["mediaKind"] == "image")
        video = next(n for n in canvas["nodes"] if n.get("shotId") == "S01-001" and n["mediaKind"] == "video")
        self.assertEqual(video["modelId"], SHOT_VIDEO_MODEL)
        self.assertEqual(video["referenceNodeId"], image["id"])
        video["parameters"]["firstFrameUrl"] = "https://cdn.example.com/forged.png"
        with self.assertRaisesRegex(InputError, "先生成分镜图片"):
            self.manager._request("p", video, None)
        job = self.job(image, "shot-image")
        request = self.manager._request("p", video, None)
        self.assertEqual(request["parameters"]["firstFrameUrl"], job["outputs"][0]["url"])
        self.assertNotIn("imageUrls", request["parameters"])
        video["referenceNodeId"] = next(n["id"] for n in canvas["nodes"] if n.get("shotId") == "S01-002" and n["mediaKind"] == "image")
        with self.assertRaisesRegex(InputError, "本镜头当前版本"):
            self.manager._request("p", video, None)
        video["referenceNodeId"] = image["id"]
        image["prompt"] += "，改为雨天"
        self.save_nodes(canvas["nodes"])
        with self.assertRaisesRegex(InputError, "先生成分镜图片"):
            self.manager._request("p", video, None)
        self.assertEqual(self.calls, [])

    def test_soft_deleted_project_source_node_or_media_blocks_reference_and_restore_does_not_generate(self):
        canvas = self.ready_all()
        asset = canvas["characterAssets"][0]
        image = next(n for n in canvas["nodes"] if n.get("shotId") == "S01-001" and n["mediaKind"] == "image")
        trash = TrashManager(self.runtime, self.workspace)
        for kind, ident in (("media", asset["referenceJobId"]), ("canvas_node", asset["nodeId"]),
                            ("artifact", asset["sourceArtifactId"]), ("project", "p")):
            with self.subTest(kind=kind):
                entries = trash.delete({"kind": kind, "targetId": ident, "projectId": "p"})
                with self.assertRaises(InputError):
                    self.manager.estimate("p", {"nodeIds": [image["id"]]})
                for entry in entries:
                    trash.restore(entry["id"])
                self.assertEqual(self.manager.get("p")["characterAssets"][0]["status"], "ready")
        self.assertEqual(self.calls, [])
        self.assertEqual(self.tasks, {})

    def test_new_visual_version_preserves_edited_old_assets_and_positions_new_nodes_without_overlap(self):
        canvas = self.ready_all()
        old_assets = deepcopy(canvas["characterAssets"])
        old_node = next(n for n in canvas["nodes"] if n["id"] == old_assets[0]["nodeId"])
        old_node["prompt"] += "用户自己的标记"
        saved = self.save_nodes(canvas["nodes"])
        artifact = {"id": "visual-source-v2", "authorId": "R05", "body": VISUAL.replace("灰蓝开衫", "深蓝开衫"), "createdAt": 40}
        self.runtime.save("run", {"id": "visual-v2-run", "projectId": "p", "productionId": "production-p", "status": "succeeded", "artifacts": [artifact]})
        plan = self.runtime.get("production", "production-p")
        visual = next(s for s in plan["stages"] if s["id"] == "visual")
        visual.update(artifacts=[artifact], outputArtifactIds=[artifact["id"]])
        self.runtime.save("production", plan)
        updated = self.manager.get("p")
        self.assertEqual(len(updated["characterAssets"]), 6)
        self.assertTrue(all(a["status"] == "stale" for a in updated["characterAssets"][:3]))
        preserved = next(n for n in updated["nodes"] if n["id"] == old_node["id"])
        self.assertEqual(preserved["prompt"], old_node["prompt"])
        self.assertEqual(preserved["position"], next(n["position"] for n in saved["nodes"] if n["id"] == preserved["id"]))
        self.assertEqual(updated["characterAssets"][1]["referenceJobId"], old_assets[1]["referenceJobId"])
        positions = [(n["position"]["x"], n["position"]["y"]) for n in updated["nodes"]]
        self.assertEqual(len(set(positions)), len(positions))
        self.assertEqual(self.calls, [])

    def test_malformed_asset_ids_fail_validation_instead_of_server_error(self):
        canvas = self.sources()
        canvas["nodes"][0]["characterAssetIds"] = [{"malformed": True}]
        with self.assertRaisesRegex(InputError, "最多关联"):
            self.save_nodes(canvas["nodes"])

    def test_deleted_visual_cannot_be_bypassed_by_clearing_client_asset_list(self):
        canvas = self.ready_all()
        image = next(n for n in canvas["nodes"] if n.get("shotId") == "S01-001" and n["mediaKind"] == "image")
        image["characterAssetIds"] = []
        image["parameters"]["imageUrls"] = ["https://cdn.example.com/forged.png"]
        saved = self.save_nodes(canvas["nodes"])
        TrashManager(self.runtime, self.workspace).delete({"kind": "artifact", "targetId": "visual-source", "projectId": "p"})
        with self.assertRaises(InputError):
            self.manager.estimate("p", {"nodeIds": [image["id"]]})
        self.assertEqual(self.calls, [])

    def test_asset_http_routes_return_new_canvas_and_never_submit_media(self):
        canvas = self.manager.get("p")
        handler = object.__new__(Handler)
        handler.server = type("Server", (), {"runtime": self.runtime, "workspace": self.workspace,
            "media": self.media, "canvas": self.manager})()
        responses = []
        handler.send = lambda status, body: responses.append((status, deepcopy(body)))
        path = "/api/projects/p/canvas/assets"
        handler.post(path, path.strip("/").split("/"), {"name": "小满", "prompt": "卷发小满的完整全身角色造型，米白外套，中性背景", "expectedRevision": canvas["revision"]})
        self.assertEqual(responses[-1][0], 201)
        canvas = responses[-1][1]["canvas"]
        asset, node = canvas["characterAssets"][0], canvas["nodes"][0]
        job = self.job(node)
        path += "/" + asset["id"] + "/confirm"
        handler.post(path, path.strip("/").split("/"), {"jobId": job["id"], "outputIndex": 0, "expectedRevision": canvas["revision"]})
        self.assertEqual(responses[-1][0], 200)
        self.assertEqual(responses[-1][1]["canvas"]["characterAssets"][0]["status"], "ready")
        self.assertFalse(responses[-1][1]["canvas"]["nodes"][0]["selected"])
        self.assertEqual(self.calls, [])
        self.assertEqual(self.tasks, {})

    def test_video_rejects_stale_character_and_old_frame_after_same_url_new_confirmation(self):
        canvas = self.ready_all()
        asset = canvas["characterAssets"][0]
        character = next(n for n in canvas["nodes"] if n["id"] == asset["nodeId"])
        image = next(n for n in canvas["nodes"] if n.get("shotId") == "S01-001" and n["mediaKind"] == "image")
        video = next(n for n in canvas["nodes"] if n.get("shotId") == "S01-001" and n["mediaKind"] == "video")
        old_image = self.job(image, "old-shot-image")
        self.assertEqual(self.manager._request("p", video, None)["parameters"]["firstFrameUrl"], old_image["outputs"][0]["url"])
        character["prompt"] += "，改为更清楚的发型轮廓"
        character["parameters"]["prompt"] = character["prompt"]
        saved = self.save_nodes(canvas["nodes"])
        with self.assertRaisesRegex(InputError, "人物提示词或参数已修改"):
            self.manager._request("p", video, None)
        changed_character = next(n for n in saved["nodes"] if n["id"] == character["id"])
        # Reusing a CDN URL does not erase the new generation/approval version.
        new_character = self.job(changed_character, "new-character", outputs=[{"url": asset["referenceUrl"], "outputType": "png"}])
        ready = self.confirm(asset, new_character)
        self.assertEqual(ready["characterAssets"][0]["version"], 2)
        with self.assertRaisesRegex(InputError, "先生成分镜图片"):
            self.manager._request("p", video, None)
        current_image = next(n for n in ready["nodes"] if n["id"] == image["id"])
        new_image = self.job(current_image, "new-shot-image")
        self.assertEqual(self.manager._request("p", video, None)["parameters"]["firstFrameUrl"], new_image["outputs"][0]["url"])
        self.assertEqual(self.calls, [])

    def test_video_rejects_missing_or_mismatched_character_input_evidence(self):
        canvas = self.ready_all()
        image = next(n for n in canvas["nodes"] if n.get("shotId") == "S01-001" and n["mediaKind"] == "image")
        video = next(n for n in canvas["nodes"] if n.get("shotId") == "S01-001" and n["mediaKind"] == "video")
        job = self.job(image, "reference-evidence")
        for field, value in (("characterReferenceSnapshot", None), ("characterReferenceSnapshot", []),
                             ("parameters", {}), ("parameters", {"imageUrls": ["https://cdn.example.com/other.png"]}),
                             ("canvasNodeHash", None)):
            with self.subTest(field=field, value=value):
                changed = deepcopy(job)
                if value is None:
                    changed.pop(field)
                else:
                    changed[field] = value
                self.runtime.save("media", changed)
                with self.assertRaisesRegex(InputError, "先生成分镜图片"):
                    self.manager._request("p", video, None)
        self.runtime.save("media", job)
        self.assertEqual(self.manager._request("p", video, None)["parameters"]["firstFrameUrl"], job["outputs"][0]["url"])
        self.assertEqual(self.calls, [])

    def test_confirm_batch_is_atomic_and_repeating_identical_confirmation_is_idempotent(self):
        canvas = self.sources()
        items = []
        for index, asset in enumerate(canvas["characterAssets"]):
            node = next(n for n in canvas["nodes"] if n["id"] == asset["nodeId"])
            job = self.job(node, "batch-character-" + str(index))
            items.append({"assetId": asset["id"], "jobId": job["id"], "outputIndex": 0})
        before = self.manager._stored("p")
        invalid = deepcopy(items)
        invalid[1]["outputIndex"] = 99
        with self.assertRaises(InputError):
            self.manager.confirm_assets("p", {"items": invalid, "expectedRevision": before["revision"]})
        self.assertEqual(self.manager._stored("p"), before)
        with self.assertRaises(InputError):
            self.manager.confirm_assets("p", {"items": [items[0], items[0]], "expectedRevision": before["revision"]})
        self.assertEqual(self.manager._stored("p"), before)
        handler = object.__new__(Handler)
        handler.server = type("Server", (), {"runtime": self.runtime, "workspace": self.workspace,
            "media": self.media, "canvas": self.manager})()
        responses = []
        handler.send = lambda status, body: responses.append((status, deepcopy(body)))
        path = "/api/projects/p/canvas/assets/confirm-batch"
        handler.post(path, path.strip("/").split("/"), {"items": items, "expectedRevision": before["revision"]})
        ready = responses[-1][1]["canvas"]
        self.assertEqual(responses[-1][0], 200)
        self.assertEqual(ready["revision"], before["revision"] + 1)
        self.assertEqual([a["status"] for a in ready["characterAssets"]], ["ready"] * 3)
        repeated = self.manager.confirm_assets("p", {"items": items, "expectedRevision": ready["revision"]})
        self.assertEqual(repeated["revision"], ready["revision"])
        self.assertTrue(all(a["version"] == 1 and a["history"] == [] for a in repeated["characterAssets"]))
        self.assertEqual(self.calls, [])
        self.assertEqual(self.tasks, {})

    def test_character_change_after_image_quote_blocks_submission(self):
        canvas = self.ready_all()
        image = next(n for n in canvas["nodes"] if n.get("shotId") == "S01-001" and n["mediaKind"] == "image")
        quote = self.manager.estimate("p", {"nodeIds": [image["id"]]})
        asset = canvas["characterAssets"][0]
        character = next(n for n in canvas["nodes"] if n["id"] == asset["nodeId"])
        updated = self.job(character, "reconfirmed-character", outputs=[{"url": asset["referenceUrl"], "outputType": "png"}])
        self.confirm(asset, updated)
        with self.assertRaises(InputError):
            self.manager.generate("p", {"estimateToken": quote["estimateToken"], "requestId": "changed-character-quote", "confirmCost": True})
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.tasks, {})

    def test_generated_shot_persists_character_evidence_for_video(self):
        canvas = self.ready_all()
        image = next(n for n in canvas["nodes"] if n.get("shotId") == "S01-001" and n["mediaKind"] == "image")
        video = next(n for n in canvas["nodes"] if n.get("shotId") == "S01-001" and n["mediaKind"] == "video")
        quote = self.manager.estimate("p", {"nodeIds": [image["id"]]})
        batch = self.manager.generate("p", {"estimateToken": quote["estimateToken"], "requestId": "shot-with-character-evidence", "confirmCost": True})
        with patch.object(self.media, "poll", wraps=self.media.poll) as poll:
            for _ in range(4):
                self.step()
            self.assertEqual(poll.call_args.kwargs["model_id"], image["modelId"])
        job = next(job for job in self.runtime.all("media") if job.get("batchId") == batch["id"])
        self.assertEqual(job["status"], "succeeded")
        self.assertEqual([a["assetId"] for a in job["characterReferenceSnapshot"]], image["characterAssetIds"])
        self.assertEqual(job["parameters"]["imageUrls"], [a["referenceUrl"] for a in canvas["characterAssets"][:2]])
        self.assertEqual(self.manager._request("p", video, None)["parameters"]["firstFrameUrl"], job["outputs"][0]["url"])
        self.assertEqual(len(self.tasks), 1)

    def test_auto_prompt_template_does_not_overwrite_existing_personal_edits(self):
        canvas = self.sources()
        character = next(n for n in canvas["nodes"] if n["nodeKind"] == "character")
        character["prompt"] = "用户保留的造型文稿，保持原有服装特征"
        character["parameters"]["prompt"] = character["prompt"]
        saved = self.save_nodes(canvas["nodes"])
        current = self.manager.get("p")
        self.assertEqual(next(n for n in current["nodes"] if n["id"] == character["id"])["prompt"], character["prompt"])
        self.assertEqual(current["revision"], saved["revision"])

    def test_assets_page_full_document_save_keeps_hidden_shots_and_outputs(self):
        canvas = self.ready_all()
        image = next(n for n in canvas["nodes"] if n.get("shotId") == "S01-001" and n["mediaKind"] == "image")
        job = self.job(image, "hidden-shot-result")
        canvas = self.manager.get("p")
        before = {n["id"]: deepcopy(n) for n in self.manager._stored("p")["nodes"] if n["nodeKind"] == "shot"}
        character = next(n for n in canvas["nodes"] if n["nodeKind"] == "character")
        character["prompt"] += "，人物页内修改服装层次"
        character["parameters"]["prompt"] = character["prompt"]
        self.save_nodes(canvas["nodes"])
        after = {n["id"]: n for n in self.manager._stored("p")["nodes"] if n["nodeKind"] == "shot"}
        self.assertEqual(after, before)
        self.assertEqual(self.runtime.get("media", job["id"])["outputs"], job["outputs"])
        self.assertEqual(len(self.manager.get("p")["nodes"]), 9)
        self.assertEqual(self.calls, [])

    def test_either_page_may_omit_hidden_nodes_without_deleting_them(self):
        canvas = self.ready_all()
        original_ids = {n["id"] for n in canvas["nodes"]}
        original_assets = deepcopy(self.manager._stored("p")["characterAssets"])
        for kind in ("character", "shot"):
            with self.subTest(kind=kind):
                current = self.manager.get("p")
                visible = [n for n in current["nodes"] if n["nodeKind"] == kind]
                saved = self.manager.save("p", {"expectedRevision": current["revision"], "nodes": visible})
                self.assertEqual({n["id"] for n in saved["nodes"]}, original_ids)
                self.assertEqual(self.manager._stored("p")["characterAssets"], original_assets)
        self.assertEqual(self.calls, [])

    def test_assets_batch_uses_explicit_character_ids_even_if_hidden_shots_selected(self):
        canvas = self.sources()
        for node in canvas["nodes"]:
            node["selected"] = True
        saved = self.save_nodes(canvas["nodes"])
        character_ids = [n["id"] for n in saved["nodes"] if n["nodeKind"] == "character"]
        quote = self.manager.estimate("p", {"nodeIds": character_ids, "expectedRevision": saved["revision"]})
        self.assertEqual(quote["nodeIds"], character_ids)
        self.assertEqual({item["nodeId"] for item in quote["items"]}, set(character_ids))
        self.assertEqual(len(self.calls), 3)
        self.assertTrue(all("price-preview" in url for url, _ in self.calls))
        self.assertEqual(self.tasks, {})
        self.assertEqual(self.runtime.all("media"), [])

    def test_old_retired_model_on_character_is_preserved_but_cannot_quote(self):
        canvas = self.sources()
        character = next(n for n in canvas["nodes"] if n["nodeKind"] == "character")
        character["modelId"] = "rhart-image-g-2-official/text-to-image"
        character["parameters"] = {"prompt": character["prompt"], "resolution": "2k", "aspectRatio": "3:4"}
        saved = self.save_nodes(canvas["nodes"])
        current = next(n for n in saved["nodes"] if n["id"] == character["id"])
        self.assertEqual(current["modelId"], character["modelId"])
        with self.assertRaisesRegex(MediaValidationError, "40310"):
            self.manager.estimate("p", {"nodeIds": [current["id"]]})
        self.assertEqual(self.calls, [])
        self.assertEqual(self.tasks, {})
        self.assertEqual(self.runtime.all("canvas_estimate"), [])

    def test_idle_old_default_pair_migrates_once_without_relayout_or_losing_drafts(self):
        self.sources()
        canvas = self.manager._stored("p")
        before = {}
        for node in canvas["nodes"]:
            if node["mediaKind"] != "image":
                continue
            node["modelId"] = ("rhart-image-n-pro-official/edit-ultra" if node.get("characterAssetIds")
                               else "rhart-image-n-pro-official/text-to-image-ultra")
            node.pop("modelSelectionOrigin", None)  # Historical automatic node.
            node.update(prompt=node["prompt"] + "，用户手工补充", selected=True, position={"x": 913, "y": 77})
            node["parameters"] = {"prompt": node["prompt"], "resolution": "8k", "aspectRatio": "3:4"}
            node["parameterDraft"] = {"aspectRatio": "9:16", "outputFormat": "jpeg"}
            before[node["id"]] = deepcopy(node)
        assets = deepcopy(canvas["characterAssets"])
        self.runtime.save("canvas", canvas)
        migrated = self.manager.get("p")
        self.assertEqual(migrated["workflowVersion"], canvas["workflowVersion"])
        self.assertEqual(migrated["layoutVersion"], canvas["layoutVersion"])
        for node in migrated["nodes"]:
            if node["id"] not in before:
                continue
            original = before[node["id"]]
            self.assertEqual(node["modelId"], CHARACTER_IMAGE_MODEL if node.get("characterAssetIds") else DEFAULT_MODELS["image"])
            for field in ("prompt", "selected", "position", "jobIds", "characterAssetIds", "sourceVersion"):
                self.assertEqual(node[field], original[field])
            self.assertEqual(node["migrationHistory"][-1]["node"], original)
            self.assertEqual((node["parameters"]["width"], node["parameters"]["height"]), (1152, 2048))
            self.assertEqual(node["parameters"]["outputFormat"], "jpeg")
            self.assertNotIn("resolution", node["parameters"])
            self.assertNotIn("aspectRatio", node["parameters"])
            values = deepcopy(node["parameters"])
            if node.get("characterAssetIds"):
                values["imageUrls"] = ["https://cdn.example.com/ref.png"]
            self.assertNotIn("resolution", canvas_fixtures.normalize_parameters(canvas_fixtures.model_spec(node["modelId"]), values))
        self.assertEqual(self.manager._stored("p")["characterAssets"], assets)
        self.assertEqual(self.manager.get("p")["revision"], migrated["revision"])
        self.assertEqual(self.calls, [])

    def test_model_migration_keeps_success_active_unknown_and_user_selection(self):
        self.sources()
        base = self.manager._stored("p")
        character = next(n for n in base["nodes"] if n["nodeKind"] == "character")
        for status in ("succeeded", "running", "queued", "submitting", "unknown", "needs_attention", "cancelled"):
            with self.subTest(status=status):
                canvas = deepcopy(base)
                node = next(n for n in canvas["nodes"] if n["id"] == character["id"])
                node.update(modelId="rhart-image-n-pro-official/text-to-image-ultra", status=status, jobIds=["retained-job"])
                self.runtime.save("canvas", canvas)
                self.runtime.save("media", {"id": "retained-job", "projectId": "p", "canvasNodeId": node["id"], "status": status, "outputs": []})
                current = next(n for n in self.manager.get("p")["nodes"] if n["id"] == node["id"])
                self.assertEqual(current["modelId"], node["modelId"])
                self.assertEqual(current.get("migrationHistory"), node.get("migrationHistory"))
        # Isolate user-choice protection from the prior task-status protection.
        self.runtime.save("media", {"id": "retained-job", "projectId": "other", "status": "failed", "outputs": []})
        # A real user selection stays sticky even when a client posts default.
        canvas = deepcopy(base)
        node = next(n for n in canvas["nodes"] if n["id"] == character["id"])
        node.update(modelId="rhart-image-n-pro-official/text-to-image-ultra", modelSelectionOrigin="user")
        self.runtime.save("canvas", canvas)
        canvas["nodes"][0]["modelSelectionOrigin"] = "default"
        saved = self.manager.save("p", {"expectedRevision": canvas["revision"], "nodes": canvas["nodes"]})
        current = next(n for n in saved["nodes"] if n["id"] == node["id"])
        self.assertEqual(current["modelId"], node["modelId"])
        self.assertEqual(current["modelSelectionOrigin"], "user")
        self.assertEqual(self.calls, [])

    def test_failed_old_default_and_unsubmitted_character_preserve_portrait_shape(self):
        self.sources()
        canvas = self.manager._stored("p")
        characters = [n for n in canvas["nodes"] if n["nodeKind"] == "character"]
        for index, node in enumerate(characters):
            node.update(modelId="rhart-image-n-pro-official/text-to-image-ultra",
                        parameters={"prompt": node["prompt"], "resolution": "8k"}, parameterDraft={})
            if index == 0:
                node.update(jobIds=["failed-ultra"], status="failed")
                self.runtime.save("media", {"id": "failed-ultra", "projectId": "p", "canvasNodeId": node["id"], "status": "failed", "outputs": []})
        self.runtime.save("canvas", canvas)
        migrated = self.manager.get("p")
        for node in migrated["nodes"]:
            if node["nodeKind"] == "character":
                self.assertEqual(node["modelId"], DEFAULT_MODELS["image"])
                self.assertEqual((node["parameters"]["width"], node["parameters"]["height"]), (1536, 2048))
                self.assertNotIn("resolution", node["parameters"])
        self.assertEqual(self.runtime.get("media", "failed-ultra")["status"], "failed")
        self.assertEqual(self.calls, [])

    def test_model_migration_protects_batch_before_submission_and_missing_jobs(self):
        self.sources()
        canvas = self.manager._stored("p")
        nodes = [n for n in canvas["nodes"] if n["nodeKind"] == "character"]
        for node in nodes:
            node["modelId"] = "rhart-image-n-pro-official/text-to-image-ultra"
        nodes[0]["jobIds"] = ["missing-job"]
        self.runtime.save("canvas", canvas)
        # No media record exists yet; the persisted queue still owns this input.
        self.runtime.save("canvas_batch", {"id": "pre-submission", "projectId": "p", "status": "running",
            "items": [{"nodeId": nodes[1]["id"], "status": "pending"}], "createdAt": 1})
        board = self.manager._board("p")
        self.manager._sync(canvas, board)
        self.assertEqual(nodes[0]["modelId"], "rhart-image-n-pro-official/text-to-image-ultra")
        self.assertEqual(nodes[1]["modelId"], "rhart-image-n-pro-official/text-to-image-ultra")
        self.assertEqual(nodes[2]["modelId"], DEFAULT_MODELS["image"])
        self.assertEqual(self.calls, [])

    def test_model_selection_origin_is_not_a_generation_input(self):
        canvas = self.sources()
        node = canvas["nodes"][0]
        baseline = self.manager._execution_node(node)
        node["modelSelectionOrigin"] = "user"
        self.assertEqual(self.manager._execution_node(node), baseline)
        saved = self.manager.save("p", {"expectedRevision": canvas["revision"], "nodes": canvas["nodes"]})
        self.assertEqual(saved["nodes"][0]["modelSelectionOrigin"], "user")
        self.assertEqual(self.manager._execution_node(saved["nodes"][0]), baseline)

    def test_manual_refresh_passes_persisted_job_model_for_retirement_evidence(self):
        self.runtime.save("media", {"id": "asset-query", "projectId": "p", "provider": "runninghub",
            "task_id": "platform-asset-query", "mode": "model_api", "modelId": DEFAULT_MODELS["image"],
            "status": "queued", "mediaKind": "image", "outputs": []})
        handler = object.__new__(Handler)
        handler.server = type("Server", (), {"runtime": self.runtime, "workspace": self.workspace,
            "media": self.media, "canvas": self.manager})()
        responses = []
        handler.send = lambda status, body: responses.append((status, deepcopy(body)))
        path = "/api/media/jobs/asset-query/refresh"
        with patch.object(self.media, "poll", wraps=self.media.poll) as poll:
            handler.post(path, path.strip("/").split("/"), {})
            self.assertEqual(poll.call_args.kwargs["model_id"], DEFAULT_MODELS["image"])
        self.assertEqual(responses[-1][0], 200)
        self.assertEqual(len(self.calls), 1)
        self.assertTrue(self.calls[0][0].endswith("/query"))
        self.assertEqual(self.tasks, {})

    def test_same_prompt_regeneration_is_a_new_review_candidate_without_erasing_approved_reference(self):
        canvas = self.ready_all()
        asset = canvas["characterAssets"][0]
        node = next(n for n in canvas["nodes"] if n["id"] == asset["nodeId"])
        job = self.job(node, "same-prompt-new-result")
        pending = self.manager.get("p")["characterAssets"][0]
        self.assertEqual(pending["status"], "pending_review")
        self.assertEqual(pending["reviewCandidate"]["jobId"], job["id"])
        self.assertEqual(pending["referenceUrl"], asset["referenceUrl"])
        self.assertTrue(pending["referenceUsable"])
        self.assertEqual(pending["history"], asset["history"])
        adopted = self.confirm(asset, job)["characterAssets"][0]
        self.assertEqual(adopted["status"], "ready")
        self.assertEqual(adopted["referenceUrl"], job["outputs"][0]["url"])
        self.assertEqual(adopted["version"], 2)
        self.assertNotIn("reviewCandidate", self.manager.get("p")["characterAssets"][0])
        self.assertEqual(self.calls, [])

    def test_only_current_compatible_success_is_exposed_as_review_candidate(self):
        canvas = self.ready_all()
        asset = canvas["characterAssets"][0]
        node = next(n for n in canvas["nodes"] if n["id"] == asset["nodeId"])
        good = self.job(node, "current-compatible")
        for index, changes in enumerate(({"canvasNodeHash": "old-prompt"}, {"mediaKind": "video"},
                {"status": "running"}, {"outputs": [{"url": "https://cdn.example.com/a.webp"}]},
                {"outputs": [{"url": "https://cdn.example.com/a.png?expires=1"}]})):
            self.job(node, "ineligible-" + str(index), **changes)
        candidate = self.manager.get("p")["characterAssets"][0]
        self.assertEqual(candidate["status"], "pending_review")
        self.assertEqual(candidate["reviewCandidate"]["jobId"], good["id"])
        self.confirm(asset, good)
        self.assertEqual(self.manager.get("p")["characterAssets"][0]["status"], "ready")
        self.assertEqual(self.calls, [])

    def test_confirmation_does_not_acknowledge_a_still_running_result(self):
        canvas = self.sources()
        asset = canvas["characterAssets"][0]
        node = next(n for n in canvas["nodes"] if n["id"] == asset["nodeId"])
        good = self.job(node, "first-ready")
        later = self.job(node, "still-running", status="running", outputs=[])
        self.confirm(asset, good)
        later.update(status="succeeded", outputs=[{"url": "https://cdn.example.com/later.png", "outputType": "png"}])
        self.runtime.save("media", later)
        candidate = self.manager.get("p")["characterAssets"][0]
        self.assertEqual(candidate["status"], "pending_review")
        self.assertEqual(candidate["reviewCandidate"]["jobId"], later["id"])
        self.assertEqual(candidate["referenceJobId"], good["id"])

    def test_explicitly_keeping_prior_reference_acknowledges_new_candidates_without_version_churn(self):
        canvas = self.ready_all()
        asset = canvas["characterAssets"][0]
        node = next(n for n in canvas["nodes"] if n["id"] == asset["nodeId"])
        self.job(node, "alternative-result")
        original_job = self.runtime.get("media", asset["referenceJobId"])
        before = self.manager._stored("p")["revision"]
        kept = self.confirm(asset, original_job)
        self.assertEqual(kept["revision"], before + 1)
        self.assertEqual(kept["characterAssets"][0]["status"], "ready")
        self.assertEqual(kept["characterAssets"][0]["version"], asset["version"])
        self.assertEqual(self.confirm(asset, original_job)["revision"], kept["revision"])

    def test_selecting_one_output_does_not_make_other_outputs_from_same_job_pending_again(self):
        canvas = self.sources()
        asset = canvas["characterAssets"][0]
        node = next(n for n in canvas["nodes"] if n["id"] == asset["nodeId"])
        job = self.job(node, "multi-image", outputs=[{"url": "https://cdn.example.com/one.png"}, {"url": "https://cdn.example.com/two.png"}])
        result = self.manager.confirm_asset("p", asset["id"], {"expectedRevision": self.manager._stored("p")["revision"], "jobId": job["id"], "outputIndex": 1})
        self.assertEqual(result["characterAssets"][0]["status"], "ready")
        self.assertEqual(result["characterAssets"][0]["referenceOutputIndex"], 1)
        self.assertNotIn("reviewCandidate", result["characterAssets"][0])

    def test_confirmation_and_quote_remain_separate_and_generation_is_idempotent(self):
        canvas = self.sources()
        node = next(n for n in canvas["nodes"] if n.get("nodeKind") == "character")
        quote = self.manager.estimate("p", {"nodeIds": [node["id"]]})
        self.assertEqual(self.tasks, {})
        self.assertEqual(len(self.calls), 1)
        data = {"estimateToken": quote["estimateToken"], "requestId": "characters-batch", "confirmCost": True}
        batch = self.manager.generate("p", data)
        self.assertEqual(self.manager.generate("p", data)["id"], batch["id"])
        for _ in range(4):
            self.step()
        self.assertEqual(len(self.tasks), 1)
        job = self.runtime.all("media")[0]
        self.assertEqual(job["canvasNodeHash"], _hash(self.manager._execution_node(node)))
        asset = canvas["characterAssets"][0]
        self.assertEqual(self.manager.get("p")["characterAssets"][0]["status"], "pending_review")
        self.assertEqual(self.confirm(asset, job)["characterAssets"][0]["status"], "ready")
        self.assertEqual(len(self.tasks), 1)


class ImageOutputTests(unittest.TestCase):
    def test_invalid_or_expired_outputs_are_rejected_without_fetching(self):
        for url in ("http://cdn.example.com/a.png", "https://user:pass@cdn.example.com/a.png", "https://cdn.example.com/a.webp",
                    "https://cdn.example.com/a.png?expires=1", "https://cdn.example.com/a.png?X-Amz-Date=20000101T000000Z&X-Amz-Expires=60",
                    "https://[bad/a.png", "https://cdn.example.com/a.png\n"):
            with self.subTest(url=url), self.assertRaises(InputError):
                image_output({"status": "succeeded", "mediaKind": "image", "outputs": [{"url": url}]}, 0)
        self.assertEqual(image_output({"status": "succeeded", "mediaKind": "image", "outputs": [
            {"url": "https://cdn.example.com/image", "outputType": "image/jpeg"}]}, 0), "https://cdn.example.com/image")


if __name__ == "__main__":
    unittest.main()

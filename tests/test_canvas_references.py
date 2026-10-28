"""Uploaded references reach quoted inputs; mocks only, no paid provider calls."""
from copy import deepcopy
import threading
import unittest
from unittest.mock import patch

from server.canvas import _hash
from server.media_models import DEFAULT_CN_IMAGE_EDIT_MODEL, model_spec
from server.runtime import InputError
import test_canvas as canvas_fixtures
import test_project_assets as asset_fixtures


class ReferenceStore:
    def __init__(self):
        self.owners, self.cached, self.prepared, self.reads = {}, {}, [], []

    def add(self, node_id, reference_id="ref-1", project_id="p"):
        self.owners[reference_id] = (project_id, node_id)
        return {"id": reference_id, "name": "不可信客户端名称", "purpose": "style", "note": "参考柔和的窗边光线"}

    def validate(self, project_id, node_id, reference_id):
        if self.owners.get(reference_id) != (project_id, node_id):
            raise InputError("参考图不属于当前项目和节点。", 409)
        return {"id": reference_id, "name": "已上传图片.png", "previewUrl": "/api/local-preview"}

    def prepare(self, project_id, node_id, reference_ids):
        self.prepared.append((project_id, node_id, reference_ids))
        for reference_id in reference_ids:
            self.validate(project_id, node_id, reference_id)
            self.cached[reference_id] = "https://cdn.example.com/" + reference_id + ".png"

    def urls(self, project_id, node_id, reference_ids):
        self.reads.append((project_id, node_id, reference_ids))
        for reference_id in reference_ids:
            self.validate(project_id, node_id, reference_id)
            if reference_id not in self.cached:
                raise InputError("参考图上传链接已过期，请重新核对生成费用。", 409)
        return [self.cached[reference_id] for reference_id in reference_ids]


class CanvasReferenceTests(unittest.TestCase):
    transport = canvas_fixtures.CanvasTests.transport
    nodes = canvas_fixtures.CanvasTests.nodes
    save_nodes = canvas_fixtures.CanvasTests.save_nodes
    step = canvas_fixtures.CanvasTests.step
    add_confirmed_sources = canvas_fixtures.CanvasTests.add_confirmed_sources
    sources = asset_fixtures.ProjectAssetTests.sources
    job = asset_fixtures.ProjectAssetTests.job
    confirm = asset_fixtures.ProjectAssetTests.confirm
    ready_all = asset_fixtures.ProjectAssetTests.ready_all

    def setUp(self):
        canvas_fixtures.CanvasTests.setUp(self)
        self.store = ReferenceStore()
        self.manager.references = self.store

    def upload_node(self):
        node = self.nodes(1)[0]
        node.update(modelId=DEFAULT_CN_IMAGE_EDIT_MODEL,
                    referenceImages=[self.store.add(node["id"])])
        return self.save_nodes([node])["nodes"][0]

    def quote_node(self, node):
        return self.manager.estimate("p", {"nodeIds": [node["id"]]})

    def generate_quote(self, quote):
        return self.manager.generate("p", {"estimateToken": quote["estimateToken"],
                                            "requestId": "references-batch", "confirmCost": True})

    def test_quote_prepares_upload_and_includes_reference_purpose_once(self):
        node = self.upload_node()
        self.assertEqual(node["referenceImages"][0]["name"], "已上传图片.png")
        self.assertEqual(self.store.prepared, [])
        with self.assertRaisesRegex(InputError, "过期"):
            self.manager._request("p", node, None)
        quote = self.quote_node(node)
        self.assertEqual(len(self.store.prepared), 1)
        self.assertEqual(self.tasks, {})
        sent = self.calls[-1][1]
        self.assertEqual(sent["imageUrls"], ["https://cdn.example.com/ref-1.png"])
        self.assertIn("参考图 1：画面风格", sent["prompt"])
        self.assertIn("参考柔和的窗边光线", sent["prompt"])
        self.assertEqual(sent["prompt"].count("【参考图片使用说明】"), 1)
        self.generate_quote(quote)
        self.assertEqual(len(self.store.prepared), 1)
        self.step()
        self.assertEqual(len(self.tasks), 1)
        self.assertEqual(len(self.store.prepared), 1)
        self.assertEqual(next(iter(self.tasks.values()))["prompt"].count("【参考图片使用说明】"), 1)

    def test_expired_upload_requires_requote_without_upload_during_generate(self):
        quote = self.quote_node(self.upload_node())
        self.store.cached.clear()
        with self.assertRaisesRegex(InputError, "过期"):
            self.generate_quote(quote)
        self.assertEqual(len(self.store.prepared), 1)
        self.assertEqual(self.tasks, {})

    def test_worker_cannot_refresh_reference_after_confirmation(self):
        batch = self.generate_quote(self.quote_node(self.upload_node()))
        self.store.cached.clear()
        self.step()
        saved = self.runtime.get("canvas_batch", batch["id"])
        self.assertEqual(saved["items"][0]["status"], "needs_requote")
        self.assertEqual(self.tasks, {})
        self.assertEqual(len(self.store.prepared), 1)

    def test_reference_change_invalidates_quote_but_display_name_does_not_change_hash(self):
        node = self.upload_node()
        quote = self.quote_node(node)
        renamed = deepcopy(node)
        renamed["referenceImages"][0]["name"] = "另一个展示名"
        self.assertEqual(_hash(self.manager._execution_node(node)), _hash(self.manager._execution_node(renamed)))
        node["referenceImages"][0]["note"] = "参考强烈的逆光"
        self.save_nodes([node])
        with self.assertRaisesRegex(InputError, "已变化"):
            self.generate_quote(quote)
        self.assertEqual(self.tasks, {})
        old = self.nodes(1)[0]
        self.assertEqual(self.manager._execution_node(old), self.manager._execution_node({**old, "referenceImages": []}))

    def test_save_rejects_cross_project_or_node_reference_and_invalid_shapes(self):
        entry = self.store.add("node-0")
        for changes in ({"purpose": "invalid"}, {"purpose": []}, {"note": "长" * 1001}, {"id": "../secret"}):
            with self.subTest(changes=changes):
                node = self.nodes(1)[0]
                node["referenceImages"] = [{**entry, **changes}]
                with self.assertRaises(InputError):
                    self.save_nodes([node])
        for node_id, project_id in (("node-1", "p"), ("node-0", "other")):
            node = {**self.nodes(1)[0], "id": node_id, "referenceImages": [entry]}
            canvas = self.manager.get(project_id)
            with self.assertRaisesRegex(InputError, "不属于"):
                self.manager.save(project_id, {"expectedRevision": canvas["revision"], "nodes": [node]})
        for entries in ([entry, entry], [entry] * 11, "ref-1"):
            with self.assertRaises(InputError):
                self.save_nodes([{**self.nodes(1)[0], "referenceImages": entries}])
        video = self.nodes(2, video=True)[1]
        video["referenceImages"] = [self.store.add(video["id"], "ref-video")]
        with self.assertRaisesRegex(InputError, "视频请使用"):
            self.save_nodes([video])

    def test_incompatible_model_and_combined_limit_fail_before_upload(self):
        node = self.nodes(1)[0]
        node["referenceImages"] = [self.store.add(node["id"])]
        saved = self.save_nodes([node])["nodes"][0]
        with self.assertRaisesRegex(InputError, "不支持多图参考"):
            self.quote_node(saved)
        node["modelId"] = DEFAULT_CN_IMAGE_EDIT_MODEL
        node["referenceImages"].append(self.store.add(node["id"], "ref-2"))
        saved = self.save_nodes([node])["nodes"][0]
        characters = [f"https://cdn.example.com/character-{index}.png" for index in range(9)]
        with patch.object(self.manager, "_character_reference_inputs", return_value=(characters, [])):
            with self.assertRaisesRegex(InputError, "包含已确认人物"):
                self.quote_node(saved)
        self.assertEqual(self.store.prepared, [])
        self.assertEqual(self.calls, [])

    def test_per_model_maximum_is_enforced(self):
        node = self.upload_node()
        node["referenceImages"].append(self.store.add(node["id"], "ref-2"))
        node = self.save_nodes([node])["nodes"][0]
        spec = model_spec(node["modelId"])
        spec["schema"]["properties"]["imageUrls"]["maxItems"] = 1
        with patch("server.canvas.model_spec", return_value=spec):
            with self.assertRaisesRegex(InputError, "最多支持 1 张"):
                self.quote_node(node)
        self.assertEqual(self.store.prepared, [])

    def test_slow_upload_does_not_block_edit_and_changed_node_is_not_quoted(self):
        node = self.upload_node()
        entered, release, edited = threading.Event(), threading.Event(), threading.Event()
        errors = []
        original_prepare = self.store.prepare

        def delayed_prepare(*args):
            entered.set()
            if not release.wait(3):
                raise AssertionError("test upload was not released")
            original_prepare(*args)

        def quote_in_background():
            try:
                self.quote_node(node)
            except Exception as error:
                errors.append(error)

        def edit_in_background():
            try:
                changed = deepcopy(node)
                changed["referenceImages"][0]["note"] = "上传期间改为侧面构图"
                self.save_nodes([changed])
            finally:
                edited.set()

        quote_thread = threading.Thread(target=quote_in_background)
        edit_thread = threading.Thread(target=edit_in_background)
        with patch.object(self.store, "prepare", side_effect=delayed_prepare):
            quote_thread.start()
            try:
                self.assertTrue(entered.wait(1), "estimate must start the upload")
                edit_thread.start()
                self.assertTrue(edited.wait(1), "canvas editing must remain available during upload")
            finally:
                release.set()
                quote_thread.join(3)
                if edit_thread.ident is not None:
                    edit_thread.join(3)
        self.assertFalse(quote_thread.is_alive())
        self.assertEqual(len(errors), 1)
        self.assertIsInstance(errors[0], InputError)
        self.assertIn("上传期间节点内容已变化", str(errors[0]))
        self.assertEqual(self.calls, [])
        self.assertEqual(self.runtime.all("canvas_estimate"), [])

    def test_character_confirmation_change_during_upload_requires_new_quote(self):
        canvas = self.ready_all()
        node = next(n for n in canvas["nodes"] if n.get("shotId") == "S01-001" and n["mediaKind"] == "image")
        node["referenceImages"] = [self.store.add(node["id"])]
        self.save_nodes(canvas["nodes"])
        original_prepare = self.store.prepare

        def change_character_during_upload(*args):
            original_prepare(*args)
            current = self.manager._stored("p")
            current["characterAssets"][0]["version"] += 1
            self.runtime.save("canvas", current)

        with patch.object(self.store, "prepare", side_effect=change_character_during_upload):
            with self.assertRaisesRegex(InputError, "上传期间人物资产已变化"):
                self.quote_node(node)
        self.assertEqual(self.calls, [])
        self.assertEqual(self.runtime.all("canvas_estimate"), [])

    def test_character_references_precede_uploads_and_video_uses_completed_image(self):
        canvas = self.ready_all()
        image = next(n for n in canvas["nodes"] if n.get("shotId") == "S01-001" and n["mediaKind"] == "image")
        video = next(n for n in canvas["nodes"] if n.get("shotId") == "S01-001" and n["mediaKind"] == "video")
        image["referenceImages"] = [self.store.add(image["id"])]
        saved = self.save_nodes(canvas["nodes"])
        image = next(n for n in saved["nodes"] if n["id"] == image["id"])
        batch = self.generate_quote(self.quote_node(image))
        sent = self.calls[-1][1]
        self.assertEqual(sent["imageUrls"][:2], [a["referenceUrl"] for a in canvas["characterAssets"][:2]])
        self.assertEqual(sent["imageUrls"][2], "https://cdn.example.com/ref-1.png")
        self.assertIn("参考图 3：画面风格", sent["prompt"])
        for _ in range(4):
            self.step()
        job = next(job for job in self.runtime.all("media") if job.get("batchId") == batch["id"])
        self.assertEqual(job["status"], "succeeded")
        self.assertEqual(len(job["characterReferenceSnapshot"]), 2)
        self.store.cached.clear()
        # A finished first frame is independent of expired source upload links.
        request = self.manager._request("p", video, None)
        self.assertEqual(request["parameters"]["firstFrameUrl"], job["outputs"][0]["url"])
        image["referenceImages"][0]["purpose"] = "composition"
        self.save_nodes([image])
        with self.assertRaisesRegex(InputError, "先生成分镜图片"):
            self.manager._request("p", video, None)


if __name__ == "__main__":
    unittest.main()

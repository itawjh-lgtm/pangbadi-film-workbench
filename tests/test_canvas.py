"""Persistent canvas/batch behavior. Fake quotes/tasks only; no external media."""
from copy import deepcopy
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch, Mock

from server.canvas import CanvasManager, DEFAULT_MODELS, _hash
from server.media_models import model_spec, normalize_parameters
from server.httpd import Handler, StudioServer
from server.media import MediaRegistry
from server.runtime import Runtime, InputError
from server.workspace import Workspace
from test_runtime import Catalog, Provider
from test_project_media import BOARD, PROMPTS, HIERARCHICAL_BOARD, HIERARCHICAL_PROMPTS
from server.trash import TrashManager


class CanvasTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.runtime = Runtime(self.temp.name, Catalog(), Provider())
        self.addCleanup(self.runtime.db.close)
        self.addCleanup(self.runtime.close)
        self.workspace = Workspace(self.runtime)
        self.workspace.save({"expectedRevision": 0, "state": {"version": 3,
            "projects": [{"id": "p", "kind": "film"}, {"id": "other", "kind": "film"}],
            "tasks": [], "decisions": [], "artifacts": [], "messages": [], "activity": [], "favorites": []}})
        self.calls, self.tasks, self.polls = [], {}, {}
        self.unknown, self.reject, self.currency_split = False, False, False
        guard = patch("server.media._default_transport", side_effect=AssertionError("external network forbidden"))
        guard.start()
        self.addCleanup(guard.stop)
        self.media = MediaRegistry(Path(self.temp.name) / "connections.json", self.transport)
        self.media.configure("runninghub", {"modelApiKey": "fake-canvas-model-key"})
        self.manager = CanvasManager(self.runtime, self.workspace, self.media, start_worker=False, poll_interval=.01)
        self.addCleanup(self.manager.close)

    def transport(self, url, body, headers, timeout):
        self.calls.append((url, deepcopy(body)))
        if "/price-preview/" in url:
            currency = "USD" if self.currency_split and "text-to-video" in url else "CNY"
            return {"estimatedPrice": .5, "currency": currency, "isFreeThisCall": False}
        if url.endswith("/query"):
            task_id = body["taskId"]
            self.polls[task_id] = self.polls.get(task_id, 0) + 1
            return {"taskId": task_id, "status": "SUCCESS" if self.polls[task_id] >= 2 else "RUNNING",
                    "results": [{"url": "https://cdn.example.com/" + task_id + ".png", "outputType": "png"}] if self.polls[task_id] >= 2 else []}
        if self.unknown:
            raise TimeoutError("simulated ambiguous submission")
        if self.reject:
            return {"errorCode": "INVALID_INPUT", "errorMessage": "fixture input rejected"}
        task_id = "task-" + str(len(self.tasks) + 1)
        self.tasks[task_id] = deepcopy(body)
        return {"taskId": task_id, "status": "QUEUED", "results": []}

    def test_server_constructor_backfills_retirements_after_bind_before_canvas(self):
        events = []
        with patch("server.httpd.ThreadingHTTPServer.__init__", side_effect=lambda *args: events.append("bound")), \
                patch("server.httpd.ProductionManager"), \
                patch.object(self.media, "backfill_model_retirements", side_effect=lambda jobs: events.append("backfill")) as backfill, \
                patch("server.httpd.CanvasManager", side_effect=lambda *args: events.append("canvas")):
            StudioServer(("127.0.0.1", 0), self.runtime, self.media)
        self.assertEqual(events, ["bound", "backfill", "canvas"])
        backfill.assert_called_once_with(self.runtime.all("media"))
        self.assertEqual(self.calls, [])

    def test_server_bind_failure_cannot_backfill_or_recover(self):
        with patch("server.httpd.ThreadingHTTPServer.__init__", side_effect=OSError("occupied")), \
                patch.object(self.media, "backfill_model_retirements") as backfill, \
                patch("server.httpd.CanvasManager") as canvas:
            with self.assertRaises(OSError):
                StudioServer(("127.0.0.1", 0), self.runtime, self.media)
        backfill.assert_not_called()
        canvas.assert_not_called()
        self.assertEqual(self.calls, [])

    def test_main_backfills_saved_failures_before_canvas_without_network(self):
        from server.httpd import main
        events = []
        server = Mock()
        server.serve_forever.side_effect = KeyboardInterrupt
        with patch("sys.argv", ["studio", "--data-dir", self.temp.name]), \
                patch("server.httpd.StudioServer", return_value=server), \
                patch("server.httpd.Runtime", return_value=self.runtime), \
                patch("server.httpd.RoleCatalog"), patch("server.httpd.CodexProvider"), \
                patch("server.httpd.ProductionManager"), \
                patch("server.media.MediaRegistry", return_value=self.media), \
                patch.object(self.media, "backfill_model_retirements", side_effect=lambda jobs: events.append("backfill")) as backfill, \
                patch("server.httpd.CanvasManager", side_effect=lambda *args: events.append("canvas") or Mock()), \
                patch("server.httpd.signal.signal"), patch("builtins.print"):
            main()
        self.assertEqual(events, ["backfill", "canvas"])
        backfill.assert_called_once_with([])
        self.assertEqual(self.calls, [])

    def nodes(self, count=2, video=False):
        return [{"id": "node-" + str(i), "mediaKind": "video" if video and i else "image",
                 "title": "镜头" + str(i), "prompt": "原创白色纸船在清晨海面漂流", "modelId": DEFAULT_MODELS["video" if video and i else "image"],
                 "parameters": {"prompt": "原创白色纸船在清晨海面漂流"}, "position": {"x": i * 370, "y": 0}, "selected": True} for i in range(count)]

    def save_nodes(self, nodes=None):
        canvas = self.manager.get("p")
        return self.manager.save("p", {"expectedRevision": canvas["revision"], "nodes": nodes or self.nodes(),
                                       "viewport": {"x": 10, "y": 20, "scale": .8}})

    def quote(self, budget=2, ids=None):
        return self.manager.estimate("p", {"nodeIds": ids or ["node-0", "node-1"], "budget": budget})

    def generate(self, estimate=None, request_id="batch-request"):
        estimate = estimate or self.quote()
        return self.manager.generate("p", {"estimateToken": estimate["estimateToken"], "requestId": request_id, "confirmCost": True})

    def step(self):
        for batch in self.runtime.all("canvas_batch"):
            for item in batch["items"]:
                item["lastPollAt"] = 0
            self.runtime.save("canvas_batch", batch)
        self.manager.reconcile()

    def add_confirmed_sources(self, board=BOARD, prompts=PROMPTS):
        artifacts = []
        for kind, role, body, at in (("storyboard", "R04", board, 10), ("prompts", "R06", prompts, 20)):
            artifact = {"id": kind + "-source", "authorId": role, "body": body, "createdAt": at}
            self.runtime.save("run", {"id": "run-" + kind, "projectId": "p", "productionId": "production-p",
                                      "status": "succeeded", "artifacts": [artifact]})
            artifacts.append({"id": kind, "agentId": role, "status": "completed", "artifacts": [artifact], "outputArtifactIds": [artifact["id"]]})
        self.runtime.save("production", {"id": "production-p", "projectId": "p", "status": "completed", "createdAt": 30,
            "stages": [*artifacts, {"id": "delivery", "status": "completed", "outputArtifactIds": ["delivery-source"],
            "review": {"action": "approve", "reviewer": "user", "artifactIds": ["delivery-source"]}}]})

    def old_truncated_canvas(self):
        self.add_confirmed_sources(HIERARCHICAL_BOARD, HIERARCHICAL_PROMPTS)
        version = self.manager._board("p")["sourceRevision"]
        canvas = self.manager._stored("p")
        canvas.update(revision=12, sourceRevision=version, nodes=[{
            "id": "shot-" + _hash(["S01", version, kind])[:24], "mediaKind": kind,
            "title": "S01 · 001／走廊 · " + ("图片" if kind == "image" else "视频"),
            "shotId": "S01", "sourceArtifactId": "storyboard-source", "promptArtifactId": "prompts-source",
            "sourceVersion": version, "prompt": "", "modelId": "rhart-image-g-2-official/text-to-image" if kind == "image" else DEFAULT_MODELS[kind],
            "parameters": {"prompt": ""}, "parameterDraft": {}, "position": {"x": 0, "y": 0 if kind == "image" else 380},
            "selected": kind == "image", "jobIds": [], "status": "draft"} for kind in ("image", "video")])
        self.runtime.save("canvas", canvas)
        return canvas

    def test_parser_migration_creates_twelve_ready_pairs_and_archives_only_empty_defaults(self):
        old = self.old_truncated_canvas()
        canvas = self.manager.get("p")
        self.assertEqual(len(canvas["nodes"]), 24)
        self.assertEqual([entry["node"] for entry in canvas["importArchive"]], old["nodes"])
        self.assertEqual(sum(node["selected"] for node in canvas["nodes"]), 12)
        for node in canvas["nodes"]:
            # Image-to-video is deliberately incomplete until its same-shot image exists.
            values = deepcopy(node["parameters"])
            if node["mediaKind"] == "video":
                values["firstFrameUrl"] = "https://cdn.example.com/test-first-frame.png"
            params = normalize_parameters(model_spec(node["modelId"]), values)
            self.assertTrue(params["prompt"])
            self.assertEqual(node["targetDuration"], 2)
            if node["mediaKind"] == "image":
                self.assertEqual((params["width"], params["height"]), (1152, 2048))
                self.assertNotIn("resolution", params)
            else:
                self.assertEqual(params["duration"], "4")
                self.assertEqual(params["ratio"], "adaptive")
                image = next(n for n in canvas["nodes"] if n["shotId"] == node["shotId"] and n["mediaKind"] == "image")
                self.assertEqual(node["referenceNodeId"], image["id"])
                with self.assertRaisesRegex(InputError, "先生成分镜图片"):
                    self.manager._request("p", node, None)
        self.assertEqual(self.manager.get("p")["revision"], canvas["revision"])
        self.assertEqual(self.calls, [])

    def test_migration_keeps_edited_and_generated_legacy_nodes(self):
        canvas = self.old_truncated_canvas()
        canvas["nodes"][0].update(prompt="用户独有文稿", position={"x": 70, "y": 99})
        self.runtime.save("canvas", canvas)
        self.runtime.save("media", {"id": "old-job", "projectId": "p", "canvasNodeId": canvas["nodes"][1]["id"],
            "status": "failed", "outputs": []})
        result = self.manager.get("p")
        self.assertEqual(len(result["nodes"]), 26)
        self.assertEqual(len(result.get("importArchive", [])), 0)
        for before in canvas["nodes"]:
            kept = next(node for node in result["nodes"] if node["id"] == before["id"])
            self.assertTrue(kept["legacy"])
            self.assertEqual(kept["prompt"], before["prompt"])
            self.assertEqual(kept["positionSnapshot"], before["position"])

    def test_migration_does_not_revive_trashed_shots_and_restore_imports_once(self):
        canvas = self.old_truncated_canvas()
        trash = TrashManager(self.runtime, self.workspace)
        entry = trash.delete({"kind": "canvas_node", "targetId": canvas["nodes"][0]["id"], "projectId": "p"})[0]
        result = self.manager.get("p")
        self.assertEqual(len(result["nodes"]), 12)
        self.assertTrue(all(node["mediaKind"] == "video" for node in result["nodes"]))
        self.assertEqual(self.manager.get("p")["revision"], result["revision"])
        trash.restore(entry["id"])
        restored = self.manager.get("p")
        self.assertEqual(len(restored["nodes"]), 24)
        self.assertEqual(len(restored["importArchive"]), 2)
        self.assertEqual(self.manager.get("p")["revision"], restored["revision"])

    def test_omitted_budget_binds_exact_total_without_requote_or_implicit_generation(self):
        self.save_nodes()
        quote = self.manager.estimate("p", {"nodeIds": ["node-0", "node-1"]})
        self.assertEqual(quote["budget"], quote["totalCost"])
        self.assertEqual(quote["budgetMode"], "quoted_total")
        self.assertEqual(len(self.calls), 2)
        self.assertEqual(self.runtime.all("media"), [])
        self.assertEqual(self.tasks, {})
        with self.assertRaises(InputError):
            self.manager.generate("p", {"estimateToken": quote["estimateToken"], "requestId": "not-confirmed"})
        batch = self.generate(quote)
        for _ in range(5):
            self.step()
        self.assertEqual(self.manager.batch("p", batch["id"])["status"], "succeeded")
        self.assertEqual(sum("/price-preview/" in url for url, _ in self.calls), 2)
        self.assertEqual(len(self.tasks), 2)

    def test_confirmed_sources_sync_once_and_preserve_edits(self):
        self.add_confirmed_sources()
        canvas = self.manager.get("p")
        self.assertTrue(canvas["storyboard"]["confirmed"])
        self.assertEqual(len(canvas["nodes"]), 4)
        self.assertEqual(sum(node["selected"] for node in canvas["nodes"]), 2)
        canvas["nodes"][0]["prompt"] = "用户修改"
        saved = self.manager.save("p", {"expectedRevision": canvas["revision"], "nodes": canvas["nodes"], "viewport": canvas["viewport"]})
        self.assertEqual(self.manager.get("p")["nodes"][0]["prompt"], "用户修改")
        self.assertEqual(self.manager.get("p")["revision"], saved["revision"])
        self.assertEqual(self.calls, [])

    def test_unconfirmed_or_stale_review_never_auto_imports(self):
        self.add_confirmed_sources()
        plan = self.runtime.get("production", "production-p")
        plan["stages"][-1]["review"]["artifactIds"] = ["old-version"]
        self.runtime.save("production", plan)
        canvas = self.manager.get("p")
        self.assertFalse(canvas["storyboard"]["confirmed"])
        self.assertEqual(canvas["nodes"], [])

    def test_newer_unconfirmed_production_never_imports_old_completed_sources(self):
        self.add_confirmed_sources()
        self.runtime.save("production", {"id": "new-production", "projectId": "p", "createdAt": 31,
            "status": "running", "stages": []})
        canvas = self.manager.get("p")
        self.assertFalse(canvas["storyboard"]["confirmed"])
        self.assertEqual(canvas["nodes"], [])

    def test_explicit_source_ratio_initializes_each_kind_without_global_portrait_default(self):
        self.add_confirmed_sources()
        run = self.runtime.get("run", "run-prompts")
        run["artifacts"][0]["body"] = PROMPTS.replace("一艘白色纸船", "9:16竖屏，一艘白色纸船").replace("纸船缓慢前进", "9:16竖屏，纸船缓慢前进")
        self.runtime.save("run", run)
        canvas = self.manager.get("p")
        first = [node for node in canvas["nodes"] if node["shotId"] == "S01"]
        self.assertEqual((first[0]["parameters"]["width"], first[0]["parameters"]["height"]), (1152, 2048))
        self.assertEqual(first[1]["parameters"]["ratio"], "adaptive")
        second = [node for node in canvas["nodes"] if node["shotId"] == "S02"]
        self.assertEqual((second[0]["parameters"]["width"], second[0]["parameters"]["height"]), (2048, 2048))
        self.assertEqual(second[1]["parameters"]["ratio"], "adaptive")

    def test_rework_marks_old_nodes_stale_without_overwriting(self):
        self.add_confirmed_sources()
        self.manager.get("p")
        plan = self.runtime.get("production", "production-p")
        plan["status"] = "running"
        plan["stages"][-1]["review"] = None
        self.runtime.save("production", plan)
        canvas = self.manager.get("p")
        self.assertEqual(len(canvas["nodes"]), 4)
        self.assertTrue(all(node["stale"] for node in canvas["nodes"]))
        with self.assertRaises(InputError):
            self.quote(ids=[canvas["nodes"][0]["id"]])

    def _initialize_ratio_case(self, image_prefix, video_prefix):
        self.add_confirmed_sources()
        run = self.runtime.get("run", "run-prompts")
        run["artifacts"][0]["body"] = PROMPTS.replace("一艘白色纸船", image_prefix + "一艘白色纸船").replace("纸船缓慢前进", video_prefix + "纸船缓慢前进")
        self.runtime.save("run", run)
        return [node for node in self.manager.get("p")["nodes"] if node["shotId"] == "S01"]

    def test_video_inherits_same_shot_first_frame_geometry(self):
        image, video = self._initialize_ratio_case("9:16竖屏，", "")
        self.assertEqual((image["parameters"]["width"], image["parameters"]["height"]), (1152, 2048))
        self.assertEqual(video["parameters"]["ratio"], "adaptive")
        self.assertEqual(video["referenceNodeId"], image["id"])

    def test_video_timecodes_do_not_block_inherited_frame_ratio(self):
        prompts = HIERARCHICAL_PROMPTS.replace("固定机位，手部动作1。", "00:00—00:02，固定机位，手部动作1。")
        self.add_confirmed_sources(HIERARCHICAL_BOARD, prompts)
        first = [node for node in self.manager.get("p")["nodes"] if node["shotId"] == "S01-001"]
        self.assertEqual((first[0]["parameters"]["width"], first[0]["parameters"]["height"]), (1152, 2048))
        self.assertEqual(first[1]["parameters"]["ratio"], "adaptive")
        self.assertEqual(self.calls, [])

    def test_video_ratio_uses_same_shot_first_frame_even_with_text_ratio(self):
        image, video = self._initialize_ratio_case("9:16竖屏，", "4:3画幅，")
        self.assertEqual((image["parameters"]["width"], image["parameters"]["height"]), (1152, 2048))
        self.assertEqual(video["parameters"]["ratio"], "adaptive")
        self.assertEqual(video["referenceNodeId"], image["id"])

    def test_conflicting_video_ratios_are_not_replaced_by_image_ratio(self):
        image, video = self._initialize_ratio_case("9:16竖屏，", "16:9或4:3待确认，")
        self.assertEqual((image["parameters"]["width"], image["parameters"]["height"]), (1152, 2048))
        self.assertEqual(video["parameters"]["ratio"], "adaptive")

    def test_conflicting_image_ratios_are_not_inherited(self):
        image, video = self._initialize_ratio_case("9:16或16:9待确认，", "")
        self.assertEqual((image["parameters"]["width"], image["parameters"]["height"]), (2048, 2048))
        self.assertEqual(video["parameters"]["ratio"], "adaptive")

    def test_legacy_media_attaches_only_exact_project_kind_and_source_versions(self):
        self.add_confirmed_sources()
        base = {"projectId": "p", "shotId": "S01", "sourceArtifactId": "storyboard-source",
                "promptArtifactId": "prompts-source", "mediaKind": "video", "status": "succeeded",
                "createdAt": 10, "outputs": [{"url": "https://cdn.example.com/old.mp4", "outputType": "mp4"}]}
        for key, change in (("valid", {}), ("wrong-project", {"projectId": "other"}),
                            ("old-board", {"sourceArtifactId": "old-source"}),
                            ("old-prompt", {"promptArtifactId": "old-prompts"}),
                            ("other-node", {"canvasNodeId": "different-node"})):
            self.runtime.save("media", {**base, **change, "id": key})
        canvas = self.manager.get("p")
        video = next(node for node in canvas["nodes"] if node["shotId"] == "S01" and node["mediaKind"] == "video")
        image = next(node for node in canvas["nodes"] if node["shotId"] == "S01" and node["mediaKind"] == "image")
        self.assertEqual(video["jobIds"], ["valid"])
        self.assertEqual(video["outputs"][0]["url"], "https://cdn.example.com/old.mp4")
        self.assertEqual(image["jobIds"], [])
        again = self.manager.get("p")
        self.assertEqual(again["revision"], canvas["revision"])
        self.assertEqual(next(node for node in again["nodes"] if node["id"] == video["id"])["jobIds"], ["valid"])

    def test_adopted_legacy_image_can_supply_video_reference(self):
        self.add_confirmed_sources()
        self.runtime.save("media", {"id": "legacy-image", "projectId": "p", "shotId": "S01",
            "sourceArtifactId": "storyboard-source", "promptArtifactId": "prompts-source", "mediaKind": "image",
            "status": "succeeded", "outputs": [{"url": "https://cdn.example.com/first.png", "outputType": "png"}]})
        canvas = self.manager.get("p")
        image = next(node for node in canvas["nodes"] if node["shotId"] == "S01" and node["mediaKind"] == "image")
        video = next(node for node in canvas["nodes"] if node["shotId"] == "S01" and node["mediaKind"] == "video")
        video.update(referenceNodeId=image["id"], modelId="bytedance/seedance-2.5-token/image-to-video")
        video["parameters"] = {**model_spec(video["modelId"])["defaults"], "prompt": video["prompt"]}
        self.save_nodes(canvas["nodes"])
        quote = self.quote(ids=[video["id"]])
        self.assertEqual(self.calls[-1][1]["firstFrameUrl"], "https://cdn.example.com/first.png")
        changed = self.runtime.get("media", "legacy-image")
        changed["outputs"][0]["url"] = "https://cdn.example.com/new-version.png"
        self.runtime.save("media", changed)
        with self.assertRaises(InputError):
            self.generate(quote)
        self.assertEqual(self.tasks, {})

    def test_drafts_revision_and_cross_project_protection(self):
        nodes = self.nodes()
        nodes[0]["parameters"] = {"resolution": "incomplete"}
        nodes[0]["parameterDraft"] = {"seed": "unfinished"}
        saved = self.save_nodes(nodes)
        self.assertEqual(saved["nodes"][0]["parameterDraft"]["seed"], "unfinished")
        with self.assertRaises(InputError):
            self.manager.save("p", {"expectedRevision": 0, "nodes": nodes})
        nodes[0]["projectId"] = "other"
        with self.assertRaises(InputError):
            self.save_nodes(nodes)
        self.assertEqual(self.manager.get("other")["nodes"], [])

    def test_quote_has_no_generation_and_one_confirmation_executes_batch(self):
        self.save_nodes()
        quote = self.quote()
        self.assertEqual(quote["totalCost"], 1)
        self.assertEqual(len(self.calls), 2)
        self.assertEqual(self.runtime.all("media"), [])
        self.assertNotIn("request", quote["items"][0])
        batch = self.generate(quote)
        self.assertEqual(self.tasks, {})
        self.assertEqual(self.manager.active_count(), 1)
        for _ in range(5):
            self.step()
        done = self.manager.batch("p", batch["id"])
        self.assertEqual(done["status"], "succeeded")
        self.assertEqual(len(self.tasks), 2)
        self.assertEqual(sum("/price-preview/" in url for url, _ in self.calls), 2)
        canvas = self.manager.get("p")
        self.assertTrue(all(node["outputs"] for node in canvas["nodes"]))
        for job in self.runtime.all("media"):
            self.assertEqual(job["batchId"], batch["id"])
            self.assertEqual(job["projectId"], "p")
            self.assertIn(job["canvasNodeId"], quote["nodeIds"])
            self.assertEqual(job["name"], "镜头" + job["canvasNodeId"].split("-")[-1])

    def test_confirmation_idempotency_and_project_scope(self):
        self.save_nodes()
        quote = self.quote()
        batch = self.generate(quote)
        self.assertEqual(self.generate(quote)["id"], batch["id"])
        with self.assertRaises(InputError):
            self.generate(quote, "different-request")
        with self.assertRaises(InputError):
            self.manager.generate("other", {"estimateToken": quote["estimateToken"], "requestId": "cross-project", "confirmCost": True})
        with self.assertRaises(InputError):
            self.manager.batch("other", batch["id"])
        self.assertEqual(self.tasks, {})

    def test_aggregate_budget_and_mixed_currency_fail_closed(self):
        self.save_nodes()
        quote = self.quote(.75)
        self.assertFalse(quote["withinBudget"])
        with self.assertRaises(InputError):
            self.generate(quote)
        self.save_nodes(self.nodes(video=True))
        self.currency_split = True
        with self.assertRaises(InputError):
            self.quote()
        self.assertEqual(self.tasks, {})

    def test_changed_prompt_invalidates_quote_but_position_does_not(self):
        self.save_nodes()
        quote = self.quote()
        canvas = self.manager.get("p")
        canvas["nodes"][0]["position"]["x"] += 100
        self.save_nodes(canvas["nodes"])
        self.generate(quote)
        self.manager.stop("p", self.runtime.all("canvas_batch")[0]["id"])
        quote = self.quote()
        canvas["nodes"][0]["parameters"]["prompt"] = "changed"
        self.save_nodes(canvas["nodes"])
        with self.assertRaises(InputError):
            self.generate(quote, "changed-request")

    def test_expiry_stops_pending_without_silent_requote(self):
        self.save_nodes()
        batch = self.generate()
        count = len(self.calls)
        with patch("server.canvas._expired", return_value=True):
            self.step()
        self.assertEqual(self.manager.batch("p", batch["id"])["status"], "needs_requote")
        self.assertEqual(len(self.calls), count)

    def test_stop_prevents_unsubmitted_and_keeps_polling_submitted_task(self):
        self.save_nodes()
        batch = self.generate()
        self.step()
        self.manager.stop("p", batch["id"])
        for _ in range(3):
            self.step()
        result = self.manager.batch("p", batch["id"])
        self.assertEqual(result["items"][0]["status"], "succeeded")
        self.assertEqual(result["items"][1]["status"], "cancelled")
        self.assertEqual(len(self.tasks), 1)

    def test_ambiguous_submission_is_never_retried(self):
        self.save_nodes()
        batch = self.generate()
        self.unknown = True
        self.step()
        calls = len(self.calls)
        for _ in range(3):
            self.step()
        result = self.manager.batch("p", batch["id"])
        self.assertEqual(result["items"][0]["status"], "unknown")
        self.assertEqual(result["items"][1]["status"], "needs_requote")
        self.assertEqual(len(self.calls), calls)

    def test_restart_requotes_pending_and_polls_known_tasks_only(self):
        self.save_nodes()
        batch = self.generate()
        self.step()
        self.manager.close()
        self.manager = CanvasManager(self.runtime, self.workspace, self.media, start_worker=False)
        self.addCleanup(self.manager.close)
        result = self.manager.batch("p", batch["id"])
        self.assertEqual(result["items"][1]["status"], "needs_requote")
        for _ in range(3):
            self.step()
        self.assertEqual(len(self.tasks), 1)
        self.assertEqual(self.manager.batch("p", batch["id"])["items"][0]["status"], "succeeded")

    def test_crash_between_job_and_batch_save_is_reconciled_without_resubmit(self):
        self.save_nodes()
        batch = self.generate()
        persisted = self.runtime.get("canvas_batch", batch["id"])
        request = persisted["items"][0]["request"]
        self.runtime.save("media", {"id": "orphan", "requestId": request["requestId"], "projectId": "p",
            "batchId": batch["id"], "canvasNodeId": "node-0", "status": "unknown", "outputs": []})
        self.manager.close()
        self.manager = CanvasManager(self.runtime, self.workspace, self.media, start_worker=False)
        self.addCleanup(self.manager.close)
        self.assertEqual(self.manager.batch("p", batch["id"])["items"][0]["status"], "unknown")
        self.assertIn("orphan", self.manager.get("p")["nodes"][0]["jobIds"])
        self.step()
        self.assertEqual(self.tasks, {})

    def test_http_routes_and_service_status_report_queued_batches(self):
        self.save_nodes()
        self.generate()
        handler = object.__new__(Handler)
        handler.server = type("Server", (), {"runtime": self.runtime, "workspace": self.workspace,
            "media": self.media, "canvas": self.manager})()
        handler.guard = lambda write=False: None
        responses = []
        handler.send = lambda status, body: responses.append((status, deepcopy(body)))
        handler.path = "/api/projects/p/canvas"
        handler.handle_request(False)
        self.assertEqual(responses[-1][1]["projectId"], "p")
        handler.path = "/api/service-status"
        handler.handle_request(False)
        self.assertEqual(responses[-1][1]["activeCanvasBatchCount"], 1)
        self.assertEqual(responses[-1][1]["pendingMediaCount"], 2)


if __name__ == "__main__":
    unittest.main()

"""Deletion only changes an overlay; fixtures never touch user data or networks."""
from copy import deepcopy
import json
from types import SimpleNamespace
import unittest

import test_canvas
from test_production import ProductionCatalog
from server.httpd import Handler
from server.production import ProductionManager
from server.runtime import InputError
from server.storyboard import project_storyboard, media_project_metadata
from server.trash import TrashManager, is_deleted
from server.workspace import Workspace


class TrashTests(unittest.TestCase):
    setUp = test_canvas.CanvasTests.setUp
    transport = test_canvas.CanvasTests.transport
    nodes = test_canvas.CanvasTests.nodes
    save_nodes = test_canvas.CanvasTests.save_nodes
    quote = test_canvas.CanvasTests.quote
    generate = test_canvas.CanvasTests.generate
    add_confirmed_sources = test_canvas.CanvasTests.add_confirmed_sources

    @property
    def trash(self):
        return TrashManager(self.runtime, self.workspace)

    def delete(self, kind, target, project="p"):
        return self.trash.delete({"kind": kind, "targetId": target, "projectId": project})

    def update_state(self, **values):
        current = self.workspace.read()
        current["state"].update(values)
        return self.workspace.save({"expectedRevision": current["revision"], "state": current["state"]})

    def run_record(self, run_id="run-one", status="succeeded", artifact_id="draft-one", project="p", **extra):
        artifact = {"id": artifact_id, "runId": run_id, "authorId": "R04", "body": "private-old-draft", "createdAt": 10}
        run = {"id": run_id, "projectId": project, "status": status, "artifacts": [artifact],
               "messages": [{"id": "reply-one", "authorId": "R04", "content": "private-old-draft"}],
               "steps": [], "events": [], **extra}
        self.runtime.save("run", run)
        return run

    def test_tombstone_persistent_idempotent_and_restore_keeps_original(self):
        run = self.run_record()
        deleted = self.delete("run", run["id"])
        self.assertEqual(len(deleted), 1)
        self.assertEqual(self.delete("run", run["id"]), deleted)
        self.assertEqual(TrashManager(self.runtime, Workspace(self.runtime)).list(), deleted)
        self.assertEqual(self.runtime.get("run", run["id"]), run)
        self.assertEqual(self.runtime.artifact("draft-one")["body"], "private-old-draft")
        self.assertEqual(self.trash.restore(deleted[0]["id"]), [])
        self.assertEqual(self.trash.restore(deleted[0]["id"]), [])
        self.assertFalse(is_deleted(self.runtime, "artifact", "draft-one", "p"))
        self.assertEqual(self.runtime.provider.calls, [])
        self.assertEqual(self.calls, [])

    def test_batch_validation_is_atomic(self):
        with self.assertRaises(InputError):
            self.trash.delete({"items": [{"kind": "project", "targetId": "p"},
                                        {"kind": "media", "targetId": "missing"}]})
        self.assertEqual(self.trash.list(), [])
        self.assertEqual(len(self.workspace.read()["state"]["projects"]), 2)

    def test_cross_project_ownership_rejected(self):
        self.run_record()
        self.save_nodes()
        for kind, target in (("project", "p"), ("run", "run-one"), ("artifact", "draft-one"), ("canvas_node", "node-0")):
            with self.subTest(kind=kind), self.assertRaises(InputError):
                self.delete(kind, target, "other")
        self.assertEqual(self.trash.list(), [])

    def test_project_restoration_does_not_restore_individual_child(self):
        self.run_record()
        artifact_entry = self.delete("artifact", "draft-one")[0]
        self.delete("project", "p")
        project_entry = next(item for item in self.trash.list() if item["kind"] == "project")
        self.assertTrue(is_deleted(self.runtime, "run", "run-one", "p"))
        self.trash.restore(project_entry["id"])
        self.assertFalse(is_deleted(self.runtime, "run", "run-one", "p"))
        self.assertTrue(is_deleted(self.runtime, "artifact", "draft-one", "p"))
        self.assertEqual(self.trash.list(), [artifact_entry])

    def test_workspace_old_and_visible_only_snapshots_cannot_restore_or_erase(self):
        self.update_state(tasks=[{"id": "task-one", "projectId": "p", "title": "原任务", "dependencies": []}])
        current = self.workspace.read()
        self.delete("project", "p")
        incoming = deepcopy(current["state"])
        incoming["projects"] = [p for p in incoming["projects"] if p["id"] != "p"]
        incoming["tasks"] = []
        saved = self.workspace.save({"expectedRevision": current["revision"], "state": incoming})
        self.assertEqual(saved["state"], current["state"])
        self.assertTrue(is_deleted(self.runtime, "project", "p", "p"))
        incoming = deepcopy(current["state"])
        incoming["tasks"][0]["title"] = "stale edit"
        saved = self.workspace.save({"expectedRevision": saved["revision"], "state": incoming})
        self.assertEqual(saved["state"]["tasks"][0]["title"], "原任务")

    def test_active_run_blocks_project_run_and_artifact(self):
        self.run_record(status="running")
        for kind, target in (("project", "p"), ("run", "run-one"), ("artifact", "draft-one")):
            with self.subTest(kind=kind), self.assertRaisesRegex(InputError, "正在执行"):
                self.delete(kind, target)
        self.assertEqual(self.trash.list(), [])

    def test_retry_of_completed_deletion_is_idempotent_even_when_project_starts_work(self):
        self.run_record()
        deleted = self.delete("run", "run-one")
        self.run_record("new-run", status="running", artifact_id="in-progress")
        self.assertEqual(self.delete("run", "run-one"), deleted)

    def test_unknown_media_and_pending_batch_block_deletion(self):
        self.save_nodes()
        self.runtime.save("media", {"id": "unknown", "projectId": "p", "status": "unknown", "canvasNodeId": "node-0"})
        for kind, target in (("project", "p"), ("media", "unknown"), ("canvas_node", "node-0")):
            with self.subTest(kind=kind), self.assertRaises(InputError):
                self.delete(kind, target)
        self.runtime.save("canvas_batch", {"id": "pending-batch", "projectId": "p", "items": [{"nodeId": "node-1", "status": "pending"}]})
        with self.assertRaisesRegex(InputError, "画布批次"):
            self.delete("canvas_node", "node-1")
        self.assertEqual(self.trash.list(), [])

    def test_legacy_job_without_canvas_id_blocks_node(self):
        self.save_nodes()
        canvas = self.runtime.get("canvas", "p")
        canvas["nodes"][0]["jobIds"] = ["legacy-job"]
        self.runtime.save("canvas", canvas)
        self.runtime.save("media", {"id": "legacy-job", "projectId": "p", "status": "running"})
        with self.assertRaisesRegex(InputError, "生成任务"):
            self.delete("canvas_node", "node-0")

    def test_task_dependency_blocks_single_delete_but_allows_atomic_chain(self):
        self.update_state(tasks=[{"id": "upstream", "projectId": "p", "dependencies": []},
                                 {"id": "downstream", "projectId": "p", "dependencies": ["upstream"]}])
        with self.assertRaisesRegex(InputError, "依赖"):
            self.delete("task", "upstream")
        items = self.trash.delete({"items": [{"kind": "task", "targetId": key, "projectId": "p"}
                                             for key in ("upstream", "downstream")]})
        self.assertEqual(len(items), 2)

    def test_deleted_project_rejects_old_run_media_canvas_requests(self):
        self.save_nodes()
        quote = self.quote()
        self.delete("project", "p")
        actions = [lambda: self.runtime.start({"requestId": "new", "mode": "chat", "project": {"id": "p", "members": ["R03"]}, "agentIds": ["R03"], "prompt": "旧窗口"}),
                   lambda: media_project_metadata(self.runtime, self.workspace, {"projectId": "p"}),
                   lambda: self.quote(), lambda: self.generate(quote), lambda: self.manager.get("p")]
        for action in actions:
            with self.assertRaisesRegex(InputError, "回收站"):
                action()
        self.assertEqual(self.runtime.provider.calls, [])
        self.assertEqual(self.tasks, {})

    def test_context_filters_deleted_artifact_and_its_duplicate_history(self):
        self.run_record()
        self.delete("artifact", "draft-one")
        data = {"project": {"id": "p"}, "inputArtifacts": [{"id": "draft-one", "body": "stale-client-copy"}]}
        context = json.loads(self.runtime._context(data, "project:p", "new-run"))
        self.assertEqual(context["verifiedRuntimeOutputs"], [])
        self.assertEqual(context["inputArtifacts"], [])
        self.assertNotIn("private-old-draft", json.dumps(context))

    def test_context_filters_run_notes_tasks_and_decisions(self):
        self.run_record()
        self.update_state(tasks=[{"id": "task-one", "projectId": "p"}],
                          decisions=[{"id": "decision-one", "projectId": "p"}],
                          messages=[{"id": "note-one", "projectId": "p", "authorId": "user", "text": "secret-note"}])
        for kind, target in (("run", "run-one"), ("task", "task-one"), ("decision", "decision-one"), ("note", "note-one")):
            self.delete(kind, target)
        data = {"project": {"id": "p"}, "history": [{"id": "note-one", "authorId": "user", "text": "secret-note"}],
                "tasks": [{"id": "task-one"}], "decisions": [{"id": "decision-one"}],
                "inputArtifacts": [{"id": "draft-one", "body": "stale-copy"}]}
        context = json.loads(self.runtime._context(data, "project:p", "new-run"))
        for key in ("userConversation", "tasks", "decisions", "inputArtifacts", "verifiedRuntimeOutputs"):
            self.assertEqual(context[key], [])

    def test_anonymous_old_history_cannot_revive_deleted_run_prompt(self):
        self.run_record(prompt="deleted-private-prompt")
        self.delete("run", "run-one")
        data = {"project": {"id": "p"}, "history": [{"authorId": "user", "content": "deleted-private-prompt"}]}
        self.assertNotIn("deleted-private-prompt", self.runtime._context(data, "project:p", "new"))

    def test_local_notes_enter_model_context_only_when_explicitly_referenced(self):
        self.update_state(messages=[{"id": "private-note", "projectId": "p", "authorId": "user", "text": "仅本地保存"}])
        data = {"project": {"id": "p"}, "history": []}
        self.assertNotIn("仅本地保存", self.runtime._context(data, "project:p", "new"))
        data["history"] = [{"id": "private-note", "authorId": "user", "text": "不信旧副本"}]
        context = self.runtime._context(data, "project:p", "new")
        self.assertIn("仅本地保存", context)
        self.assertNotIn("不信旧副本", context)

    def test_production_inheritance_includes_historical_runs_and_context(self):
        current = self.run_record("current-run", artifact_id="current-draft", productionId="plan")
        historical = self.run_record("historical-run", artifact_id="historical-draft", prompt="historical-prompt")
        independent = self.run_record("independent-run", artifact_id="independent-draft")
        self.runtime.save("production", {"id": "plan", "projectId": "p", "status": "completed", "stages": [
            {"id": "storyboard", "runId": current["id"], "artifacts": current["artifacts"],
             "history": [{"runId": historical["id"], "artifacts": historical["artifacts"]}]}]})
        self.delete("artifact", "current-draft")
        deleted = self.delete("production", "plan")
        for kind, target in (("run", "current-run"), ("run", "historical-run"), ("artifact", "historical-draft")):
            self.assertTrue(is_deleted(self.runtime, kind, target, "p"))
        self.assertFalse(is_deleted(self.runtime, "run", independent["id"], "p"))
        context = json.loads(self.runtime._context({"project": {"id": "p"}}, "project:p", "new"))
        self.assertNotIn("historical-prompt", json.dumps(context))
        parent = next(item for item in deleted if item["kind"] == "production")
        self.trash.restore(parent["id"])
        self.assertFalse(is_deleted(self.runtime, "artifact", "historical-draft", "p"))
        self.assertTrue(is_deleted(self.runtime, "artifact", "current-draft", "p"))

    def test_deleted_latest_storyboard_does_not_revert_to_old_draft(self):
        from test_project_media import BOARD
        old = self.run_record("old-run", artifact_id="old-board")
        old["artifacts"][0].update(body=BOARD, createdAt=10)
        self.runtime.save("run", old)
        new = self.run_record("new-run", artifact_id="new-board")
        new["artifacts"][0].update(body=BOARD.replace("S01", "S09"), createdAt=20)
        self.runtime.save("run", new)
        self.assertEqual(project_storyboard(self.runtime, self.workspace, "p")["shots"][0]["id"], "S09")
        self.delete("artifact", "new-board")
        board = project_storyboard(self.runtime, self.workspace, "p")
        self.assertEqual(board["shots"], [])
        self.assertEqual(board["sources"], [])

    def test_canvas_hidden_nodes_survive_save_and_stale_edits_then_restore(self):
        initial = self.save_nodes()
        deleted = self.delete("canvas_node", "node-0")[0]
        current = self.manager.get("p")
        self.assertEqual([item["id"] for item in current["nodes"]], ["node-1"])
        current["nodes"][0]["prompt"] = "新的保留节点"
        saved = self.manager.save("p", {"expectedRevision": current["revision"], "nodes": current["nodes"]})
        stale = deepcopy(initial["nodes"])
        stale[0]["prompt"] = "不应覆盖回收站"
        self.manager.save("p", {"expectedRevision": saved["revision"], "nodes": stale})
        self.assertEqual(len(self.runtime.get("canvas", "p")["nodes"]), 2)
        self.trash.restore(deleted["id"])
        restored = self.manager.get("p")
        node = next(item for item in restored["nodes"] if item["id"] == "node-0")
        self.assertEqual(node["prompt"], initial["nodes"][0]["prompt"])
        self.assertEqual(node["position"], initial["nodes"][0]["position"])

    def test_canvas_hidden_reference_is_saved_but_cannot_generate(self):
        nodes = self.nodes(video=True)
        nodes[1]["referenceNodeId"] = "node-0"
        self.save_nodes(nodes)
        deleted = self.delete("canvas_node", "node-0")[0]
        visible = self.manager.get("p")
        self.assertTrue(visible["nodes"][0]["referenceMissing"])
        self.manager.save("p", {"expectedRevision": visible["revision"], "nodes": visible["nodes"]})
        with self.assertRaisesRegex(InputError, "回收站"):
            self.quote(ids=["node-1"])
        self.trash.restore(deleted["id"])
        self.assertFalse(next(node for node in self.manager.get("p")["nodes"] if node["id"] == "node-1")["referenceMissing"])

    def test_restore_then_stale_canvas_save_cannot_erase_recovered_node(self):
        self.save_nodes()
        deleted = self.delete("canvas_node", "node-0")[0]
        stale = self.manager.get("p")
        self.trash.restore(deleted["id"])
        with self.assertRaisesRegex(InputError, "其他窗口"):
            self.manager.save("p", {"expectedRevision": stale["revision"], "nodes": stale["nodes"]})
        current = self.manager.get("p")
        self.manager.save("p", {"expectedRevision": current["revision"], "nodes": stale["nodes"]})
        self.assertEqual({node["id"] for node in self.runtime.get("canvas", "p")["nodes"]}, {"node-0", "node-1"})

    def test_restore_then_old_visible_workspace_snapshot_keeps_recovered_project(self):
        deleted = self.delete("project", "p")[0]
        stale = self.workspace.read()
        stale["state"]["projects"] = [project for project in stale["state"]["projects"] if project["id"] != "p"]
        self.trash.restore(deleted["id"])
        saved = self.workspace.save({"expectedRevision": stale["revision"], "state": stale["state"]})
        self.assertEqual({project["id"] for project in saved["state"]["projects"]}, {"p", "other"})

    def test_canvas_sync_does_not_recreate_deleted_node(self):
        self.add_confirmed_sources()
        initial = self.manager.get("p")
        node_id = initial["nodes"][0]["id"]
        self.delete("canvas_node", node_id)
        stored = self.runtime.get("canvas", "p")
        stored["sourceRevision"] = ""  # retry a formerly partial source import
        self.runtime.save("canvas", stored)
        self.assertNotIn(node_id, [node["id"] for node in self.manager.get("p")["nodes"]])
        self.assertEqual(len(self.runtime.get("canvas", "p")["nodes"]), 4)

    def test_delete_after_quote_prevents_paid_submission(self):
        self.save_nodes()
        estimate = self.quote()
        self.delete("canvas_node", "node-0")
        with self.assertRaisesRegex(InputError, "回收站"):
            self.generate(estimate)
        self.assertEqual(self.tasks, {})
        self.assertEqual(self.runtime.all("canvas_batch"), [])

    def test_deleted_source_draft_can_save_but_generation_is_blocked(self):
        self.add_confirmed_sources()
        initial = self.manager.get("p")
        self.delete("artifact", "storyboard-source")
        current = self.manager.get("p")
        self.assertTrue(current["nodes"][0]["sourceMissing"])
        self.assertFalse(current["storyboard"]["confirmed"])
        self.manager.save("p", {"expectedRevision": current["revision"], "nodes": current["nodes"]})
        with self.assertRaises(InputError):
            self.quote(ids=[initial["nodes"][0]["id"]])

    def test_production_deleted_project_start_resume_review_guard(self):
        self.runtime.catalog = ProductionCatalog()
        production = ProductionManager(self.runtime, start_worker=False)
        self.addCleanup(production.close)
        plan = production.start({"requestId": "plan-1", "project": {"id": "p", "kind": "film"}, "prompt": "test"})
        paused = production.pause(plan["id"], {"expectedRevision": plan["revision"]})
        self.delete("project", "p")
        for action in (lambda: production.resume(plan["id"], {"expectedRevision": paused["revision"]}),
                       lambda: production.review(plan["id"], {"expectedRevision": paused["revision"], "stageId": "plan", "action": "approve"}),
                       lambda: production.start({"requestId": "plan-2", "project": {"id": "p", "kind": "film"}, "prompt": "new"})):
            with self.assertRaisesRegex(InputError, "回收站"):
                action()
        self.assertEqual(self.runtime.provider.calls, [])

    def test_deleted_project_frees_live_quota_without_losing_archive(self):
        projects = [{"id": "p", "kind": "film"}, {"id": "other", "kind": "film"}] + [{"id": "project-" + str(i), "kind": "film"} for i in range(18)]
        self.update_state(projects=projects)
        deleted = self.delete("project", "p")[0]
        saved = self.update_state(projects=projects + [{"id": "new-project", "kind": "film"}])
        self.assertEqual(len(saved["state"]["projects"]), 21)
        with self.assertRaisesRegex(InputError, "活跃数量"):
            self.trash.restore(deleted["id"])
        self.assertTrue(is_deleted(self.runtime, "project", "p", "p"))
        self.delete("project", "new-project", "new-project")
        self.trash.restore(deleted["id"])
        self.assertFalse(is_deleted(self.runtime, "project", "p", "p"))

    def test_http_post_contract_without_network_or_side_effects(self):
        handler = object.__new__(Handler)
        handler.server = SimpleNamespace(runtime=self.runtime, media=self.media, trash=self.trash)
        responses = []
        handler.send = lambda status, body: responses.append((status, body))
        handler.post("/api/trash", ["api", "trash"], {"items": [{"kind": "project", "targetId": "p"}]})
        self.assertEqual(responses[-1][0], 200)
        deleted = responses[-1][1]["items"][0]
        handler.post("/api/trash/" + deleted["id"] + "/restore", ["api", "trash", deleted["id"], "restore"], {})
        self.assertEqual(responses[-1], (200, {"items": [], "tombstones": []}))
        self.assertEqual(self.calls, [])


if __name__ == "__main__":
    unittest.main()

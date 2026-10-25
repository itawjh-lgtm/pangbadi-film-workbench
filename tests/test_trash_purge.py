"""Permanent deletion tests use isolated SQLite and never call a media provider."""
from copy import deepcopy
from pathlib import Path
from threading import Event, Thread
from types import SimpleNamespace
from unittest.mock import patch
import json
import unittest

from test_trash import TrashTests
from server.httpd import Handler
from server.runtime import InputError
from server.trash import TrashManager, is_deleted, is_purged


class PurgeTests(unittest.TestCase):
    setUp = TrashTests.setUp
    transport = TrashTests.transport
    nodes = TrashTests.nodes
    save_nodes = TrashTests.save_nodes
    run_record = TrashTests.run_record
    update_state = TrashTests.update_state
    delete = TrashTests.delete
    trash = TrashTests.trash

    def purge(self, entries):
        return self.trash.purge({"ids": [item["id"] for item in entries], "confirmation": "permanent-delete"})

    def test_requires_confirmation_unique_valid_selection_and_recoverable_state(self):
        self.run_record()
        entries = self.delete("run", "run-one")
        for payload in ({"ids": [entries[0]["id"]]}, {"ids": [], "confirmation": "permanent-delete"},
                        {"ids": [entries[0]["id"]] * 2, "confirmation": "permanent-delete"}):
            with self.assertRaises(InputError):
                self.trash.purge(payload)
        self.trash.restore(entries[0]["id"])
        with self.assertRaisesRegex(InputError, "已经恢复"):
            self.purge(entries)
        self.assertEqual(self.runtime.get("run", "run-one")["id"], "run-one")

    def test_run_purge_removes_owned_files_and_emits_content_free_child_tombstones(self):
        run = self.run_record()
        directory = self.runtime.directory / "runs" / run["id"]
        directory.mkdir(parents=True)
        (directory / "input.json").write_text('private-input')
        key_path = self.runtime.directory / "connections.json"
        key_before = key_path.read_bytes()
        result = self.purge(self.delete("run", run["id"]))
        self.assertEqual(result["items"], [])
        self.assertFalse(directory.exists())
        self.assertEqual(key_path.read_bytes(), key_before)
        self.assertTrue(is_purged(self.runtime, "artifact", "draft-one", "p"))
        self.assertTrue(is_deleted(self.runtime, "artifact", "draft-one", "p"))
        self.assertNotIn("private-old-draft", json.dumps(result))
        self.assertEqual({item["kind"] for item in result["tombstones"]}, {"run", "artifact"})
        for item in result["tombstones"]:
            self.assertNotIn("title", item)
            with self.assertRaisesRegex(InputError, "无法恢复"):
                self.trash.restore(item["id"])
        with self.assertRaises(InputError):
            self.runtime.get("run", run["id"])
        with self.assertRaises(InputError):
            self.runtime.artifact("draft-one")
        with self.assertRaisesRegex(InputError, "彻底删除"):
            self.runtime.save("run", run)
        self.assertEqual(self.calls, [])

    def test_validation_of_a_batch_is_atomic(self):
        first = self.run_record()
        self.run_record("second-run", artifact_id="second-draft")
        self.delete("run", first["id"])
        entries = self.delete("run", "second-run")
        self.trash.restore(next(item["id"] for item in entries if item["targetId"] == "second-run"))
        with self.assertRaises(InputError):
            self.purge(entries)
        self.assertEqual(len(self.runtime.all("run")), 2)
        self.assertEqual(self.trash.snapshot()["tombstones"], [])

    def test_busy_run_or_finishing_worker_blocks_all_cleanup(self):
        self.run_record()
        entries = self.delete("run", "run-one")
        self.runtime.cancel_events["run-one"] = Event()
        with self.assertRaisesRegex(InputError, "结束执行"):
            self.purge(entries)
        self.runtime.cancel_events.clear()
        self.run_record("new-run", status="running", artifact_id="new")
        with self.assertRaisesRegex(InputError, "正在执行"):
            self.purge(entries)
        self.assertFalse(is_purged(self.runtime, "run", "run-one", "p"))

    def test_project_cleanup_erases_all_workspace_versions_and_rejects_stale_snapshots(self):
        self.update_state(tasks=[{"id": "t", "projectId": "p", "title": "private-task", "dependencies": []}],
                          messages=[{"id": "n", "projectId": "p", "text": "private-note"}])
        stale = deepcopy(self.workspace.read())
        self.save_nodes()
        self.run_record()
        self.runtime.save("media", {"id": "m", "projectId": "p", "status": "succeeded", "outputs": [{"url": "https://example.com/result.png"}]})
        self.runtime.save("production", {"id": "plan", "projectId": "p", "status": "completed", "stages": []})
        self.runtime.save("canvas_estimate", {"id": "quote", "projectId": "p"})
        self.delete("note", "n")
        self.purge(self.delete("project", "p"))
        current = self.workspace.read()
        self.assertGreater(current["revision"], stale["revision"])
        self.assertEqual([project["id"] for project in current["state"]["projects"]], ["other"])
        for row in self.runtime.db.execute("SELECT body FROM workspace_snapshots"):
            self.assertNotIn("private-note", row[0]);self.assertNotIn("private-task", row[0])
        with self.assertRaisesRegex(InputError, "版本冲突"):
            changed = deepcopy(stale["state"]);changed["projects"].append({"id": "third"})
            self.workspace.save({"expectedRevision": stale["revision"], "state": changed})
        saved = self.workspace.save({"expectedRevision": current["revision"], "state": stale["state"]})
        self.assertEqual(saved["state"], current["state"])
        for kind in ("run", "media", "production", "canvas", "canvas_estimate"):
            self.assertEqual(self.runtime.all(kind), [])
        self.assertEqual(self.trash.list(), [])

    def test_artifact_cleanup_scrubs_run_messages_plan_history_and_cannot_be_resaved(self):
        run = self.run_record()
        artifact = run["artifacts"][0]
        directory = self.runtime.directory / "runs" / run["id"]
        directory.mkdir(parents=True)
        artifact["filename"] = "R04-draft.md"
        file = directory / artifact["filename"];file.write_text(artifact["body"])
        self.runtime.save("run", run)
        plan = {"id": "plan", "projectId": "p", "status": "paused", "stages": [{"id": "script", "artifacts": [deepcopy(artifact)], "history": [{"artifacts": [deepcopy(artifact)]}]}]}
        self.runtime.save("production", plan)
        self.delete("artifact", artifact["id"])
        with self.assertRaisesRegex(InputError, "自动协作"):
            self.purge(self.trash.list())
        result = self.purge(self.delete("production", "plan"))
        self.assertFalse(file.exists());self.assertTrue(directory.exists())
        self.assertNotIn("private-old-draft", json.dumps(self.runtime.get("run", run["id"])))
        with self.assertRaises(InputError):
            self.runtime.get("production", "plan")
        self.runtime.save("run", run)
        self.assertEqual(self.runtime.get("run", run["id"])["artifacts"], [])
        self.assertEqual(self.runtime.get("run", run["id"])["messages"], [])
        self.assertEqual(len(result["tombstones"]), 2)

    def test_recoverable_plan_history_still_protects_its_runs(self):
        self.run_record()
        self.runtime.save("production", {"id": "plan", "projectId": "p", "status": "paused", "stages": [
            {"id": "script", "runId": None, "artifacts": [], "history": [{"runId": "run-one", "artifacts": []}]}]})
        self.delete("production", "plan")
        selected = [item for item in self.delete("run", "run-one") if item["kind"] == "run"]
        with self.assertRaisesRegex(InputError, "自动协作"):
            self.purge(selected)
        self.purge(self.trash.list())
        self.assertEqual(self.runtime.all("run"), [])

    def test_corrupted_cross_project_plan_lineage_rejects_the_entire_purge(self):
        other = self.run_record("foreign-run", artifact_id="foreign-artifact", project="other")
        for linkage in ({"runId": "foreign-run", "artifacts": []},
                        {"runId": None, "artifacts": [deepcopy(other["artifacts"][0])]}):
            self.runtime.save("production", {"id": "plan", "projectId": "p", "status": "completed", "stages": [linkage]})
            entries = self.delete("production", "plan")
            with self.assertRaisesRegex(InputError, "归属不一致"):
                self.purge(entries)
            self.assertEqual(self.runtime.get("run", "foreign-run"), other)
            self.assertEqual(self.trash.snapshot()["tombstones"], [])

    def test_reverse_production_id_cannot_expand_into_a_different_project(self):
        self.runtime.save("production", {"id": "plan", "projectId": "p", "status": "completed", "stages": []})
        other = self.run_record("foreign-run", artifact_id="foreign-artifact", project="other", productionId="plan")
        entries = self.delete("production", "plan")
        with self.assertRaisesRegex(InputError, "归属不一致"):
            self.purge(entries)
        self.assertEqual(self.runtime.get("run", "foreign-run"), other)
        self.assertEqual(self.trash.snapshot()["tombstones"], [])

    def test_decision_gate_requires_its_dependent_task_in_the_same_purge(self):
        self.update_state(tasks=[{"id": "task-one", "projectId": "p", "title": "待拍板任务", "dependencies": [], "decisionId": "choice"}],
                          decisions=[{"id": "choice", "projectId": "p", "title": "创作方向"}])
        entries = self.delete("decision", "choice")
        with self.assertRaisesRegex(InputError, "仍引用所选决策"):
            self.purge(entries)
        self.assertEqual(self.workspace.read()["state"]["tasks"][0]["decisionId"], "choice")
        self.purge(self.delete("task", "task-one"))
        self.assertEqual(self.workspace.read()["state"]["tasks"], [])
        self.assertEqual(self.workspace.read()["state"]["decisions"], [])

    def test_artifact_cleanup_preserves_identical_but_unrelated_project_messages(self):
        self.run_record()
        other = self.run_record("other-run", artifact_id="other-artifact", project="other")
        self.purge(self.delete("artifact", "draft-one"))
        self.assertEqual(self.runtime.get("run", "other-run"), other)

    def test_node_purge_removes_historical_request_payload_and_expires_quote(self):
        self.save_nodes()
        self.runtime.save("canvas_estimate", {"id": "quote", "projectId": "p", "nodeIds": ["node-0"],
            "items": [{"nodeId": "node-0", "request": {"prompt": "private-node-request"}}], "expiresAt": 9999999999999, "withinBudget": True})
        self.runtime.save("canvas_batch", {"id": "batch", "projectId": "p", "status": "completed",
            "items": [{"nodeId": "node-0", "status": "succeeded", "request": {"prompt": "private-node-request"}}]})
        self.purge(self.delete("canvas_node", "node-0"))
        quote = self.runtime.get("canvas_estimate", "quote")
        self.assertEqual(quote["expiresAt"], 0);self.assertFalse(quote["withinBudget"])
        self.assertNotIn("private-node-request", json.dumps(quote))
        self.assertNotIn("private-node-request", json.dumps(self.runtime.get("canvas_batch", "batch")))

    def test_canvas_node_purge_cannot_reappear_through_stale_node_snapshot(self):
        original = self.save_nodes()
        self.purge(self.delete("canvas_node", "node-0"))
        current = self.manager.get("p")
        saved = self.manager.save("p", {"expectedRevision": current["revision"], "nodes": original["nodes"]})
        self.assertEqual([node["id"] for node in saved["nodes"]], ["node-1"])
        self.assertEqual([node["id"] for node in self.runtime.get("canvas", "p")["nodes"]], ["node-1"])

    def test_referenced_image_requires_dependent_nodes_in_same_purge(self):
        nodes = self.nodes(video=True);nodes[1]["referenceNodeId"] = "node-0"
        self.save_nodes(nodes)
        first = self.delete("canvas_node", "node-0")
        with self.assertRaisesRegex(InputError, "仍引用"):
            self.purge(first)
        all_entries = self.delete("canvas_node", "node-1")
        self.purge(all_entries)
        self.assertEqual(self.runtime.get("canvas", "p")["nodes"], [])

    def test_symlink_run_directory_refuses_to_delete_external_files(self):
        self.run_record()
        outside = self.runtime.directory / "external";outside.mkdir()
        outside_file = outside / "keep.md";outside_file.write_text("keep")
        runs = self.runtime.directory / "runs";runs.mkdir()
        (runs / "run-one").symlink_to(outside, target_is_directory=True)
        entries = self.delete("run", "run-one")
        with self.assertRaisesRegex(InputError, "路径异常"):
            self.purge(entries)
        self.assertEqual(outside_file.read_text(), "keep")
        self.assertEqual(self.trash.snapshot()["tombstones"], [])

    def test_transaction_failure_restores_staged_files_and_tombstones(self):
        self.run_record()
        directory = self.runtime.directory / "runs" / "run-one";directory.mkdir(parents=True)
        file = directory / "input.json";file.write_text("keep")
        entries = self.delete("run", "run-one")
        with patch.object(TrashManager, "_remove_purged_records", side_effect=RuntimeError("injected failure")):
            with self.assertRaisesRegex(RuntimeError, "injected"):
                self.purge(entries)
        self.assertEqual(file.read_text(), "keep")
        self.assertEqual(self.trash.list(), entries)
        self.assertEqual(self.trash.snapshot()["tombstones"], [])

    def test_restore_cannot_race_between_purge_validation_and_commit(self):
        self.run_record()
        entries = self.delete("run", "run-one")
        entered, release, restoring = Event(), Event(), Event()
        errors = []
        original = TrashManager._purge_dependencies
        def held(manager, expanded):
            original(manager, expanded);entered.set()
            if not release.wait(3):
                raise RuntimeError("test timeout")
        def purge():
            try:
                self.purge(entries)
            except Exception as error:
                errors.append(("purge", error))
        def restore():
            restoring.set()
            try:
                self.trash.restore(entries[0]["id"])
            except Exception as error:
                errors.append(("restore", error))
        with patch.object(TrashManager, "_purge_dependencies", held):
            first = Thread(target=purge);second = Thread(target=restore)
            first.start();self.assertTrue(entered.wait(3));second.start();self.assertTrue(restoring.wait(3));release.set()
            first.join(3);second.join(3)
        self.assertFalse(first.is_alive());self.assertFalse(second.is_alive())
        self.assertEqual(len(errors), 1);self.assertEqual(errors[0][0], "restore")
        self.assertIsInstance(errors[0][1], InputError)
        self.assertTrue(is_purged(self.runtime, "run", "run-one", "p"))

    def test_http_purge_response_and_subsequent_restore_response_share_tombstone_contract(self):
        self.run_record()
        entries = self.delete("run", "run-one")
        handler = object.__new__(Handler)
        handler.server = SimpleNamespace(runtime=self.runtime, media=self.media, trash=self.trash)
        responses = [];handler.send = lambda status, body: responses.append((status, body))
        handler.post("/api/trash/purge", ["api", "trash", "purge"], {"ids": [entries[0]["id"]], "confirmation": "permanent-delete"})
        self.assertEqual(responses[-1][0], 200)
        self.assertEqual(set(responses[-1][1]), {"items", "tombstones", "deletedIds"})
        self.assertEqual(len(responses[-1][1]["tombstones"]), 2)
        self.assertEqual(self.calls, [])


# Avoid importing the 27 base cases into this module's unittest discovery.
del TrashTests

if __name__ == "__main__":
    unittest.main()

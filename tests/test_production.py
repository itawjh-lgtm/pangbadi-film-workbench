"""Automatic collaboration uses real runtime records, isolated fake providers."""
import copy
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest

from server.production import ProductionManager
from server.runtime import InputError, Runtime


class ProductionCatalog:
    def get_role(self, agent):
        if agent not in ("R11", "R03", "R05", "R04", "R06"):
            raise KeyError(agent)
        return {"id": agent, "name": agent, "available": True, "hash": "role-" + agent,
                "shared_hash": "shared", "version": "test", "source": agent + ".md"}

    def build_instructions(self, agent):
        return "FULL_SHARED_AND_ROLE:" + agent


class ProductionProvider:
    def __init__(self):
        self.calls = []
        self.block_agent = None
        self.entered = threading.Event()
        self.release = threading.Event()
        self.release.set()
        self.fail_agent_once = None
        self.authenticated = True

    def health(self):
        return {"available": True, "authenticated": self.authenticated, "reason": "测试登录不可用"}

    def generate(self, instructions, prompt, workdir, cancel_event=None, on_event=None):
        agent = instructions.rsplit(":", 1)[-1]
        self.calls.append({"agent": agent, "prompt": prompt, "directory": str(workdir)})
        if agent == self.block_agent:
            self.entered.set()
            # Return success even after cancellation to test the runtime guard.
            self.release.wait(3)
        if self.fail_agent_once == agent:
            self.fail_agent_once = None
            raise RuntimeError("测试中的单阶段失败")
        return {"text": "# " + agent + "完整正文\n" + ("真实可回看的测试正文。" * 120),
                "usage": {"output_tokens": 12}}


class ProductionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="studio-production-test-")
        self.provider = ProductionProvider()
        self.runtime = Runtime(self.temp.name, ProductionCatalog(), self.provider)
        self.manager = ProductionManager(self.runtime, start_worker=False)

    def tearDown(self):
        self.provider.release.set()
        self.manager.close()
        self.runtime.close()
        self.runtime.db.close()
        self.temp.cleanup()

    def payload(self, **changes):
        result = {"requestId": "production-request", "project": {
            "id": "project-a", "title": "测试影视项目", "kind": "film", "brief": "30秒科普", "members": []},
            "prompt": "写一支30秒海洋科普短片", "reviewMode": "stepwise"}
        result.update(changes)
        return result

    def wait_for(self, plan_id, predicate, *, pump=True):
        deadline = time.monotonic() + 5
        latest = None
        while time.monotonic() < deadline:
            if pump:
                self.manager.reconcile()
            latest = self.manager.get(plan_id)
            if predicate(latest):
                return latest
            time.sleep(.005)
        self.fail("Production did not reach expected state: " + json.dumps(latest, ensure_ascii=False)[:500])

    def wait_run(self, run_id):
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            result = self.runtime.get("run", run_id)
            if result["status"] not in ("queued", "running"):
                return result
            time.sleep(.005)
        self.fail("Run did not finish")

    def approve(self, plan, stage_id):
        return self.manager.review(plan["id"], {"expectedRevision": plan["revision"],
                                                "stageId": stage_id, "action": "approve", "note": "确认此版"})

    def restart(self):
        # Simulate loss of the manager without its graceful pause transition.
        self.manager._stop.set()
        self.runtime.close()
        self.runtime.db.close()
        self.provider = ProductionProvider()
        self.runtime = Runtime(self.temp.name, ProductionCatalog(), self.provider)
        self.manager = ProductionManager(self.runtime, start_worker=False)

    def test_start_is_persistent_idempotent_and_does_not_mutate_project(self):
        data = self.payload()
        original = copy.deepcopy(data)
        plan = self.manager.start(data)
        self.assertEqual(data, original)
        self.assertEqual(plan["revision"], 1)
        self.assertEqual(plan["currentStageId"], "plan")
        self.assertEqual(len(plan["stages"]), 6)
        self.assertEqual(plan["project"]["members"], ["R03", "R04", "R05", "R06", "R11"])
        self.assertEqual(self.manager.start(data)["id"], plan["id"])
        self.assertEqual(self.provider.calls, [])
        for changed in ({"prompt": "不同要求"}, {"requestId": "new-request"}):
            with self.assertRaises(InputError) as raised:
                self.manager.start(self.payload(**changed))
            self.assertEqual(raised.exception.status, 409)
        self.assertEqual(self.manager.list("project-a")[0]["id"], plan["id"])
        self.assertEqual(self.manager.list("project-b"), [])

    def test_concurrent_start_only_creates_one_plan(self):
        outputs, errors = [], []
        def start():
            try:
                outputs.append(self.manager.start(self.payload())["id"])
            except Exception as error:
                errors.append(error)
        workers = [threading.Thread(target=start) for _ in range(6)]
        for worker in workers:
            worker.start()
        for worker in workers:
            worker.join(2)
        self.assertEqual(errors, [])
        self.assertEqual(len(outputs), 6)
        self.assertEqual(len(set(outputs)), 1)
        self.assertEqual(len(self.runtime.all("production")), 1)

    def test_stepwise_gate_handoffs_full_text_and_final_acceptance(self):
        plan = self.manager.start(self.payload())
        plan = self.wait_for(plan["id"], lambda p: p["status"] == "awaiting_review")
        self.assertEqual(plan["currentStageId"], "script")
        self.assertEqual([call["agent"] for call in self.provider.calls], ["R11", "R03"])
        first_artifact = plan["stages"][0]["artifacts"][0]
        self.assertTrue(first_artifact["title"].startswith("制作规划 · 第1版 · 测试影视项目"))
        self.assertTrue(plan["stages"][1]["artifacts"][0]["title"].startswith("剧本创作 · 第1版 · 测试影视项目"))
        self.assertGreater(len(first_artifact["body"]), 1000)
        self.assertIn(first_artifact["hash"], self.provider.calls[1]["prompt"])
        self.assertIn(first_artifact["body"], self.provider.calls[1]["prompt"].replace("\\n", "\n"))
        self.assertEqual(plan["stages"][1]["inputArtifactIds"], [first_artifact["id"]])
        for _ in range(4):
            self.manager.reconcile()
        self.assertEqual(len(self.provider.calls), 2)
        plan = self.approve(plan, "script")
        plan = self.wait_for(plan["id"], lambda p: p["status"] == "awaiting_review")
        self.assertEqual(plan["currentStageId"], "visual")
        plan = self.approve(plan, "visual")
        plan = self.wait_for(plan["id"], lambda p: p["status"] == "awaiting_review")
        self.assertEqual(plan["currentStageId"], "delivery")
        self.assertEqual([call["agent"] for call in self.provider.calls], ["R11", "R03", "R05", "R04", "R06", "R11"])
        self.assertEqual(plan["mediaReadiness"]["status"], "inputs_prepared")
        self.assertFalse(plan["mediaReadiness"]["imagesGenerated"])
        self.assertFalse(plan["mediaReadiness"]["videosGenerated"])
        plan = self.approve(plan, "delivery")
        self.assertEqual(plan["status"], "completed")
        self.assertIsNone(plan["currentStageId"])
        self.assertEqual([e["seq"] for e in plan["events"]], list(range(1, len(plan["events"]) + 1)))
        self.assertEqual(plan["stages"][-1]["review"]["reviewer"], "user")
        self.assertEqual(self.runtime.all("media"), [])

    def test_continuous_still_requires_final_review(self):
        plan = self.manager.start(self.payload(reviewMode="continuous"))
        plan = self.wait_for(plan["id"], lambda p: p["status"] == "awaiting_review")
        self.assertEqual(plan["currentStageId"], "delivery")
        self.assertEqual(len(self.provider.calls), 6)
        self.assertIsNone(plan["stages"][1]["review"])
        self.assertEqual(len(plan["stages"][-1]["inputArtifactIds"]), 5)

    def test_review_cas_prevents_duplicate_or_stale_action(self):
        plan = self.manager.start(self.payload())
        plan = self.wait_for(plan["id"], lambda p: p["status"] == "awaiting_review")
        data = {"expectedRevision": plan["revision"], "stageId": "script", "action": "approve"}
        self.manager.review(plan["id"], data)
        with self.assertRaises(InputError) as raised:
            self.manager.review(plan["id"], data)
        self.assertEqual(raised.exception.status, 409)
        with self.assertRaises(InputError):
            self.manager.pause(plan["id"], {"expectedRevision": plan["revision"]})
        with self.assertRaises(InputError):
            self.manager.resume(plan["id"], {})

    def test_failed_stage_resumes_without_repeating_completed_work(self):
        self.provider.fail_agent_once = "R05"
        plan = self.manager.start(self.payload(reviewMode="continuous"))
        plan = self.wait_for(plan["id"], lambda p: p["status"] == "failed")
        self.assertEqual(plan["currentStageId"], "visual")
        prior = plan["stages"][1]["artifacts"][0]["id"]
        plan = self.manager.resume(plan["id"], {"expectedRevision": plan["revision"]})
        plan = self.wait_for(plan["id"], lambda p: p["status"] == "awaiting_review")
        self.assertEqual(plan["stages"][1]["artifacts"][0]["id"], prior)
        visual = plan["stages"][2]
        self.assertEqual(visual["attempt"], 2)
        self.assertEqual(visual["history"][0]["attempt"], 1)
        self.assertEqual(visual["history"][0]["status"], "failed")
        self.assertEqual([call["agent"] for call in self.provider.calls].count("R03"), 1)
        self.assertEqual(len(self.provider.calls), 7)

    def test_health_failure_is_saved_and_retryable(self):
        self.provider.authenticated = False
        plan = self.manager.start(self.payload())
        self.manager.reconcile()
        plan = self.manager.get(plan["id"])
        self.assertEqual(plan["status"], "failed")
        self.assertIn("测试登录不可用", plan["error"])
        self.assertEqual(self.provider.calls, [])
        self.provider.authenticated = True
        plan = self.manager.resume(plan["id"], {"expectedRevision": plan["revision"]})
        plan = self.wait_for(plan["id"], lambda p: p["status"] == "awaiting_review")
        self.assertEqual(plan["stages"][0]["attempt"], 2)

    def test_pause_wins_over_late_success_and_resume_uses_new_attempt(self):
        self.provider.block_agent = "R11"
        self.provider.release.clear()
        plan = self.manager.start(self.payload())
        self.manager.reconcile()
        self.assertTrue(self.provider.entered.wait(2))
        plan = self.manager.get(plan["id"])
        old_run = plan["stages"][0]["runId"]
        plan = self.manager.pause(plan["id"], {"expectedRevision": plan["revision"]})
        self.provider.release.set()
        self.wait_run(old_run)
        self.manager.reconcile()
        self.assertEqual(self.manager.get(plan["id"])["status"], "paused")
        self.assertEqual(self.runtime.get("run", old_run)["artifacts"], [])
        plan = self.manager.resume(plan["id"], {"expectedRevision": plan["revision"]})
        plan = self.wait_for(plan["id"], lambda p: p["status"] == "awaiting_review")
        self.assertEqual(plan["stages"][0]["attempt"], 2)
        self.assertNotEqual(plan["stages"][0]["runId"], old_run)
        self.assertEqual(plan["stages"][0]["history"][0]["runId"], old_run)

    def test_pause_after_success_recovers_output_before_scheduler_consumes_it(self):
        plan = self.manager.start(self.payload())
        self.manager.reconcile()
        plan = self.manager.get(plan["id"])
        old_run = plan["stages"][0]["runId"]
        self.wait_run(old_run)
        plan = self.manager.pause(plan["id"], {"expectedRevision": plan["revision"]})
        self.assertEqual(plan["status"], "paused")
        self.assertEqual(plan["stages"][0]["status"], "completed")
        self.assertTrue(plan["stages"][0]["artifacts"])
        plan = self.manager.resume(plan["id"], {"expectedRevision": plan["revision"]})
        plan = self.wait_for(plan["id"], lambda p: p["status"] == "awaiting_review")
        self.assertEqual(len(self.provider.calls), 2)
        self.assertEqual(plan["stages"][0]["runId"], old_run)

    def test_pausing_review_does_not_bypass_approval_on_resume(self):
        plan = self.manager.start(self.payload())
        plan = self.wait_for(plan["id"], lambda p: p["status"] == "awaiting_review")
        artifact = plan["stages"][1]["artifacts"][0]["id"]
        plan = self.manager.pause(plan["id"], {"expectedRevision": plan["revision"]})
        plan = self.manager.resume(plan["id"], {"expectedRevision": plan["revision"]})
        self.assertEqual(plan["status"], "awaiting_review")
        self.assertEqual(plan["stages"][1]["artifacts"][0]["id"], artifact)
        self.manager.reconcile()
        self.assertEqual(len(self.provider.calls), 2)

    def test_revise_preserves_old_full_versions_and_invalidates_downstream(self):
        plan = self.manager.start(self.payload(reviewMode="continuous"))
        plan = self.wait_for(plan["id"], lambda p: p["status"] == "awaiting_review")
        old = copy.deepcopy(plan["stages"])
        plan = self.manager.review(plan["id"], {"expectedRevision": plan["revision"],
              "stageId": "script", "action": "revise", "note": "把第三段改成夜间场景，保留海豚角色"})
        self.assertEqual(plan["stages"][0]["artifacts"], old[0]["artifacts"])
        self.assertEqual(plan["stages"][1]["status"], "pending")
        self.assertTrue(all(stage["status"] == "stale" for stage in plan["stages"][2:]))
        for index in range(1, 6):
            self.assertEqual(plan["stages"][index]["history"][0]["artifacts"], old[index]["artifacts"])
        plan = self.wait_for(plan["id"], lambda p: p["status"] == "awaiting_review")
        self.assertEqual(len(self.provider.calls), 11)
        self.assertIn("把第三段改成夜间场景", self.provider.calls[6]["prompt"])
        self.assertIn(old[1]["artifacts"][0]["id"], plan["stages"][1]["inputArtifactIds"])
        self.assertNotEqual(plan["stages"][1]["artifacts"][0]["id"], old[1]["artifacts"][0]["id"])
        self.assertEqual(self.runtime.artifact(old[1]["artifacts"][0]["id"])["body"], old[1]["artifacts"][0]["body"])
        self.assertNotIn(old[2]["artifacts"][0]["id"], plan["stages"][-1]["inputArtifactIds"])

    def test_revise_cancels_inflight_downstream_without_late_overwrite(self):
        self.provider.block_agent = "R05"
        self.provider.release.clear()
        plan = self.manager.start(self.payload(reviewMode="continuous"))
        plan = self.wait_for(plan["id"], lambda p: p["stages"][2]["runId"] is not None)
        self.assertTrue(self.provider.entered.wait(2))
        old_run = plan["stages"][2]["runId"]
        plan = self.manager.review(plan["id"], {"expectedRevision": plan["revision"],
              "stageId": "script", "action": "revise", "note": "增加明确的结尾"})
        self.provider.release.set()
        self.assertEqual(self.wait_run(old_run)["status"], "cancelled")
        self.assertEqual(self.runtime.get("run", old_run)["artifacts"], [])
        plan = self.wait_for(plan["id"], lambda p: p["status"] == "awaiting_review")
        self.assertEqual(plan["stages"][2]["history"][0]["runId"], old_run)
        self.assertNotEqual(plan["stages"][2]["runId"], old_run)

    def test_failed_revision_resume_keeps_original_full_draft(self):
        plan = self.manager.start(self.payload())
        plan = self.wait_for(plan["id"], lambda p: p["status"] == "awaiting_review")
        original = copy.deepcopy(plan["stages"][1]["artifacts"][0])
        self.provider.fail_agent_once = "R03"
        plan = self.manager.review(plan["id"], {"expectedRevision": plan["revision"],
            "stageId": "script", "action": "revise", "note": "只改结尾，其他剧情保持原稿"})
        plan = self.wait_for(plan["id"], lambda p: p["status"] == "failed")
        self.assertIn(original["id"], plan["stages"][1]["inputArtifactIds"])
        plan = self.manager.resume(plan["id"], {"expectedRevision": plan["revision"]})
        self.assertEqual([len(item["artifacts"]) for item in plan["stages"][1]["history"]], [1, 0])
        plan = self.wait_for(plan["id"], lambda p: p["status"] == "awaiting_review")
        script = plan["stages"][1]
        self.assertEqual(script["attempt"], 3)
        self.assertIn(original["id"], script["inputArtifactIds"])
        self.assertIn(original["body"], self.provider.calls[-1]["prompt"].replace("\\n", "\n"))
        self.assertIn("只改结尾，其他剧情保持原稿", self.provider.calls[-1]["prompt"])
        self.assertTrue(script["artifacts"][0]["title"].startswith("剧本创作 · 第3版 · 测试影视项目"))

    def test_paused_revision_resume_keeps_original_full_draft(self):
        plan = self.manager.start(self.payload())
        plan = self.wait_for(plan["id"], lambda p: p["status"] == "awaiting_review")
        original = copy.deepcopy(plan["stages"][1]["artifacts"][0])
        self.provider.block_agent = "R03"
        self.provider.release.clear()
        plan = self.manager.review(plan["id"], {"expectedRevision": plan["revision"],
            "stageId": "script", "action": "revise", "note": "保留全部人物，只改最后一句台词"})
        self.manager.reconcile()
        self.assertTrue(self.provider.entered.wait(2))
        plan = self.manager.get(plan["id"])
        interrupted_run = plan["stages"][1]["runId"]
        plan = self.manager.pause(plan["id"], {"expectedRevision": plan["revision"]})
        self.provider.release.set()
        self.assertEqual(self.wait_run(interrupted_run)["status"], "cancelled")
        plan = self.manager.resume(plan["id"], {"expectedRevision": plan["revision"]})
        self.assertEqual([len(item["artifacts"]) for item in plan["stages"][1]["history"]], [1, 0])
        plan = self.wait_for(plan["id"], lambda p: p["status"] == "awaiting_review")
        self.assertEqual(plan["stages"][1]["attempt"], 3)
        self.assertIn(original["id"], plan["stages"][1]["inputArtifactIds"])
        self.assertIn(original["body"], self.provider.calls[-1]["prompt"].replace("\\n", "\n"))
        self.assertIn("保留全部人物，只改最后一句台词", self.provider.calls[-1]["prompt"])

    def test_restart_consumes_success_and_recovers_orphan_by_request_id(self):
        plan = self.manager.start(self.payload())
        self.manager.reconcile()
        plan = self.manager.get(plan["id"])
        run_id = plan["stages"][0]["runId"]
        self.wait_run(run_id)
        # Model succeeded after run insert but before the plan could save runId.
        plan["stages"][0]["runId"] = None
        self.runtime.save("production", plan)
        self.restart()
        plan = self.manager.get(plan["id"])
        self.assertEqual(plan["status"], "paused")
        self.assertEqual(plan["stages"][0]["status"], "completed")
        self.assertEqual(plan["stages"][0]["runId"], run_id)
        self.assertEqual(self.provider.calls, [])
        plan = self.manager.resume(plan["id"], {"expectedRevision": plan["revision"]})
        plan = self.wait_for(plan["id"], lambda p: p["status"] == "awaiting_review")
        self.assertEqual([call["agent"] for call in self.provider.calls], ["R03"])

    def test_restart_interrupted_run_waits_for_explicit_resume(self):
        plan = self.manager.start(self.payload())
        self.manager.reconcile()
        plan = self.manager.get(plan["id"])
        run = self.wait_run(plan["stages"][0]["runId"])
        # Persist the state that an abrupt process exit would leave behind.
        run.update(status="running", artifacts=[], messages=[])
        run["steps"][0]["status"] = "running"
        self.runtime.save("run", run)
        self.restart()
        plan = self.manager.get(plan["id"])
        self.assertEqual(plan["status"], "paused")
        self.assertEqual(plan["stages"][0]["status"], "paused")
        self.manager.reconcile()
        self.assertEqual(self.provider.calls, [])
        plan = self.manager.resume(plan["id"], {"expectedRevision": plan["revision"]})
        plan = self.wait_for(plan["id"], lambda p: p["status"] == "awaiting_review")
        self.assertEqual(plan["stages"][0]["attempt"], 2)
        self.assertEqual(plan["stages"][0]["history"][0]["runId"], run["id"])

    def test_busy_manual_run_is_waited_on_without_marking_plan_failed(self):
        self.provider.block_agent = "R03"
        self.provider.release.clear()
        manual = self.runtime.start({"requestId": "manual-run", "mode": "chat", "prompt": "先讨论",
            "project": {"id": "project-a", "kind": "film", "members": ["R03"]}, "agentIds": ["R03"]})
        self.assertTrue(self.provider.entered.wait(2))
        plan = self.manager.start(self.payload())
        for _ in range(3):
            self.manager.reconcile()
        plan = self.manager.get(plan["id"])
        self.assertEqual(plan["status"], "running")
        self.assertEqual(plan["stages"][0]["status"], "pending")
        self.assertIsNone(plan["stages"][0]["runId"])
        self.runtime.cancel(manual["id"])
        self.provider.release.set()
        plan = self.wait_for(plan["id"], lambda p: p["status"] == "awaiting_review")
        self.assertEqual(plan["currentStageId"], "script")

    def test_cross_project_sources_are_not_passed_to_provider(self):
        first = self.manager.start(self.payload())
        first = self.wait_for(first["id"], lambda p: p["status"] == "awaiting_review")
        foreign = first["stages"][0]["artifacts"][0]
        second_data = self.payload(requestId="second-project", project={"id": "project-b", "kind": "film", "members": []})
        second = self.manager.start(second_data)
        second["stages"][0].update(status="completed", artifacts=[foreign], outputArtifactIds=[foreign["id"]])
        self.runtime.save("production", second)
        calls = len(self.provider.calls)
        self.manager.reconcile()
        second = self.manager.get(second["id"])
        self.assertEqual(second["status"], "failed")
        self.assertIn("其他项目", second["error"])
        self.assertEqual(len(self.provider.calls), calls)

    def test_game_invalid_inputs_and_new_plan_cannot_reopen_old_lineage(self):
        for payload in (self.payload(project={"id": "game", "kind": "game"}),
                        self.payload(reviewMode="fake"), self.payload(prompt=""), self.payload(requestId="../bad")):
            with self.assertRaises(InputError):
                self.manager.start(payload)
        plan = self.manager.start(self.payload(reviewMode="continuous"))
        plan = self.wait_for(plan["id"], lambda p: p["status"] == "awaiting_review")
        plan = self.approve(plan, "delivery")
        self.manager.start(self.payload(requestId="new-plan"))
        with self.assertRaises(InputError) as raised:
            self.manager.review(plan["id"], {"expectedRevision": plan["revision"],
                "stageId": "script", "action": "revise", "note": "改写"})
        self.assertEqual(raised.exception.status, 409)

    def test_close_persists_pause_and_stops_inflight_run(self):
        self.provider.block_agent = "R11"
        self.provider.release.clear()
        plan = self.manager.start(self.payload())
        self.manager.reconcile()
        self.assertTrue(self.provider.entered.wait(2))
        self.manager.close()
        plan = self.manager.get(plan["id"])
        self.assertEqual(plan["status"], "paused")
        self.assertEqual(self.runtime.get("run", plan["stages"][0]["runId"])["status"], "cancelled")
        with self.assertRaises(InputError):
            self.manager.resume(plan["id"], {"expectedRevision": plan["revision"]})


if __name__ == "__main__":
    unittest.main()

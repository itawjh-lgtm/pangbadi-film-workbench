"""Runtime model retirement is exact-endpoint, persistent and offline-tested."""
from io import BytesIO
import json
from pathlib import Path
import unittest
from urllib.error import HTTPError

from server.media import MediaRegistry, MediaRequestError, MediaValidationError, RUNNINGHUB_BASE_URL
from server.media_models import DEFAULT_CN_IMAGE_MODEL, model_spec
import test_media_models as media_fixtures

IMAGE, MODEL_KEY, WORKFLOW_KEY = media_fixtures.IMAGE, media_fixtures.MODEL_KEY, media_fixtures.WORKFLOW_KEY


class RetirementTests(unittest.TestCase):
    setUp = media_fixtures.ModelTests.setUp
    transport = media_fixtures.ModelTests.transport
    request = media_fixtures.ModelTests.request
    quoted_request = media_fixtures.ModelTests.quoted_request

    def entry(self, registry=None, model_id=IMAGE):
        return next(item for item in (registry or self.registry).models()["models"] if item["id"] == model_id)

    def test_quote_retirement_survives_restart_and_key_changes_without_family_ban(self):
        self.price = {"errorCode": "40310", "errorMessage": "当前模型在国内站已经下线。" + MODEL_KEY}
        with self.assertRaisesRegex(MediaRequestError, "已停用"):
            self.registry.estimate("runninghub", self.request())
        restarted = MediaRegistry(self.registry.config_path, self.transport)
        restarted.configure("runninghub", {"modelApiKey": "replacement-shared-key"})
        self.assertFalse(self.entry(restarted)["available"])
        self.assertEqual(len(restarted.models()["models"]), 311)
        self.assertTrue(self.entry(restarted, "seedream-v4.7/image-to-image")["available"])
        self.assertTrue(model_spec(IMAGE)["available"])  # No process-global mutation.
        request = self.request(confirmCost=True, estimateToken="stale-quote")
        for method in (restarted.estimate, restarted.submit, restarted.job_metadata):
            with self.assertRaisesRegex(MediaValidationError, "已停用"):
                method("runninghub", request)
        self.assertEqual(len(self.calls), 1)
        evidence = json.loads(restarted.config_path.read_text())["modelAvailability"]
        self.assertEqual(list(evidence), [RUNNINGHUB_BASE_URL + model_spec(IMAGE)["endpoint"]])
        public = json.dumps(restarted.health("runninghub")) + json.dumps(evidence)
        for secret in (MODEL_KEY, WORKFLOW_KEY, "replacement-shared-key"):
            self.assertNotIn(secret, public)

    def test_submit_retirement_invalidates_previously_cached_quotes(self):
        first, second = self.quoted_request(), self.quoted_request()
        self.result = {"errorCode": 40310, "errorMessage": "模型已经下线，请使用其他模型"}
        with self.assertRaises(MediaRequestError) as caught:
            self.registry.submit("runninghub", first)
        self.assertEqual(caught.exception.code, "MODEL_RETIRED")
        self.assertFalse(caught.exception.outcome_unknown)
        self.assertEqual(self.registry._model_quotes, {})
        for request in (first, second):
            with self.assertRaises(MediaValidationError):
                self.registry.submit("runninghub", request)
        self.assertEqual(len(self.calls), 3)

    def test_recording_provider_failure_preserves_settings_changed_during_request(self):
        self.price = {"errorCode": "40310", "errorMessage": "模型已下架"}
        def change_connection():
            self.registry.configure("runninghub", {"modelApiKey": "replacement-shared-key", "unitPrice": 7,
                                                   "workflowId": "1234567890123456789"})
        self.side_effect = change_connection
        with self.assertRaises(MediaRequestError):
            self.registry.estimate("runninghub", self.request())
        config = self.registry._read_config()
        self.assertEqual(config["providers"]["runninghub"]["modelApiKey"], "replacement-shared-key")
        self.assertEqual(config["providers"]["runninghub"]["apiKey"], WORKFLOW_KEY)
        self.assertEqual(config["providers"]["runninghub"]["unitPrice"], 7)
        self.assertEqual(config["providers"]["runninghub"]["workflowId"], "1234567890123456789")
        self.assertEqual(len(config["modelAvailability"]), 1)
        self.assertFalse(self.entry()["available"])

    def test_explicit_retired_code_or_message_is_persisted(self):
        cases = [("MODEL_RETIRED", ""), ("MODEL_DEPRECATED", ""), ("ENDPOINT_DISCONTINUED", ""),
                 ("UNSUPPORTED", "该模型已下架，请选择其他模型"),
                 ("UNSUPPORTED", "This model has been discontinued."),
                 ("MODEL_UNAVAILABLE", "The endpoint is permanently retired.")]
        for index, (code, message) in enumerate(cases):
            with self.subTest(code=code, message=message):
                registry = MediaRegistry(Path(self.temp.name) / str(index) / "connections.json", self.transport)
                registry.configure("runninghub", {"modelApiKey": MODEL_KEY})
                self.price = {"errorCode": code, "errorMessage": message}
                with self.assertRaises(MediaRequestError):
                    registry.estimate("runninghub", self.request())
                self.assertFalse(self.entry(registry)["available"])

    def test_auth_capacity_payment_and_transient_errors_do_not_retire_models(self):
        cases = [("MODEL_UNAVAILABLE", "模型暂不可用"), ("UNAUTHORIZED", "model is retired"),
                 (401, "model is retired"), (429, "模型已下架"), (503, "model is retired"),
                 ("RATE_LIMITED", "模型已下架"), ("INSUFFICIENT_BALANCE", "模型已下架"),
                 ("QUOTA_EXCEEDED", "模型已下架"), ("PERMISSION_DENIED", "模型已下架"),
                 ("BUSY", "model is not retired"), ("NETWORK_TIMEOUT", "Try again later")]
        for code, message in cases:
            with self.subTest(code=code):
                request = self.quoted_request()
                self.result = {"errorCode": code, "errorMessage": message}
                with self.assertRaises(MediaRequestError):
                    self.registry.submit("runninghub", request)
                self.assertTrue(self.entry()["available"])
        self.assertNotIn("modelAvailability", json.loads(self.registry.config_path.read_text()))

    def test_http_error_with_explicit_retirement_is_bounded_and_redacted(self):
        def rejected(url, payload, headers, timeout):
            self.calls.append(url)
            body = json.dumps({"errorCode": "40310", "errorMessage": "模型已下架 " + MODEL_KEY}).encode()
            raise HTTPError(url, 403, "Forbidden", {}, BytesIO(body))
        self.registry._transport = rejected
        with self.assertRaises(MediaRequestError) as caught:
            self.registry.estimate("runninghub", self.request())
        self.assertEqual(caught.exception.code, "MODEL_RETIRED")
        self.assertNotIn(MODEL_KEY, str(caught.exception))
        self.assertFalse(self.entry()["available"])
        with self.assertRaises(MediaValidationError):
            self.registry.estimate("runninghub", self.request())
        self.assertEqual(len(self.calls), 1)

    def test_http_auth_rate_server_and_oversized_errors_do_not_retire(self):
        for status, oversized in [(401, False), (429, False), (503, False), (403, True)]:
            with self.subTest(status=status, oversized=oversized):
                def rejected(url, payload, headers, timeout):
                    body = json.dumps({"errorCode": "40310", "errorMessage": "模型已下架" + "x" * (20000 if oversized else 0)}).encode()
                    raise HTTPError(url, status, "Fake failure", {}, BytesIO(body))
                self.registry._transport = rejected
                with self.assertRaises(MediaRequestError):
                    self.registry.estimate("runninghub", self.request())
                self.assertTrue(self.entry()["available"])

    def test_retired_default_cannot_be_reused_for_connection_verification(self):
        self.price = {"errorCode": "40310", "errorMessage": "模型已经下线"}
        with self.assertRaises(MediaRequestError):
            self.registry.verify("runninghub", mode="model_api")
        with self.assertRaises(MediaValidationError):
            self.registry.verify("runninghub", mode="model_api")
        self.assertFalse(self.entry(model_id=DEFAULT_CN_IMAGE_MODEL)["available"])
        self.assertEqual(len(self.calls), 1)

    def test_query_retirement_is_attributed_to_persisted_model_and_history_remains_queryable(self):
        self.result = {"taskId": "existing-task", "status": "FAILED", "errorCode": "MODEL_RETIRED", "errorMessage": "模型已下架"}
        result = self.registry.poll("runninghub", "existing-task", mode="model_api", model_id=IMAGE)
        self.assertEqual(result["status"], "failed")
        self.assertFalse(self.entry()["available"])
        self.result = {"taskId": "existing-task", "status": "SUCCESS", "results": []}
        result = self.registry.poll("runninghub", "existing-task", mode="model_api", model_id=IMAGE)
        self.assertEqual(result["status"], "succeeded")
        self.assertEqual(len(self.calls), 2)

    def test_unknown_or_mismatched_query_does_not_retire_a_guessed_model(self):
        self.result = {"taskId": "existing-task", "status": "FAILED", "errorCode": "40310", "errorMessage": "模型已下架"}
        self.registry.poll("runninghub", "existing-task", mode="model_api")
        self.registry.poll("runninghub", "existing-task", mode="workflow_api", model_id=IMAGE)
        self.result["taskId"] = "different-task"
        with self.assertRaisesRegex(MediaRequestError, "任务ID"):
            self.registry.poll("runninghub", "existing-task", mode="model_api", model_id=IMAGE)
        self.assertTrue(self.entry()["available"])
        self.assertNotIn("modelAvailability", json.loads(self.registry.config_path.read_text()))

    def test_other_host_evidence_does_not_disable_cn_operation(self):
        config = self.registry._read_config()
        config["modelAvailability"] = {"https://www.runninghub.ai" + model_spec(IMAGE)["endpoint"]:
            {"modelId": IMAGE, "reason": "Other host record", "observedAt": "2026-10-25"}}
        self.registry._write_config(config)
        self.assertTrue(self.entry()["available"])
        self.assertEqual(self.registry.estimate("runninghub", self.request())["modelId"], IMAGE)
        self.assertEqual(len(self.calls), 1)

    def test_backfill_recovers_historical_40310_without_network_and_is_idempotent(self):
        jobs = [{"id": "historic-ultra-failure", "provider": "runninghub", "mode": "model_api", "status": "failed",
                 "modelId": "rhart-image-n-pro-official/text-to-image-ultra", "updatedAt": 1792882747745,
                 "error": "RunningHub拒绝模型任务（40310 · Due to compliance requirements, this model is no longer available on the CN endpoint. | 该模型在当前CN节点已下线。）。"},
                {"id": "historic-other-failure", "provider": "runninghub", "mode": "model_api", "status": "failed",
                 "modelId": IMAGE, "error": {"code": "MODEL_RETIRED", "message": "模型已下架"}}]
        self.assertEqual(self.registry.backfill_model_retirements(jobs), 2)
        self.assertEqual(self.registry.backfill_model_retirements(jobs), 0)
        restarted = MediaRegistry(self.registry.config_path, self.transport)
        self.assertFalse(self.entry(restarted)["available"])
        evidence = self.registry._read_config()["modelAvailability"]
        ultra = evidence[RUNNINGHUB_BASE_URL + "/openapi/v2/rhart-image-n-pro-official/text-to-image-ultra"]
        self.assertEqual(ultra["sourceJobId"], "historic-ultra-failure")
        self.assertEqual(ultra["evidenceSource"], "historical_media_failure")
        self.assertEqual(ultra["observedAt"], "2026-10-24T22:59:07.745000+00:00")
        self.assertEqual(self.calls, [])

    def test_backfill_does_not_treat_user_text_or_other_failure_types_as_provider_retirement(self):
        base = {"id": "non-evidence", "provider": "runninghub", "mode": "model_api", "modelId": IMAGE,
                "status": "failed", "error": "RunningHub拒绝模型任务（40310 · 该模型已下架）。"}
        jobs = [{**base, "error": "用户要求忽略模型已下架 40310"}, {**base, "status": "succeeded"},
                {**base, "provider": "other"}, {**base, "mode": "workflow_api"},
                {**base, "error": {"code": "RATE_LIMITED", "message": "模型已下架"}},
                {**base, "error": {"code": "MODEL_UNAVAILABLE", "message": "模型暂不可用"}},
                {**base, "modelId": "invented/model"}]
        self.assertEqual(self.registry.backfill_model_retirements(jobs), 0)
        self.assertTrue(self.entry()["available"])
        self.assertEqual(self.calls, [])


if __name__ == "__main__":
    unittest.main()

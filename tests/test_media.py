"""Offline contracts for media configuration, spending gates and provider results.

All external requests use a fake transport. No real task is created or queried.
"""

from copy import deepcopy
import io
import json
from pathlib import Path
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

from server.media import (  # noqa: E402
    CREATE_ENDPOINT, QUERY_ENDPOINT, RUNNINGHUB_BASE_URL,
    MediaRegistry, MediaRequestError, MediaValidationError,
    _NoRedirect, _default_transport,
)


SECRET = "test-secret-never-real-key"


class FakeTransport:
    def __init__(self):
        self.calls = []
        self.response = {"code": 0, "data": {"taskId": "task-123", "taskStatus": "QUEUED"}}
        self.error = None

    def __call__(self, url, payload, headers, timeout):
        self.calls.append((url, deepcopy(payload), deepcopy(headers), timeout))
        if self.error:
            raise self.error
        return deepcopy(self.response)


class MediaTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "runtime" / "connections.json"
        self.transport = FakeTransport()
        self.registry = MediaRegistry(self.path, self.transport, timeout=3)

    def tearDown(self):
        self.temp.cleanup()

    def configure(self):
        return self.registry.configure("runninghub", {"apiKey": SECRET})

    def request(self, **changes):
        request = {"workflowId": "123456", "nodeInfoList": [
            {"nodeId": "6", "fieldName": "text", "fieldValue": "测试素材"}],
            "unitPrice": 1.25, "quantity": 1, "unit": "次", "currency": "CNY",
            "budget": 2, "confirmCost": True}
        request.update(changes)
        request["estimateToken"] = self.registry.estimate("runninghub", request)["estimateToken"]
        return request

    def test_catalog_is_local_and_does_not_claim_verified_connection(self):
        catalog = self.registry.catalog()
        self.assertEqual(catalog["defaultProvider"], "runninghub")
        self.assertEqual(len(catalog["providers"]), 5)
        self.assertEqual(self.registry.health(), catalog)
        self.assertFalse(self.registry.health("runninghub")["available"])
        configured = self.configure()
        self.assertTrue(configured["available"])
        self.assertFalse(configured["verified"])
        self.assertFalse(configured["hardBudgetCap"])
        self.assertEqual(configured["config"]["workflowId"], "")
        self.assertEqual(self.transport.calls, [])

    def test_configuration_mode_redaction_preserve_and_clear(self):
        self.configure()
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o600)
        self.assertEqual(json.loads(self.path.read_text())["providers"]["runninghub"]["apiKey"], SECRET)
        for result in (self.registry.catalog(), self.registry.health("runninghub")):
            self.assertNotIn(SECRET, json.dumps(result))
        self.registry.configure("runninghub", {"apiKey": "", "unitPrice": 0.25, "unit": "秒"})
        self.assertTrue(self.registry.health("runninghub")["keyConfigured"])
        self.assertEqual(self.registry.health("runninghub")["config"]["unitPrice"], 0.25)
        self.registry.configure("runninghub", {"clearApiKey": True})
        self.assertFalse(self.registry.health("runninghub")["keyConfigured"])

    def test_existing_permissions_are_tightened(self):
        self.configure()
        self.path.chmod(0o644)
        self.registry.catalog()
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o600)

    def test_corrupt_configuration_is_not_overwritten(self):
        self.path.parent.mkdir()
        for broken in ("not json", "[]", '{"providers": []}',
                       '{"providers":{"runninghub":"bad"}}',
                       '{"providers":{"runninghub":{"apiKey":123}}}'):
            with self.subTest(broken=broken):
                self.path.write_text(broken)
                with self.assertRaises(MediaValidationError):
                    self.configure()
                self.assertEqual(self.path.read_text(), broken)

    def test_symlink_configuration_rejected_even_if_target_missing(self):
        self.path.parent.mkdir()
        self.path.symlink_to(self.path.parent / "missing")
        with self.assertRaises(MediaValidationError):
            self.configure()

    def test_unsupported_provider_only_accepts_price_and_safe_platform_link(self):
        with self.assertRaises(MediaValidationError):
            self.registry.configure("ark", {"apiKey": SECRET})
        result = self.registry.configure("libtv", {
            "platformUrl": "https://example.com/studio", "unitPrice": 2.5, "unit": "秒"})
        self.assertFalse(result["supportsApi"])
        self.assertFalse(result["available"])
        self.assertEqual(result["platformUrl"], "https://example.com/studio")
        self.assertEqual(self.registry.estimate("libtv", {"quantity": 2})["estimatedCost"], 5)
        with self.assertRaises(MediaValidationError):
            self.registry.submit("libtv", self.request())
        self.assertEqual(self.transport.calls, [])

    def test_invalid_configuration_does_not_write(self):
        for value in ({"apiKey": 123}, {"apiKey": "secret key"}, {"clearApiKey": "yes"},
                      {"platformUrl": "http://example.com"},
                      {"platformUrl": "https://user:secret@example.com"},
                      {"currency": "BAD"}, {"unitPrice": float("nan")}, {"extra": True}):
            with self.subTest(value=value):
                with self.assertRaises(MediaValidationError):
                    self.registry.configure("runninghub", value)
        self.assertFalse(self.path.exists())

    def test_missing_key_confirmation_budget_and_price_never_submit(self):
        with self.assertRaises(MediaValidationError):
            self.registry.submit("runninghub", self.request())
        self.configure()
        for changes in ({"confirmCost": False}, {"budget": None}, {"unitPrice": None}, {"budget": 1}):
            with self.subTest(changes=changes):
                with self.assertRaises(MediaValidationError):
                    self.registry.submit("runninghub", self.request(**changes))
        with self.assertRaises(MediaValidationError):
            self.registry.submit("runninghub", [])
        self.assertEqual(self.transport.calls, [])

    def test_estimate_binding_detects_execution_and_cost_changes(self):
        self.configure()
        for changed in ({"workflowId": "different"}, {"nodeInfoList": []},
                        {"unitPrice": 0.5}, {"budget": 3}, {"quantity": 0.5},
                        {"instanceType": "plus"}, {"addMetadata": True}):
            request = self.request()
            request.update(changed)
            with self.subTest(changed=changed), self.assertRaises(MediaValidationError):
                self.registry.submit("runninghub", request)
        self.assertEqual(self.transport.calls, [])

    def test_estimate_unknown_decimal_currency_and_no_hard_cap(self):
        unknown = self.registry.estimate("runninghub", {})
        self.assertFalse(unknown["known"])
        self.assertIsNone(unknown["estimatedCost"])
        self.assertIsNone(unknown["withinBudget"])
        value = self.registry.estimate("runninghub", {"unitPrice": "0.1", "quantity": 3, "budget": "0.3"})
        self.assertEqual(value["estimatedCost"], 0.3)
        self.assertTrue(value["withinBudget"])
        self.assertFalse(value["hardBudgetCap"])
        self.assertIn("用户填写", value["budgetNotice"])
        self.assertEqual(self.transport.calls, [])

    def test_invalid_node_and_billing_parameters_are_rejected(self):
        for changes in ({"quantity": 0}, {"budget": -1}, {"unitPrice": float("inf")},
                        {"nodeInfoList": {}}, {"nodeInfoList": [{"nodeId": "1"}]},
                        {"nodeInfoList": [{"nodeId": "1", "fieldName": "x", "fieldValue": float("nan")}]},
                        {"nodeInfoList": [{"nodeId": "1", "fieldName": "x", "fieldValue": 1}] * 2},
                        {"retainSeconds": 60}, {"apiKey": "body-key"},
                        {"webhookUrl": "https://example.com"}, {"instanceType": "unknown"},
                        {"addMetadata": "yes"}, {"workflowId": "https://example.com/workflow"}):
            with self.subTest(changes=changes), self.assertRaises(MediaValidationError):
                self.request(**changes)
        self.assertEqual(self.transport.calls, [])

    def test_submit_matches_official_endpoint_and_returns_real_task_id(self):
        self.configure()
        result = self.registry.submit("runninghub", self.request())
        self.assertEqual(result["task_id"], "task-123")
        self.assertEqual(result["status"], "queued")
        self.assertEqual(result["evidence"]["endpoint"], CREATE_ENDPOINT)
        self.assertEqual(len(self.transport.calls), 1)
        url, body, headers, timeout = self.transport.calls[0]
        self.assertEqual(url, RUNNINGHUB_BASE_URL + CREATE_ENDPOINT)
        self.assertEqual(body["apiKey"], SECRET)
        self.assertEqual(body["workflowId"], "123456")
        self.assertEqual(body["nodeInfoList"][0]["fieldValue"], "测试素材")
        self.assertFalse(body["addMetadata"])
        self.assertNotIn("Authorization", headers)
        self.assertNotIn("budget", body)
        self.assertEqual(timeout, 3)
        self.assertNotIn(SECRET, json.dumps(result))

    def test_submit_missing_workflow_does_not_request(self):
        self.configure()
        with self.assertRaises(MediaValidationError):
            self.registry.submit("runninghub", self.request(workflowId=""))
        self.assertEqual(self.transport.calls, [])

    def test_submit_rejection_redacts_and_does_not_retry(self):
        self.configure()
        self.transport.response = {"code": "NO_CREDIT", "msg": "Rejected " + SECRET}
        with self.assertRaises(MediaRequestError) as raised:
            self.registry.submit("runninghub", self.request())
        self.assertFalse(raised.exception.outcome_unknown)
        self.assertNotIn(SECRET, str(raised.exception))
        self.assertEqual(len(self.transport.calls), 1)

    def test_submit_unknown_responses_are_never_retried(self):
        self.configure()
        for response in ({}, {"code": 0}, {"code": 0, "data": {"taskId": "bad/id"}}, []):
            self.transport.response = response
            before = len(self.transport.calls)
            with self.subTest(response=response), self.assertRaises(MediaRequestError) as raised:
                self.registry.submit("runninghub", self.request())
            self.assertTrue(raised.exception.outcome_unknown)
            self.assertEqual(len(self.transport.calls), before + 1)

    def test_submit_timeout_and_http_uncertainty_do_not_retry(self):
        self.configure()
        for error in (TimeoutError(SECRET), ValueError(SECRET),
                      HTTPError("https://example.com/" + SECRET, 408, SECRET, {}, io.BytesIO()),
                      HTTPError("https://example.com/" + SECRET, 429, SECRET, {}, io.BytesIO()),
                      HTTPError("https://example.com/" + SECRET, 503, SECRET, {}, io.BytesIO())):
            self.transport.error = error
            before = len(self.transport.calls)
            with self.subTest(error=type(error)), self.assertRaises(MediaRequestError) as raised:
                self.registry.submit("runninghub", self.request())
            self.assertTrue(raised.exception.outcome_unknown)
            self.assertNotIn(SECRET, str(raised.exception))
            self.assertEqual(len(self.transport.calls), before + 1)

    def test_poll_uses_v2_bearer_and_preserves_external_output_evidence(self):
        self.configure()
        self.transport.response = {"taskId": "task-123", "status": "SUCCESS", "results": [
            {"url": "https://media.example.com/result.mp4", "outputType": "mp4"}]}
        result = self.registry.poll("runninghub", "task-123")
        self.assertEqual(result["status"], "succeeded")
        self.assertIsNone(result["actualCost"])
        self.assertEqual(result["outputs"], [{"url": "https://media.example.com/result.mp4",
                         "outputType": "mp4", "storage": "provider", "downloaded": False}])
        url, body, headers, _ = self.transport.calls[-1]
        self.assertEqual(url, RUNNINGHUB_BASE_URL + QUERY_ENDPOINT)
        self.assertEqual(body, {"taskId": "task-123"})
        self.assertEqual(headers["Authorization"], "Bearer " + SECRET)
        self.assertNotIn(SECRET, json.dumps(result))

    def test_poll_status_and_empty_success_do_not_invent_assets(self):
        self.configure()
        for raw, expected in (("RUNNING", "running"), ("FAILED", "failed"),
                              ("CANCELLED", "cancelled"), ("SUCCESS", "succeeded"),
                              ("OTHER", "unknown")):
            self.transport.response = {"taskId": "task-123", "status": raw}
            result = self.registry.poll("runninghub", "task-123")
            self.assertEqual(result["status"], expected)
            self.assertEqual(result["outputs"], [])

    def test_poll_ignores_unsafe_urls_and_redacts_errors_and_types(self):
        self.configure()
        self.transport.response = {"taskId": "task-123", "status": "SUCCESS", "results": [
            {"url": "http://example.com/a"}, {"url": "javascript:alert(1)"},
            {"url": "https://user:password@example.com/a"},
            {"url": "https://example.com/" + SECRET}, {"url": "https://localhost/a"},
            "not-an-object", {"url": "https://example.com/a", "outputType": SECRET}],
            "errorCode": SECRET, "errorMessage": "Error " + SECRET}
        result = self.registry.poll("runninghub", "task-123")
        self.assertEqual(result["ignoredOutputs"], 6)
        self.assertEqual(len(result["outputs"]), 1)
        self.assertNotIn(SECRET, json.dumps(result))

    def test_poll_mismatched_task_and_malformed_results_rejected(self):
        self.configure()
        for response in ({"taskId": "other", "status": "SUCCESS"},
                         {"taskId": "task-123", "status": "SUCCESS", "results": "malformed"}):
            self.transport.response = response
            with self.assertRaises(MediaRequestError):
                self.registry.poll("runninghub", "task-123")

    def test_poll_errors_are_not_submission_uncertainty(self):
        self.configure()
        self.transport.error = TimeoutError("failed")
        with self.assertRaises(MediaRequestError) as raised:
            self.registry.poll("runninghub", "task-123")
        self.assertFalse(raised.exception.outcome_unknown)
        self.assertEqual(raised.exception.code, "QUERY_FAILED")

    def test_redirect_handler_never_forwards_credentials(self):
        request = Request("https://www.runninghub.cn/", data=b"secret", headers={"Authorization": SECRET})
        self.assertIsNone(_NoRedirect().redirect_request(request, None, 302, "Found", {}, "https://other.example/"))

    def test_default_transport_rejects_non_object_json(self):
        class FakeResponse:
            def __enter__(self): return self
            def __exit__(self, *args): return False
            def read(self, limit): return b"[]"
        with patch("server.media.build_opener") as opener:
            opener.return_value.open.return_value = FakeResponse()
            with self.assertRaises(ValueError):
                _default_transport("https://www.runninghub.cn/", {}, {}, 1)


if __name__ == "__main__":
    unittest.main()

"""Read-only RunningHub contracts. All credentials and responses are fake."""

from copy import deepcopy
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from urllib.error import HTTPError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from server.media import (
    ACCOUNT_ENDPOINT, CREATE_ENDPOINT, WORKFLOW_ENDPOINT, RUNNINGHUB_BASE_URL,
    MAX_WORKFLOW_FIELDS, MAX_WORKFLOW_NODES,
    MediaRegistry, MediaRequestError, MediaValidationError, normalize_workflow_id,
)


SECRET = "fake-discovery-secret-never-a-real-key"
OTHER_SECRET = "fake-replacement-secret-never-a-real-key"


class DiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "connections.json"
        self.calls = []
        self.response = {"code": 0, "data": {"remainCoins": "123.45", "currentTaskCounts": 0,
                                              "remainMoney": "9.87", "currency": "CNY", "apiType": 0}}
        self.side_effect = None
        self.registry = MediaRegistry(self.path, self.transport)
        self.registry.configure("runninghub", {"apiKey": SECRET})

    def tearDown(self):
        self.temp.cleanup()

    def transport(self, url, payload, headers, timeout):
        self.calls.append((url, deepcopy(payload), deepcopy(headers)))
        if self.side_effect:
            self.side_effect()
        return deepcopy(self.response)

    def graph(self, nodes=None):
        self.response = {"code": 0, "data": {"prompt": json.dumps(nodes or {
            "6": {"class_type": "CLIPTextEncode", "_meta": {"title": "画面提示词"},
                  "inputs": {"text": "A calm ocean", "clip": ["4", 1]}},
            "3": {"class_type": "KSampler", "inputs": {"seed": 42, "cfg": 7.5,
                                                           "enabled": True, "null": None,
                                                           "metadata": {"nested": "ignored"}}},
        })}}

    def test_verify_uses_account_only_and_exact_official_auth(self):
        result = self.registry.verify("runninghub")
        self.assertEqual(set(result), {"verified", "checkedAt", "scope"})
        self.assertTrue(result["verified"])
        self.assertEqual(result["scope"], "account")
        self.assertEqual(self.calls, [(RUNNINGHUB_BASE_URL + ACCOUNT_ENDPOINT, {"apikey": SECRET},
                                      {"Content-Type": "application/json", "Accept": "application/json",
                                       "Authorization": "Bearer " + SECRET})])
        health = self.registry.health("runninghub")
        self.assertTrue(health["verified"])
        self.assertEqual(health["verification"], result)
        for value in (result, health):
            encoded = json.dumps(value)
            self.assertNotIn(SECRET, encoded)
            self.assertNotIn("123.45", encoded)
            self.assertNotIn("remainMoney", encoded)
        self.assertNotIn("verification", self.path.read_text())

    def test_verification_is_process_local_and_key_bound(self):
        self.registry.verify("runninghub")
        self.registry.configure("runninghub", {"unitPrice": 1, "apiKey": ""})
        self.assertTrue(self.registry.health("runninghub")["verified"])
        restarted = MediaRegistry(self.path, self.transport)
        self.assertFalse(restarted.health("runninghub")["verified"])
        self.registry.configure("runninghub", {"apiKey": OTHER_SECRET})
        self.assertEqual(self.registry.health("runninghub")["verification"],
                         {"verified": False, "checkedAt": None, "scope": None})
        self.registry.configure("runninghub", {"apiKey": SECRET})
        self.assertFalse(self.registry.health("runninghub")["verified"])
        self.registry.verify("runninghub")
        self.registry.configure("runninghub", {"clearApiKey": True})
        self.assertFalse(self.registry.health("runninghub")["verified"])

    def test_failed_reverification_clears_old_success_without_exposing_response(self):
        self.registry.verify("runninghub")
        self.response = {"code": 401, "msg": SECRET, "data": {"remainCoins": 12345}}
        with self.assertRaises(MediaRequestError) as error:
            self.registry.verify("runninghub")
        self.assertEqual(error.exception.code, "ACCOUNT_REJECTED")
        self.assertNotIn(SECRET, str(error.exception))
        self.assertFalse(error.exception.outcome_unknown)
        self.assertFalse(self.registry.health("runninghub")["verified"])

    def test_old_success_cannot_restore_verification_after_key_changes(self):
        def replace_twice():
            self.registry.configure("runninghub", {"apiKey": OTHER_SECRET})
            self.registry.configure("runninghub", {"apiKey": SECRET})
        self.side_effect = replace_twice
        with self.assertRaises(MediaRequestError) as error:
            self.registry.verify("runninghub")
        self.assertEqual(error.exception.code, "CONNECTION_CHANGED")
        self.assertFalse(self.registry.health("runninghub")["verified"])

    def test_superseded_verify_does_not_overwrite_newer_result(self):
        def newer_check():
            self.side_effect = None
            self.registry.verify("runninghub")
        self.side_effect = newer_check
        with self.assertRaises(MediaRequestError) as error:
            self.registry.verify("runninghub")
        self.assertEqual(error.exception.code, "VERIFICATION_SUPERSEDED")
        self.assertTrue(self.registry.health("runninghub")["verified"])

    def test_invalid_account_responses_never_verify(self):
        for response in ({}, [], {"code": False, "data": {"apiType": 0}},
                         {"code": "0", "data": {"apiType": 0}}, {"code": 0},
                         {"code": 0, "data": []}, {"code": 0, "data": {}},
                         {"code": SECRET, "msg": SECRET}):
            with self.subTest(response=response):
                self.response = response
                with self.assertRaises(MediaRequestError) as error:
                    self.registry.verify("runninghub")
                self.assertNotIn(SECRET, str(error.exception))
                self.assertNotIn(SECRET, error.exception.code)
                self.assertFalse(self.registry.health("runninghub")["verified"])

    def test_readonly_transport_errors_are_safe_and_never_create(self):
        for error in (TimeoutError(SECRET), ValueError(SECRET),
                      HTTPError("https://example.com/" + SECRET, 403, SECRET, {}, io.BytesIO())):
            def fail():
                raise error
            self.side_effect = fail
            with self.assertRaises(MediaRequestError) as raised:
                self.registry.verify("runninghub")
            self.assertNotIn(SECRET, str(raised.exception))
            self.assertFalse(raised.exception.outcome_unknown)
        self.assertTrue(all(CREATE_ENDPOINT not in call[0] for call in self.calls))

    def test_missing_key_and_unsupported_provider_never_request(self):
        self.registry.configure("runninghub", {"clearApiKey": True})
        for provider in ("runninghub", "ark", "invalid"):
            with self.assertRaises(MediaValidationError):
                self.registry.verify(provider)
            with self.assertRaises(MediaValidationError):
                self.registry.workflow(provider, "1234")
        self.assertEqual(self.calls, [])

    def test_workflow_reads_scalars_only_with_exact_auth(self):
        self.graph()
        result = self.registry.workflow("runninghub", "https://www.runninghub.cn/workflow/1234?from=share")
        self.assertEqual(result["workflowId"], "1234")
        self.assertEqual(result["nodeCount"], 2)
        self.assertEqual(result["nodeInfoList"], [
            {"nodeId": "6", "fieldName": "text", "fieldValue": "A calm ocean"},
            {"nodeId": "3", "fieldName": "seed", "fieldValue": 42},
            {"nodeId": "3", "fieldName": "cfg", "fieldValue": 7.5},
            {"nodeId": "3", "fieldName": "enabled", "fieldValue": True}])
        self.assertEqual([field["valueType"] for field in result["fields"]],
                         ["string", "number", "number", "boolean"])
        self.assertEqual(result["fields"][0]["nodeTitle"], "画面提示词")
        self.assertEqual(self.calls[0][0], RUNNINGHUB_BASE_URL + WORKFLOW_ENDPOINT)
        self.assertEqual(self.calls[0][1], {"apiKey": SECRET, "workflowId": "1234"})
        self.assertEqual(self.calls[0][2]["Authorization"], "Bearer " + SECRET)
        self.assertFalse(self.registry.health("runninghub")["verified"])
        self.assertNotIn(SECRET, json.dumps(result))

    def test_credential_fields_and_values_never_reach_browser(self):
        secret_inputs = {name: "not-for-display" for name in (
            "api_key", "apiKey", "API-KEY", "access_token", "password", "secret", "Authorization",
            "client_secret", "密钥", "cookie", "privateKey", "key")}
        secret_inputs.update({"hidden": SECRET, "another": "sk-abcdefgh1234567890abcdefgh",
                              "bearer": "Bearer not-for-display", "jwt": "eyJhbGci.abcdef.signature",
                              "url": "https://example.com/?apiKey=not-for-display",
                              "opaque": "0123456789abcdef0123456789abcdef", "text": "visible prompt"})
        self.graph({"6": {"class_type": "Text", "_meta": {"title": SECRET}, "inputs": secret_inputs},
                    SECRET: {"class_type": "Text", "inputs": {"text": "hidden node"}}})
        result = self.registry.workflow("runninghub", "1234")
        self.assertEqual(result["nodeInfoList"], [{"nodeId": "6", "fieldName": "text", "fieldValue": "visible prompt"}])
        self.assertEqual(result["fields"][0]["nodeTitle"], "Text")
        for secret in (SECRET, "not-for-display", "sk-abcdefgh", "hidden node"):
            self.assertNotIn(secret, json.dumps(result))

    def test_integer_seed_precision_survives_javascript_boundary(self):
        values = [9007199254740991, -9007199254740991, 9007199254740992,
                  -9007199254740992, 18446744073709551615]
        self.graph({str(index): {"class_type": "KSampler", "inputs": {"seed": value}}
                    for index, value in enumerate(values)})
        result = self.registry.workflow("runninghub", "1234")
        expected = values[:2] + [str(value) for value in values[2:]]
        self.assertEqual([field["fieldValue"] for field in result["fields"]], expected)
        self.assertEqual([field["valueType"] for field in result["fields"]],
                         ["number", "number", "string", "string", "string"])
        self.assertEqual([field["fieldValue"] for field in result["nodeInfoList"]], expected)

    def test_workflow_limits_and_malformed_graphs_fail_safely(self):
        invalid_prompts = [None, {}, "not json", "[]", "{}", '{"1":[]}',
                           '{"1":{"class_type":"Text","inputs":[]}}',
                           '{"1":{"inputs":{}}}',
                           '{"1":{"class_type":"Text","inputs":{"x":NaN}}}']
        for prompt in invalid_prompts:
            self.response = {"code": 0, "data": {"prompt": prompt}}
            with self.subTest(prompt=prompt), self.assertRaises(MediaRequestError) as error:
                self.registry.workflow("runninghub", "1234")
            self.assertEqual(error.exception.code, "INVALID_WORKFLOW")
        for graph in ({str(n): {"class_type": "Text", "inputs": {}} for n in range(MAX_WORKFLOW_NODES + 1)},
                      {"1": {"class_type": "Text", "inputs": {f"x{n}": n for n in range(MAX_WORKFLOW_FIELDS + 1)}}},
                      {"1": {"class_type": "Text", "inputs": {"text": "large text " * 50000}}}):
            self.graph(graph)
            with self.assertRaises(MediaRequestError) as error:
                self.registry.workflow("runninghub", "1234")
            self.assertEqual(error.exception.code, "INVALID_WORKFLOW")

    def test_workflow_rejection_does_not_leak_raw_code_or_message(self):
        self.response = {"code": 1001, "msg": SECRET, "data": {"prompt": SECRET}}
        with self.assertRaises(MediaRequestError) as error:
            self.registry.workflow("runninghub", "1234")
        self.assertEqual(error.exception.code, "WORKFLOW_REJECTED")
        self.assertNotIn(SECRET, str(error.exception))

    def test_workflow_in_flight_key_change_rejected(self):
        self.graph()
        self.side_effect = lambda: self.registry.configure("runninghub", {"apiKey": OTHER_SECRET})
        with self.assertRaises(MediaRequestError) as error:
            self.registry.workflow("runninghub", "1234")
        self.assertEqual(error.exception.code, "CONNECTION_CHANGED")

    def test_normalization_accepts_only_official_workflow_targets(self):
        for value in ("1234", " my-workflow_1 ", "https://www.runninghub.cn/workflow/1234",
                      "https://runninghub.cn/workflow-detail/1234/?from=share",
                      "https://www.runninghub.cn/?workflowId=1234",
                      "https://www.runninghub.cn/workflow-detail?workflowId=1234"):
            with self.subTest(value=value):
                self.assertEqual(normalize_workflow_id(value), "my-workflow_1" if "my-workflow" in value else "1234")
        invalid = (None, 1234, "", "x" * 101, "https://evil.example/workflow/1234",
                   "https://runninghub.cn.evil.example/workflow/1234", "http://runninghub.cn/workflow/1234",
                   "https://user:pass@runninghub.cn/workflow/1234", "https://runninghub.cn:8443/workflow/1234",
                   "https://runninghub.cn/workflow/1234?workflowId=other",
                   "https://runninghub.cn/?workflowId=1234&workflowId=4567",
                   "https://runninghub.cn/?workflowId=", "https://runninghub.cn/ai-app/1234?workflowId=1234",
                   "https://runninghub.cn/api/openapi/getJsonApiFormat?workflowId=1234",
                   "https://runninghub.cn/workflow/%31%32", "https://runninghub.cn/workflow/1234#invalid")
        for value in invalid:
            with self.subTest(value=value), self.assertRaises(MediaValidationError):
                self.registry.workflow("runninghub", value)
        self.assertEqual(self.calls, [])

    def test_config_and_execution_share_workflow_normalization(self):
        result = self.registry.configure("runninghub", {"workflowId": "https://runninghub.cn/workflow/1234"})
        self.assertEqual(result["config"]["workflowId"], "1234")
        one = self.registry.estimate("runninghub", {"workflowId": "1234"})
        two = self.registry.estimate("runninghub", {"workflowId": "https://runninghub.cn/workflow/1234"})
        self.assertEqual(one["estimateToken"], two["estimateToken"])
        self.assertEqual(self.calls, [])


if __name__ == "__main__":
    unittest.main()

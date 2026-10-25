"""Offline model API contracts. All keys, quotes and task responses are fake."""

from copy import deepcopy
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from server.media import MediaRegistry, MediaRequestError, MediaValidationError, MODEL_QUOTE_TTL_SECONDS
from server.media import MAX_TEXT_OUTPUTS, MAX_TEXT_OUTPUT_CHARS, MAX_TOTAL_TEXT_OUTPUT_CHARS
from server.media_models import DEFAULT_CN_IMAGE_MODEL, DEFAULT_CN_IMAGE_EDIT_MODEL, model_catalog, model_spec, normalize_parameters


IMAGE = "seedream-v4.7/text-to-image"
IMAGE_EDIT = "rhart-image-g-2-official/image-to-image"
VIDEO = "bytedance/seedance-2.5-token/text-to-video"
VIDEO_EDIT = "bytedance/seedance-2.5-token/image-to-video"
MODEL_KEY = "fake-shared-model-key"
WORKFLOW_KEY = "fake-personal-workflow-key"


class ModelTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.calls = []
        self.price = {"estimatedPrice": 0.5, "currency": "CNY", "isFreeThisCall": False,
                      "errorCode": "", "errorMessage": ""}
        self.result = {"taskId": "model-task-1", "status": "QUEUED", "results": []}
        self.side_effect = None
        self.registry = MediaRegistry(Path(self.temp.name) / "connections.json", self.transport)
        self.registry.configure("runninghub", {"apiKey": WORKFLOW_KEY, "modelApiKey": MODEL_KEY})

    def transport(self, url, payload, headers, timeout):
        self.calls.append((url, deepcopy(payload), deepcopy(headers)))
        if self.side_effect:
            self.side_effect()
        return deepcopy(self.price if "/price-preview/" in url else self.result)

    def request(self, **changes):
        request = {"mode": "model_api", "modelId": IMAGE, "parameters": {"prompt": "一只原创纸船"}, "quantity": 1, "budget": 2}
        request.update(changes)
        return request

    def quoted_request(self, **changes):
        request = self.request(**changes)
        request["estimateToken"] = self.registry.estimate("runninghub", request)["estimateToken"]
        request["confirmCost"] = True
        return request

    def test_catalog_and_configuration_separate_keys_and_never_expose_them(self):
        provider = self.registry.health("runninghub")
        self.assertTrue(provider["keyConfigured"])
        self.assertTrue(provider["modelConnection"]["keyConfigured"])
        self.assertFalse(provider["modelConnection"]["verified"])
        self.assertEqual(len(provider["models"]), 311)
        self.assertEqual(self.registry.models()["models"], provider["models"])
        self.assertEqual(self.calls, [])
        for key in (MODEL_KEY, WORKFLOW_KEY):
            self.assertNotIn(key, json.dumps(provider))
        self.registry.configure("runninghub", {"clearModelApiKey": True})
        self.assertTrue(self.registry.health("runninghub")["keyConfigured"])
        self.assertFalse(self.registry.health("runninghub")["modelConnection"]["keyConfigured"])
        with self.assertRaises(MediaValidationError):
            self.registry.estimate("runninghub", self.request())

    def test_official_price_uses_model_bearer_and_default_parameters(self):
        result = self.registry.estimate("runninghub", self.request())
        url, payload, headers = self.calls[0]
        self.assertEqual(url, "https://www.runninghub.cn/openapi/v2/price-preview/" + IMAGE)
        self.assertEqual(payload, {"prompt": "一只原创纸船", "width": 2048, "height": 2048,
                                   "sequentialImageGeneration": "disabled", "maxImages": 1})
        self.assertEqual(headers["Authorization"], "Bearer " + MODEL_KEY)
        self.assertNotIn("apiKey", payload)
        self.assertEqual(result["pricingSource"], "runninghub_price_preview")
        self.assertEqual(result["estimatedCost"], 0.5)
        self.assertTrue(result["withinBudget"])
        self.assertIn("expiresAt", result)

    def test_model_verification_only_calls_price_preview_and_is_independent(self):
        result = self.registry.verify("runninghub", mode="model_api")
        self.assertEqual(result["scope"], "price_preview")
        self.assertTrue(result["verified"])
        self.assertEqual(len(self.calls), 1)
        self.assertIn("/price-preview/", self.calls[0][0])
        self.assertTrue(self.calls[0][0].endswith("/" + DEFAULT_CN_IMAGE_MODEL))
        self.assertEqual(self.calls[0][1]["width"], 2048)
        self.assertEqual(self.calls[0][1]["outputFormat"], "png")
        self.assertNotIn("resolution", self.calls[0][1])
        self.assertTrue(self.registry.health("runninghub")["modelConnection"]["verified"])
        self.assertFalse(self.registry.health("runninghub")["verified"])
        self.registry.configure("runninghub", {"apiKey": "another-personal-key"})
        self.assertTrue(self.registry.health("runninghub")["modelConnection"]["verified"])
        self.registry.configure("runninghub", {"modelApiKey": "another-shared-key"})
        self.assertFalse(self.registry.health("runninghub")["modelConnection"]["verified"])

    def test_cn_retired_g2_is_visible_but_cannot_quote_or_submit_and_siblings_are_not_inferred(self):
        retired_id = "rhart-image-g-2-official/text-to-image"
        retired = next(item for item in self.registry.models()["models"] if item["id"] == retired_id)
        self.assertFalse(retired["available"])
        self.assertTrue(retired["disabled"])
        self.assertIn("40310", retired["disabledReason"])
        self.assertIn("中国站", retired["disabledReason"])
        self.assertEqual(retired["availabilityScope"], "runninghub.cn")
        self.assertTrue(model_spec(IMAGE_EDIT)["available"])
        for submit in (False, True):
            request = self.request(modelId=retired_id, confirmCost=True, estimateToken="old-g2-quote" if submit else None)
            with self.subTest(submit=submit), self.assertRaisesRegex(MediaValidationError, "40310"):
                (self.registry.submit if submit else self.registry.estimate)("runninghub", request)
        self.assertEqual(self.calls, [])

    def test_seedream_framing_parameters_and_reference_images_keep_explicit_values(self):
        params = {"prompt": "一位少女站在校园走廊", "width": 1152, "height": 2048,
                  "sequentialImageGeneration": "disabled", "maxImages": 1}
        result = normalize_parameters(model_spec(IMAGE), params)
        self.assertEqual(result, params)
        self.assertNotIn("resolution", result)
        edit = normalize_parameters(model_spec("seedream-v4.7/image-to-image"),
                                    {**params, "imageUrls": ["https://cdn.example.com/character.png"]})
        self.assertEqual(edit["imageUrls"], ["https://cdn.example.com/character.png"])
        self.assertNotIn("resolution", edit)
        with self.assertRaises(ValueError):
            normalize_parameters(model_spec(IMAGE), {**params, "width": 1153})

    def test_quality_first_defaults_use_seedream_pro_with_explicit_project_dimensions(self):
        self.assertEqual(DEFAULT_CN_IMAGE_MODEL, "seedream-v5-pro/text-to-image")
        self.assertEqual(DEFAULT_CN_IMAGE_EDIT_MODEL, "seedream-v5-pro/image-to-image")
        params = {"prompt": "校园走廊中的少女，精细二维漫画，保持人物面部和服装特征。",
                  "width": 1152, "height": 2048, "outputFormat": "png"}
        generation = normalize_parameters(model_spec(DEFAULT_CN_IMAGE_MODEL), params)
        self.assertEqual(generation, params)
        references = [f"https://cdn.example.com/reference-{i}.png" for i in range(10)]
        editing = normalize_parameters(model_spec(DEFAULT_CN_IMAGE_EDIT_MODEL), {**params, "imageUrls": references})
        self.assertNotIn("resolution", editing)
        self.assertEqual(editing["width"], 1152)
        self.assertEqual(editing["height"], 2048)
        self.assertEqual(editing["imageUrls"], references)
        with self.assertRaises(ValueError):
            normalize_parameters(model_spec(DEFAULT_CN_IMAGE_EDIT_MODEL), {**params, "imageUrls": references + references[:1]})
        with self.assertRaises(ValueError):
            normalize_parameters(model_spec(DEFAULT_CN_IMAGE_MODEL), {**params, "resolution": "8k"})
        quote = self.registry.estimate("runninghub", self.request(modelId=DEFAULT_CN_IMAGE_MODEL, parameters=params))
        self.assertEqual(quote["modelId"], DEFAULT_CN_IMAGE_MODEL)
        self.assertEqual(len(self.calls), 1)
        self.assertIn("/price-preview/", self.calls[0][0])

    def test_ultra_cn_retirement_does_not_infer_edit_operation_status(self):
        retired = model_spec("rhart-image-n-pro-official/text-to-image-ultra")
        self.assertFalse(retired["available"])
        self.assertIn("40310", retired["disabledReason"])
        self.assertTrue(model_spec("rhart-image-n-pro-official/edit-ultra")["available"])
        for method in (self.registry.estimate, self.registry.submit):
            with self.assertRaises(MediaValidationError):
                method("runninghub", self.request(modelId=retired["id"], confirmCost=True, estimateToken="old-ultra-quote"))
        self.assertEqual(self.calls, [])

    def test_verification_race_does_not_verify_replaced_key(self):
        self.side_effect = lambda: self.registry.configure("runninghub", {"modelApiKey": "replacement-key"})
        with self.assertRaises(MediaRequestError):
            self.registry.verify("runninghub", mode="model_api")
        self.assertFalse(self.registry.health("runninghub")["modelConnection"]["verified"])

    def test_submit_reuses_quote_without_second_network_estimate(self):
        request = self.quoted_request()
        self.price["estimatedPrice"] = 100
        result = self.registry.submit("runninghub", request)
        self.assertEqual(len(self.calls), 2)
        self.assertEqual(self.calls[1][0], "https://www.runninghub.cn/openapi/v2/" + IMAGE)
        self.assertEqual(self.calls[1][1], self.calls[0][1])
        self.assertEqual(result["estimate"]["estimatedCost"], 0.5)
        self.assertEqual(result["task_id"], "model-task-1")
        self.assertEqual(result["mode"], "model_api")
        self.assertEqual(result["mediaKind"], "image")
        self.assertEqual(result["parameters"]["width"], 2048)

    def test_canvas_total_binding_uses_cached_price_and_retains_expiry(self):
        request = self.request(budget=None)
        original = self.registry.estimate("runninghub", request)
        request["estimateToken"] = original["estimateToken"]
        bound = self.registry.bind_model_quote_budget("runninghub", request, 1.0)
        self.assertEqual(bound["budget"], 1.0)
        self.assertEqual(bound["expiresAt"], original["expiresAt"])
        self.assertEqual(bound["estimatedCost"], original["estimatedCost"])
        self.assertEqual(len(self.calls), 1)
        with self.assertRaises(MediaValidationError):
            self.registry.estimate("runninghub", request)
        bounded = {**request, "budget": 1.0}
        self.assertEqual(self.registry.estimate("runninghub", bounded), bound)
        with self.assertRaises(MediaValidationError):
            self.registry.submit("runninghub", bounded)
        self.assertEqual(len(self.calls), 1)
        result = self.registry.submit("runninghub", {**bounded, "confirmCost": True})
        self.assertEqual(result["task_id"], "model-task-1")
        self.assertEqual(len(self.calls), 2)

    def test_canvas_total_binding_rejects_changed_inputs_low_caps_and_expired_quotes(self):
        request = self.request(budget=None)
        with patch("server.media.time.monotonic", return_value=100):
            request["estimateToken"] = self.registry.estimate("runninghub", request)["estimateToken"]
            for altered, cap in (({**request, "parameters": {"prompt": "changed"}}, 1), (request, .1),
                                 ({**request, "budget": 2}, 2)):
                with self.subTest(altered=altered, cap=cap), self.assertRaises(MediaValidationError):
                    self.registry.bind_model_quote_budget("runninghub", altered, cap)
        with patch("server.media.time.monotonic", return_value=101 + MODEL_QUOTE_TTL_SECONDS):
            with self.assertRaises(MediaValidationError):
                self.registry.bind_model_quote_budget("runninghub", request, 1)
        self.assertEqual(len(self.calls), 1)

    def test_official_free_quote_can_bind_a_zero_total_but_still_requires_confirmation(self):
        self.price.update(estimatedPrice=0, isFreeThisCall=True)
        request = self.request(budget=None)
        request["estimateToken"] = self.registry.estimate("runninghub", request)["estimateToken"]
        bound = self.registry.bind_model_quote_budget("runninghub", request, 0)
        self.assertEqual(bound["budget"], 0)
        self.assertTrue(bound["withinBudget"])
        result = self.registry.submit("runninghub", {**request, "budget": 0.0, "confirmCost": True})
        self.assertEqual(result["task_id"], "model-task-1")
        self.assertEqual(len(self.calls), 2)

    def test_parameter_budget_model_or_key_changes_invalidate_quote(self):
        for changes in ({"parameters": {"prompt": "different"}}, {"budget": 3}, {"modelId": VIDEO}, {"currency": "USD"}):
            with self.subTest(changes=changes):
                request = self.quoted_request()
                count = len(self.calls)
                with self.assertRaises(MediaValidationError):
                    self.registry.submit("runninghub", {**request, **changes})
                self.assertEqual(len(self.calls), count)
        request = self.quoted_request()
        self.registry.configure("runninghub", {"modelApiKey": "changed-model-key"})
        count = len(self.calls)
        with self.assertRaises(MediaValidationError):
            self.registry.submit("runninghub", request)
        self.assertEqual(len(self.calls), count)

    def test_expired_quote_cannot_submit_or_silently_refresh(self):
        with patch("server.media.time.monotonic", return_value=100):
            request = self.quoted_request()
        with patch("server.media.time.monotonic", return_value=101 + MODEL_QUOTE_TTL_SECONDS):
            with self.assertRaises(MediaValidationError):
                self.registry.submit("runninghub", request)
        self.assertEqual(len(self.calls), 1)

    def test_contract_or_endpoint_changes_invalidate_quote_without_submission(self):
        for change in ({"contractHash": "new-contract"}, {"endpoint": "/openapi/v2/revised/task"},
                       {"priceEndpoint": "/openapi/v2/price-preview/revised/task"}):
            with self.subTest(change=change):
                request = self.quoted_request()
                changed = model_spec(IMAGE)
                changed.update(change)
                count = len(self.calls)
                with patch("server.media.model_spec", return_value=changed):
                    with self.assertRaises(MediaValidationError):
                        self.registry.submit("runninghub", request)
                self.assertEqual(len(self.calls), count)

    def test_new_model_preserves_numeric_parameters_through_quote_and_submission(self):
        request = self.quoted_request(modelId="topazlabs/image-gigapixel-art-and-cgi", parameters={
            "imageUrl": "https://cdn.example.com/input.png", "outputWidth": 2048,
            "outputHeight": 1024, "deblurStrength": 0.3})
        result = self.registry.submit("runninghub", request)
        self.assertEqual(len(self.calls), 2)
        self.assertEqual(self.calls[0][1], self.calls[1][1])
        self.assertIs(type(result["parameters"]["outputWidth"]), int)
        self.assertEqual(result["parameters"]["deblurStrength"], 0.3)

    def test_disabled_model_cannot_quote_or_submit(self):
        request = self.request(modelId="rhart-image-g-1.5/text-to-image-[Deprecated]")
        with self.assertRaises(MediaValidationError):
            self.registry.estimate("runninghub", request)
        with self.assertRaises(MediaValidationError):
            self.registry.submit("runninghub", {**request, "confirmCost": True})
        self.assertEqual(self.calls, [])

    def test_budget_and_confirmation_gates_do_not_submit(self):
        for changes in ({"budget": None}, {"budget": 0.1}):
            with self.subTest(changes=changes):
                request = self.quoted_request(**changes)
                count = len(self.calls)
                with self.assertRaises(MediaValidationError):
                    self.registry.submit("runninghub", request)
                self.assertEqual(len(self.calls), count)
        for request in (self.request(), {**self.request(), "confirmCost": True}):
            count = len(self.calls)
            with self.assertRaises(MediaValidationError):
                self.registry.submit("runninghub", request)
            self.assertEqual(len(self.calls), count)

    def test_bad_quote_is_never_treated_as_free(self):
        for price in ({}, {**self.price, "estimatedPrice": None}, {**self.price, "estimatedPrice": float("nan")},
                      {**self.price, "estimatedPrice": 0}, {**self.price, "currency": "UNKNOWN"},
                      {**self.price, "currency": []}, {**self.price, "isFreeThisCall": None},
                      {**self.price, "errorCode": "unauthorized", "errorMessage": MODEL_KEY}):
            with self.subTest(price=price):
                self.price = price
                with self.assertRaises(MediaRequestError) as error:
                    self.registry.estimate("runninghub", self.request())
                self.assertNotIn(MODEL_KEY, str(error.exception))
        self.price = {"estimatedPrice": 0, "currency": "CNY", "isFreeThisCall": True}
        self.assertEqual(self.registry.estimate("runninghub", self.request())["estimatedCost"], 0)

    def test_input_allowlist_rejects_invalid_or_injected_parameters_without_network(self):
        for change in ({"modelId": "https://example.com/task"}, {"parameters": {"prompt": "ok", "webhookUrl": "https://example.com"}},
                       {"parameters": {"prompt": MODEL_KEY}}, {"parameters": {"prompt": "ok", "resolution": "8k"}},
                       {"quantity": 2}, {"endpoint": "https://example.com"}, {"apiKey": WORKFLOW_KEY},
                       {"modelId": IMAGE_EDIT}, {"modelId": VIDEO_EDIT}, {"parameters": {"prompt": "   "}}):
            with self.subTest(change=change):
                with self.assertRaises(MediaValidationError):
                    self.registry.estimate("runninghub", self.request(**change))
        self.assertEqual(self.calls, [])

    def test_model_poll_uses_model_key_and_workflow_poll_keeps_personal_key(self):
        self.result = {"taskId": "model-task-1", "status": "SUCCESS", "results": [
            {"url": "https://cdn.example.com/image.png", "outputType": "png"}]}
        result = self.registry.poll("runninghub", "model-task-1", mode="model_api")
        self.assertEqual(self.calls[-1][2]["Authorization"], "Bearer " + MODEL_KEY)
        self.assertEqual(result["status"], "succeeded")
        self.assertEqual(len(result["outputs"]), 1)
        self.registry.poll("runninghub", "model-task-1")
        self.assertEqual(self.calls[-1][2]["Authorization"], "Bearer " + WORKFLOW_KEY)

    def test_poll_keeps_inert_text_and_redacts_secrets_separately_from_media(self):
        source = '{"sessionId":"123", "markup":"<script>alert(1)</script>"}'
        self.result = {"taskId": "text-task", "status": "SUCCESS", "results": [
            {"text": source, "outputType": "json"},
            {"url": "javascript:alert(1)", "text": "safe text " + MODEL_KEY, "outputType": MODEL_KEY},
            {"url": "https://cdn.example.com/image.png", "text": "caption", "outputType": "png"},
            {"text": {"unexpected": "object"}}, {"text": 42}, {"text": "   "}]}
        result = self.registry.poll("runninghub", "text-task", mode="model_api")
        self.assertEqual(len(result["outputs"]), 1)
        self.assertEqual(len(result["textOutputs"]), 3)
        self.assertEqual(result["textOutputs"][0], {"text": source, "outputType": "json", "truncated": False})
        self.assertEqual(result["textOutputs"][1]["text"], "safe text [REDACTED]")
        self.assertEqual(result["evidence"]["textOutputCount"], 3)
        self.assertEqual(result["evidence"]["outputCount"], 1)
        self.assertNotIn(MODEL_KEY, json.dumps(result))

    def test_text_outputs_enforce_item_count_and_total_length_bounds(self):
        self.result = {"taskId": "text-task", "status": "SUCCESS", "results": [
            {"text": "x" * (MAX_TEXT_OUTPUT_CHARS + 1)}] * (MAX_TEXT_OUTPUTS + 1)}
        result = self.registry.poll("runninghub", "text-task", mode="model_api")
        self.assertLessEqual(sum(len(item["text"]) for item in result["textOutputs"]), MAX_TOTAL_TEXT_OUTPUT_CHARS)
        self.assertTrue(all(item["truncated"] for item in result["textOutputs"]))
        self.assertTrue(all(len(item["text"]) <= MAX_TEXT_OUTPUT_CHARS for item in result["textOutputs"]))
        self.result["results"] = [{"text": "short"}] * (MAX_TEXT_OUTPUTS + 1)
        self.assertEqual(len(self.registry.poll("runninghub", "text-task", mode="model_api")["textOutputs"]), MAX_TEXT_OUTPUTS)

    def test_unknown_submission_has_no_retry(self):
        request = self.quoted_request()
        self.result = {}
        with self.assertRaises(MediaRequestError) as error:
            self.registry.submit("runninghub", request)
        self.assertTrue(error.exception.outcome_unknown)
        self.assertEqual(len(self.calls), 2)
        with self.assertRaises(MediaValidationError):
            self.registry.submit("runninghub", request)
        self.assertEqual(len(self.calls), 2)

    def test_model_rejection_preserves_safe_provider_diagnostic_without_retry(self):
        request = self.quoted_request()
        self.result = {"errorCode": "MODEL_UNAVAILABLE", "errorMessage":
                       "模型暂不可用 " + MODEL_KEY + " Bearer other-secret apiKey=another-secret"}
        with self.assertRaises(MediaRequestError) as caught:
            self.registry.submit("runninghub", request)
        message = str(caught.exception)
        self.assertEqual(caught.exception.code, "MODEL_REJECTED")
        self.assertFalse(caught.exception.outcome_unknown)
        self.assertIn("MODEL_UNAVAILABLE", message)
        self.assertIn("模型暂不可用", message)
        for secret in (MODEL_KEY, "other-secret", "another-secret"):
            self.assertNotIn(secret, message)
        with self.assertRaises(MediaValidationError):
            self.registry.submit("runninghub", request)
        self.assertEqual(len(self.calls), 2)

    def test_model_rejection_bounds_diagnostic_and_ignores_structured_payloads(self):
        for response in ({"errorCode": {"private": "hidden"}, "errorMessage": {"request": "hidden"}},
                         {"errorCode": "E" * 1000, "errorMessage": "x" * 10000}):
            with self.subTest(response_type=type(response["errorMessage"]).__name__):
                request = self.quoted_request()
                self.result = response
                with self.assertRaises(MediaRequestError) as caught:
                    self.registry.submit("runninghub", request)
                self.assertNotIn("hidden", str(caught.exception))
                self.assertLess(len(str(caught.exception)), 500)

    def test_quote_is_claimed_once_even_if_reported_free(self):
        self.price.update(estimatedPrice=0, isFreeThisCall=True)
        request = self.quoted_request()
        self.registry.submit("runninghub", {**request, "requestId": "first"})
        with self.assertRaises(MediaValidationError):
            self.registry.submit("runninghub", {**request, "requestId": "second"})
        self.assertEqual(len(self.calls), 2)

    def test_key_change_after_cache_read_cannot_reuse_old_quote(self):
        request = self.quoted_request()
        original = self.registry._estimate_model

        def replace_after_read(provider, body):
            result = original(provider, body)
            self.registry.configure("runninghub", {"modelApiKey": "changed-after-cache-read"})
            return result

        with patch.object(self.registry, "_estimate_model", side_effect=replace_after_read):
            with self.assertRaises(MediaValidationError):
                self.registry.submit("runninghub", request)
        self.assertEqual(len(self.calls), 1)

    def test_metadata_and_model_parameters_are_safe_copies(self):
        metadata = self.registry.job_metadata("runninghub", self.request())
        self.assertEqual(metadata["modelId"], IMAGE)
        self.assertEqual(metadata["parameters"]["width"], 2048)
        for key in (MODEL_KEY, WORKFLOW_KEY):
            self.assertNotIn(key, json.dumps(metadata))
        catalog = model_catalog()
        next(item for item in catalog if item["id"] == IMAGE)["defaults"]["width"] = 99
        self.assertEqual(model_spec(IMAGE)["defaults"]["width"], 2048)

    def test_reference_images_and_video_specific_enums(self):
        image = normalize_parameters(model_spec(IMAGE_EDIT), {"prompt": "new scene", "imageUrls": ["https://cdn.example.com/first.png"]})
        self.assertEqual(len(image["imageUrls"]), 1)
        video = normalize_parameters(model_spec(VIDEO), {"prompt": "slow zoom", "duration": "10", "ratio": "16:9"})
        self.assertEqual(video["duration"], "10")
        self.assertTrue(video["generateAudio"])
        animate = normalize_parameters(model_spec(VIDEO_EDIT), {"firstFrameUrl": "https://cdn.example.com/first.png"})
        self.assertEqual(animate["ratio"], "adaptive")
        for params in ({"firstFrameUrl": "http://example.com/img.png"}, {"firstFrameUrl": "https://localhost/img.png"},
                       {"firstFrameUrl": "https://cdn.example.com/first.png", "ratio": "16:9"}):
            with self.assertRaises(ValueError):
                normalize_parameters(model_spec(VIDEO_EDIT), params)
        for field in ("resolution", "duration"):
            for value in (None, ""):
                with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                    normalize_parameters(model_spec(VIDEO), {"prompt": "paper boat", field: value})


if __name__ == "__main__":
    unittest.main()

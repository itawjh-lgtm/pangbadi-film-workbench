"""Typed, bounded model parameters validated entirely offline."""

import unittest

from server.media_models import _prepare_schema, model_spec, normalize_parameters


class ModelSchemaTests(unittest.TestCase):
    def spec(self, properties, required=()):
        return {"id": "test/schema", "available": True, "defaults": {}, "schema": _prepare_schema({
            "type": "object", "properties": properties, "required": list(required)})}

    def test_numeric_boundaries_keep_wire_types_and_reject_booleans(self):
        spec = self.spec({"seed": {"type": "integer", "minimum": -1, "maximum": 2147483647},
                          "strength": {"type": "number", "minimum": 0, "maximum": 1, "multipleOf": 0.1}}, ["seed"])
        for seed in (-1, 0, 2147483647):
            result = normalize_parameters(spec, {"seed": seed, "strength": 0.3})
            self.assertIs(type(result["seed"]), int)
            self.assertEqual(result["strength"], 0.3)
        for bad in (True, False, 1.0, "1", -2, 2147483648, None):
            with self.subTest(seed=bad), self.assertRaises(ValueError):
                normalize_parameters(spec, {"seed": bad})
        for bad in (True, "0.3", -0.1, 1.1, 0.31, float("nan"), float("inf")):
            with self.subTest(strength=bad), self.assertRaises(ValueError):
                normalize_parameters(spec, {"seed": 0, "strength": bad})

    def test_exclusive_bounds_and_string_length(self):
        spec = self.spec({"value": {"type": "number", "exclusiveMinimum": 0, "exclusiveMaximum": 1},
                          "text": {"type": "string", "minLength": 2, "maxLength": 4, "pattern": "^[a-z]+$"}})
        normalize_parameters(spec, {"value": 0.5, "text": "test"})
        for bad in ({"value": 0}, {"value": 1}, {"text": "x"}, {"text": "123"}, {"text": "abcde"}):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                normalize_parameters(spec, bad)
        openapi = self.spec({"value": {"type": "number", "minimum": 0, "exclusiveMinimum": True}})
        with self.assertRaises(ValueError):
            normalize_parameters(openapi, {"value": 0})

    def test_nested_required_fields_and_unknown_fields(self):
        spec = self.spec({"scenes": {"type": "array", "minItems": 1, "maxItems": 2, "items": {
            "type": "object", "required": ["prompt", "duration"], "properties": {
                "prompt": {"type": "string", "minLength": 1},
                "duration": {"type": "integer", "minimum": 1, "maximum": 10}}}}}, ["scenes"])
        source = {"scenes": [{"prompt": "原创镜头", "duration": 3}]}
        normalized = normalize_parameters(spec, source)
        normalized["scenes"][0]["prompt"] = "changed"
        self.assertEqual(source["scenes"][0]["prompt"], "原创镜头")
        for bad in ({}, {"scenes": []}, {"scenes": [{"prompt": "missing duration"}]},
                    {"scenes": [{"prompt": "ok", "duration": 2, "webhookUrl": "https://example.com"}]},
                    {"scenes": [{"prompt": "ok", "duration": "2"}]},
                    {"scenes": [{"prompt": "ok", "duration": 2}] * 3},
                    {**source, "unknown": True}):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                normalize_parameters(spec, bad)

    def test_missing_null_and_empty_are_distinct(self):
        spec = self.spec({"nullable": {"type": "string", "nullable": True},
                          "union": {"type": ["string", "null"]},
                          "optional": {"type": "string"}, "empty": {"type": "string", "minLength": 0}}, ["nullable"])
        result = normalize_parameters(spec, {"nullable": None, "union": None, "empty": ""})
        self.assertIsNone(result["nullable"])
        self.assertEqual(result["empty"], "")
        self.assertNotIn("optional", result)
        for bad in ({}, {"nullable": None, "optional": None}):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                normalize_parameters(spec, bad)

    def test_enums_are_typed_and_arrays_validate_items(self):
        spec = self.spec({"slots": {"type": "array", "uniqueItems": True, "items": {
            "type": "string", "enum": ["all", "firstFrameUrl"]}},
            "count": {"type": "integer", "enum": [0, 1]}})
        normalize_parameters(spec, {"slots": ["all"], "count": 1})
        for bad in ({"slots": "all"}, {"slots": ["other"]}, {"slots": ["all", "all"]}, {"count": True}):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                normalize_parameters(spec, bad)

    def test_nested_media_links_are_https_only(self):
        spec = self.spec({"inputs": {"type": "array", "items": {"type": "object", "properties": {
            "imageUrl": {"type": "string"}}, "required": ["imageUrl"]}}})
        normalize_parameters(spec, {"inputs": [{"imageUrl": "https://cdn.example.com/a.png"}]})
        for url in ("http://example.com/a.png", "data:image/png;base64,a", "file:///tmp/a.png",
                    "https://localhost/a.png", "https://localhost./a.png", "https://127.0.0.1/a.png",
                    "https://10.0.0.1/a.png", "https://[::1]/a.png", "https://cdn.example.com:444/a.png",
                    "https://user:secret@example.com/a.png", "https://cdn.example.com/\na.png",
                    "https://cdn.example.com/a b.png", "https://cdn.example.com/\\a.png"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                normalize_parameters(spec, {"inputs": [{"imageUrl": url}]})

    def test_defaults_never_copy_sample_prompts_files_or_identifiers(self):
        schema = _prepare_schema({"type": "object", "properties": {
            "prompt": {"type": "string", "default": "official sample story"},
            "sessionId": {"type": "string", "default": "123456789"},
            "image": {"type": "string", "default": "example.png"},
            "resolution": {"type": "string", "enum": ["720p"], "default": "720p"},
            "seed": {"type": "integer", "minimum": -1, "default": -1},
            "invalid": {"type": "integer", "minimum": 5, "default": 1},
            "badUrl": {"type": "string", "format": "uri", "default": "https://example.com/sample.png"}}})
        for field in ("prompt", "sessionId", "image", "invalid", "badUrl"):
            self.assertNotIn("default", schema["properties"][field])
        self.assertEqual(schema["properties"]["resolution"]["default"], "720p")
        self.assertEqual(schema["properties"]["seed"]["default"], -1)

    def test_unsupported_schema_contracts_fail_closed(self):
        for schema in ({"$ref": "https://example.com/schema"}, {"type": "array"},
                       {"type": "object", "additionalProperties": True},
                       {"type": "object", "required": ["unknown"]},
                       {"type": "string", "format": "unrecognized"}):
            with self.subTest(schema=schema), self.assertRaises(ValueError):
                _prepare_schema(schema)

    def test_seedance_draft_constraint_and_duration_wire_string(self):
        spec = model_spec("bytedance/seedance-2.5-token/text-to-video")
        valid = normalize_parameters(spec, {"prompt": "原创纸船", "draft": True, "resolution": "480p", "duration": "5"})
        self.assertEqual(valid["duration"], "5")
        for bad in ({"prompt": "paper boat", "draft": True}, {"prompt": "paper boat", "duration": 5},
                    {"prompt": "paper boat", "seed": 2147483648}):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                normalize_parameters(spec, bad)

    def test_oversized_or_overdeep_input_is_rejected(self):
        spec = self.spec({"prompt": {"type": "string"}})
        with self.assertRaises(ValueError):
            normalize_parameters(spec, {"prompt": "x" * (512 * 1024 + 1)})
        schema = {"type": "string"}
        for _ in range(20):
            schema = {"type": "array", "items": schema}
        with self.assertRaises(ValueError):
            _prepare_schema(schema)


if __name__ == "__main__":
    unittest.main()

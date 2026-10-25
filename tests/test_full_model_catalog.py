"""Independent public-catalog coverage; no network, account files or paid jobs."""

from collections import Counter
from copy import deepcopy
from decimal import Decimal, ROUND_CEILING
import json
from pathlib import Path
import re
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from server.media import MediaRegistry, MediaValidationError
from server.media_models import model_catalog, model_spec, normalize_parameters

DOCS = ROOT / "docs/api/runninghub"
PUBLIC = json.loads((DOCS / "public-model-catalog.json").read_text())
RUNTIME = json.loads((DOCS / "runtime-model-catalog.json").read_text())
DOCUMENTS = json.loads((DOCS / "public-document-schemas.json").read_text())
RETIRED = {
    "rhart-image-g-1.5/edit-[Deprecated]",
    "rhart-image-g-1.5/text-to-image-[Deprecated]",
    "rhart-video-s/image-to-video-pro-deprecated",
    "rhart-video-s/text-to-video-pro-deprecated",
}


def sample_value(schema):
    """Generate local test input from constraints, never documentation examples."""
    if "enum" in schema:
        return deepcopy(schema["enum"][0])
    kind = schema.get("type")
    if kind == "string":
        if schema.get("format") in ("uri", "url", "https"):
            return "https://assets.example.invalid/review-fixture.png"
        size = max(1, schema.get("minLength", 1))
        return "x" * size
    if kind == "boolean":
        return False
    if kind in ("integer", "number"):
        step = Decimal(str(schema.get("multipleOf", 1)))
        minimum = Decimal(str(schema.get("minimum", 0)))
        value = (minimum / step).to_integral_value(rounding=ROUND_CEILING) * step
        return int(value) if kind == "integer" else float(value)
    if kind == "array":
        return [sample_value(schema["items"]) for _ in range(max(1, schema.get("minItems", 0)))]
    if kind == "object":
        return {name: sample_value(schema["properties"][name]) for name in schema.get("required", [])}
    raise AssertionError("Unreviewed schema type " + str(kind))


def request_parameters(spec):
    return {name: sample_value(spec["schema"]["properties"][name])
            for name in spec["schema"].get("required", []) if name not in spec["defaults"]}


def schemas(value, name="parameters"):
    if not isinstance(value, dict):
        return
    yield name, value
    for key, child in value.get("properties", {}).items():
        yield from schemas(child, key)
    if isinstance(value.get("items"), dict):
        yield from schemas(value["items"], name + "[]")


class FullCatalogTests(unittest.TestCase):
    def test_snapshot_and_runtime_cover_all_official_operations_without_brand_deduplication(self):
        self.assertEqual(PUBLIC["errors"], [])
        public = {item["id"]: item for item in PUBLIC["models"]}
        runtime = {item["id"]: item for item in RUNTIME["models"]}
        actual = {item["id"]: item for item in model_catalog()}
        self.assertEqual(len(PUBLIC["models"]), 311)
        self.assertEqual(len(public), 311)
        self.assertEqual(set(public), set(runtime))
        self.assertEqual(set(public), set(actual))
        self.assertEqual(Counter(item["mediaKind"] for item in actual.values()), {"image": 99, "video": 212})
        self.assertEqual(Counter(item["mediaKind"] for item in actual.values() if item["available"]), {"image": 95, "video": 210})
        self.assertEqual({item["id"] for item in actual.values() if not item["available"]},
                         RETIRED | {"rhart-image-g-2-official/text-to-image", "rhart-image-n-pro-official/text-to-image-ultra"})
        index = (DOCS / "llms.txt").read_text()
        official_ops = {(op["method"],op["path"]) for document in DOCUMENTS["documents"] for op in document.get("operations", [])}
        for model_id, spec in actual.items():
            with self.subTest(model_id=model_id):
                source = public[model_id]
                self.assertEqual(spec["endpoint"], source["path"])
                self.assertEqual(spec["endpoint"], "/openapi/v2/" + model_id)
                self.assertEqual(spec["priceEndpoint"], "/openapi/v2/price-preview/" + model_id)
                self.assertEqual(spec["method"], source["method"])
                self.assertIn((spec["method"],spec["endpoint"]), official_ops)
                self.assertIn(source["docUrl"], index)
                self.assertEqual(spec["sourceUrl"], source["docUrl"])
                self.assertRegex(spec["contractHash"], r"^[a-f0-9]{64}$")

    def test_every_public_field_name_required_flag_and_json_type_survives_loading(self):
        for source in PUBLIC["models"]:
            with self.subTest(model_id=source["id"]):
                spec = model_spec(source["id"])
                fields = {field["name"]:field for field in spec["fields"]}
                properties = source["schema"]["properties"]
                self.assertEqual(set(fields), set(properties))
                for name, prop in properties.items():
                    self.assertEqual(fields[name]["schema"]["type"], prop["type"], name)
                    self.assertEqual(fields[name]["required"], name in source["schema"].get("required", []), name)
                    if "enum" in prop:
                        self.assertEqual(fields[name]["schema"]["enum"],prop["enum"],name)

    def test_runtime_and_refreshed_snapshots_never_default_to_example_text_or_media(self):
        sources = [*PUBLIC["models"], *RUNTIME["models"], *model_catalog()]
        for model in sources:
            for name, schema in schemas(model["schema"]):
                with self.subTest(model_id=model["id"], field=name):
                    self.assertNotIn("example", schema)
                    self.assertNotIn("examples", schema)
                    if "default" not in schema:
                        continue
                    value = schema["default"]
                    self.assertNotRegex(json.dumps(value),r"https?://|Bearer |apiKey|Rh-Comfy-Auth")
                    if isinstance(value, str):
                        self.assertTrue("enum" in schema or name in {"size","ratio","aspectRatio"} and re.fullmatch(r"\d{1,5}[*:x]\d{1,5}",value), (name,value[:80]))
                    if isinstance(value, list):
                        self.assertTrue(not value or "enum" in schema.get("items", {}), name)
                    self.assertFalse(isinstance(value, dict), name)

    def test_catalog_returns_independent_contract_copies(self):
        first = model_catalog()
        editable = next(item for item in first if item["available"])
        model_id = editable["id"]
        editable["schema"]["properties"].clear()
        editable["available"] = False
        second = model_spec(model_id)
        self.assertTrue(second["schema"]["properties"])
        self.assertTrue(second["available"])
        with self.assertRaises(ValueError):
            model_spec("https://example.invalid/untrusted-endpoint")


class EveryModelOfflineFlowTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.no_network = patch("server.media._default_transport", side_effect=AssertionError("Unexpected real transport"))
        self.no_network.start()
        self.addCleanup(self.no_network.stop)
        self.calls = []
        self.registry = MediaRegistry(Path(self.temp.name) / "fake-connections.json", self.transport)
        self.registry.configure("runninghub", {"modelApiKey":"full-catalog-fake-key"})

    def transport(self, url, body, headers, timeout):
        self.calls.append((url,deepcopy(body),dict(headers)))
        if "/price-preview/" in url:
            return {"estimatedPrice":0.1,"currency":"CNY","isFreeThisCall":False,"errorCode":"","errorMessage":""}
        return {"taskId":"fake-catalog-task","status":"QUEUED","results":[]}

    def test_all_active_models_quote_and_submit_the_exact_documented_paths_and_types(self):
        count = 0
        for spec in model_catalog():
            if not spec["available"]:
                continue
            with self.subTest(model_id=spec["id"]):
                parameters = request_parameters(spec)
                expected = normalize_parameters(spec,parameters)
                request = {"mode":"model_api","modelId":spec["id"],"parameters":parameters,"budget":1,"quantity":1}
                start = len(self.calls)
                quote = self.registry.estimate("runninghub",request)
                request.update(estimateToken=quote["estimateToken"],confirmCost=True)
                job = self.registry.submit("runninghub",request)
                calls = self.calls[start:]
                self.assertEqual(len(calls),2)
                self.assertEqual(calls[0][0],"https://www.runninghub.cn"+spec["priceEndpoint"])
                self.assertEqual(calls[1][0],"https://www.runninghub.cn"+spec["endpoint"])
                self.assertEqual(calls[0][1],expected)
                self.assertEqual(calls[1][1],expected)
                self.assertNotIn("apiKey",calls[1][1])
                self.assertEqual(job["modelId"],spec["id"])
                self.assertEqual(job["parameters"],expected)
                for name,value in expected.items():
                    kind = spec["schema"]["properties"][name]["type"]
                    actual_type = {"string":str,"boolean":bool,"integer":int,"array":list,"object":dict}.get(kind)
                    if actual_type:
                        self.assertIs(type(value),actual_type,(spec["id"],name))
                    else:
                        self.assertIn(type(value),(int,float),(spec["id"],name))
                count += 1
        self.assertEqual(count,305)
        self.assertEqual(len(self.calls),610)

    def test_all_four_retired_endpoints_are_visible_but_rejected_before_any_transport(self):
        for model_id in RETIRED:
            with self.subTest(model_id=model_id):
                spec = model_spec(model_id)
                self.assertTrue(spec["deprecated"])
                self.assertTrue(spec["disabledReason"])
                self.assertFalse(spec["available"])
                request = {"mode":"model_api","modelId":model_id,"parameters":{},"budget":1,"confirmCost":True,"estimateToken":"fake-old-quote"}
                with self.assertRaises(MediaValidationError):
                    self.registry.estimate("runninghub",request)
                with self.assertRaises(MediaValidationError):
                    self.registry.submit("runninghub",request)
        self.assertEqual(self.calls,[])


if __name__ == "__main__":
    unittest.main()

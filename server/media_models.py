"""Allowlisted RunningHub model contracts; no user-supplied endpoint is used."""

from copy import deepcopy
from decimal import Decimal, InvalidOperation
import hashlib
import ipaddress
import json
import math
from pathlib import Path
import re
from urllib.parse import urlsplit


IMAGE_RATIOS = ["1:1", "1:2", "2:1", "1:3", "3:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "21:9", "9:21", "16:9"]

# Runtime provider evidence takes priority over the downloaded documentation.
# Only these exact operations returned 40310; do not infer the status of sibling
# operations or forward the user's credentials to a different regional host.
CN_UNAVAILABLE = {
    "rhart-image-g-2-official/text-to-image":
        "G2 官方文生图已在 RunningHub 中国站下线（40310）。请选择其他中国站可用模型；全球站需单独配置，系统不会自动跨站重试。",
    "rhart-image-n-pro-official/text-to-image-ultra":
        "Ultra 官方文生图已在 RunningHub 中国站下线（40310）。请选择其他中国站可用模型；系统不会自动跨站重试。",
}
# The previous Ultra default was rejected with CN40310 on a real task. Use
# the CN Seedream 5 Pro pair, retaining project framing via explicit sizes.
# Documentation/quotes still do not establish successful generation or quality.
DEFAULT_CN_IMAGE_MODEL = "seedream-v5-pro/text-to-image"
DEFAULT_CN_IMAGE_EDIT_MODEL = "seedream-v5-pro/image-to-image"
DEFAULT_CN_IMAGE_PARAMETERS = {"width": 2048, "height": 2048, "outputFormat": "png"}


def _field(name, label, *, default=None, options=None, required=False, kind="string", **extra):
    result = {"name": name, "label": label, "type": kind, "required": required, **extra}
    if default is not None:
        result["default"] = default
    if options is not None:
        result["options"] = options
    return result


def _model(model_id, name, media_kind, capability, fields):
    return {"id": model_id, "modelId": model_id, "name": name, "label": name,
            "mediaKind": media_kind, "capability": capability,
            "endpoint": "/openapi/v2/" + model_id,
            "defaults": {field["name"]: field["default"] for field in fields if "default" in field},
            "fields": fields}


_IMAGE_FIELDS = [
    _field("prompt", "画面提示词", required=True, maxLength=20000),
    _field("aspectRatio", "画幅比例", default="16:9", options=IMAGE_RATIOS),
    _field("resolution", "清晰度", default="2k", options=["1k", "2k", "4k"], required=True),
    _field("quality", "画质", default="medium", options=["low", "medium", "high"], required=True),
]
_VIDEO_FIELDS = [
    _field("prompt", "画面与动作提示词", required=True, maxLength=20480),
    _field("resolution", "清晰度", default="720p", options=["480p", "720p", "native1080p", "1080p", "2k", "4k"], required=True),
    _field("duration", "时长（秒，-1为自动）", default="5", options=["-1", *map(str, range(4, 31))], required=True),
    _field("ratio", "画幅比例", default="adaptive", options=["adaptive", "16:9", "4:3", "1:1", "3:4", "9:16", "21:9"]),
    _field("generateAudio", "生成声音", default=True, kind="boolean"),
]
LEGACY_MODELS = (
    _model("rhart-image-g-2-official/text-to-image", "G2 官方 · 文生图", "image", "text-to-image", deepcopy(_IMAGE_FIELDS)),
    _model("rhart-image-g-2-official/image-to-image", "G2 官方 · 图生图", "image", "image-to-image", [
        *deepcopy(_IMAGE_FIELDS), _field("imageUrls", "参考图片链接", required=True, kind="urls", maxItems=10)]),
    _model("bytedance/seedance-2.5-token/text-to-video", "Seedance 2.5 · 文生视频", "video", "text-to-video", deepcopy(_VIDEO_FIELDS)),
    _model("bytedance/seedance-2.5-token/image-to-video", "Seedance 2.5 · 图生视频", "video", "image-to-video", [
        *deepcopy(_VIDEO_FIELDS), _field("firstFrameUrl", "首帧图片链接", required=True, format="https"),
        _field("lastFrameUrl", "尾帧图片链接（可选）", format="https")]),
)
# Image-to-video derives its ratio from the first frame; the API only accepts
# adaptive here. It can animate an image without an additional text prompt.
LEGACY_MODELS[3]["fields"][0]["required"] = False
LEGACY_MODELS[3]["fields"][3]["options"] = ["adaptive"]


def _https_url(value):
    if (not isinstance(value, str) or not value or len(value) > 12000
            or re.search(r"[\x00-\x20\x7f\"'\\]", value)):
        return False
    try:
        parsed = urlsplit(value)
        host = (parsed.hostname or "").lower().rstrip(".")
        if (parsed.scheme != "https" or not host or parsed.username or parsed.password
                or parsed.port not in (None, 443) or host in ("localhost", "0.0.0.0")
                or host.endswith((".localhost", ".local"))):
            return False
        try:
            return ipaddress.ip_address(host).is_global
        except ValueError:
            return True
    except ValueError:
        return False


CATALOG_DIR = Path(__file__).resolve().parents[1] / "docs" / "api" / "runninghub"
MAX_PARAMETER_BYTES = 512 * 1024
MAX_SCHEMA_DEPTH = 16
SCHEMA_KEYS = {
    "type", "properties", "required", "additionalProperties", "items", "enum", "const",
    "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
    "minLength", "maxLength", "pattern", "format", "minItems", "maxItems", "uniqueItems",
    "minProperties", "maxProperties", "nullable", "default", "description", "title",
    "example", "examples", "deprecated", "readOnly", "writeOnly",
}
FIELD_LABELS = {
    "prompt": "画面与动作提示词", "negativePrompt": "负向提示词", "imageUrl": "参考图片链接",
    "imageUrls": "参考图片链接", "videoUrl": "参考视频链接", "videoUrls": "参考视频链接",
    "audioUrl": "参考音频链接", "audioUrls": "参考音频链接", "resolution": "清晰度",
    "aspectRatio": "画幅比例", "ratio": "画幅比例", "duration": "时长", "seed": "随机种子",
    "generateAudio": "生成声音", "outputFormat": "输出格式", "draft": "样片模式",
}


def _same_json_value(left, right):
    # Python equates True and 1; JSON Schema does not.
    if type(left) is bool or type(right) is bool:
        return type(left) is type(right) and left == right
    if isinstance(left, list) or isinstance(right, list):
        return (isinstance(left, list) and isinstance(right, list) and len(left) == len(right)
                and all(_same_json_value(a, b) for a, b in zip(left, right)))
    if isinstance(left, dict) or isinstance(right, dict):
        return (isinstance(left, dict) and isinstance(right, dict) and set(left) == set(right)
                and all(_same_json_value(left[key], right[key]) for key in left))
    return left == right


def _validate(schema, value, label, depth=0):
    """Validate a deliberately bounded JSON Schema subset without coercion."""
    if depth > MAX_SCHEMA_DEPTH:
        raise ValueError(f"{label}嵌套层级过深")
    kinds = schema.get("type")
    kinds = kinds if isinstance(kinds, list) else [kinds]
    if value is None:
        if not (schema.get("nullable") is True or "null" in kinds):
            raise ValueError(f"{label}不能为 null")
    else:
        matches = {
            "string": isinstance(value, str), "boolean": type(value) is bool,
            "integer": type(value) is int,
            "number": type(value) in (int, float) and (type(value) is int or math.isfinite(value)),
            "array": isinstance(value, list), "object": isinstance(value, dict), "null": False,
        }
        if not any(matches.get(kind, False) for kind in kinds):
            raise ValueError(f"{label}类型无效，应为 {' / '.join(str(kind) for kind in kinds)}")
    if "enum" in schema and not any(_same_json_value(value, item) for item in schema["enum"]):
        raise ValueError(f"{label}不在已支持的选项内")
    if "const" in schema and not _same_json_value(value, schema["const"]):
        raise ValueError(f"{label}须为指定值")
    if value is None:
        return
    if isinstance(value, str):
        if len(value) < schema.get("minLength", 0) or len(value) > schema.get("maxLength", MAX_PARAMETER_BYTES):
            raise ValueError(f"{label}长度超出允许范围")
        if schema.get("minLength", 0) > 0 and not value.strip():
            raise ValueError(f"请填写{label}")
        if "pattern" in schema and not re.search(schema["pattern"], value):
            raise ValueError(f"{label}格式无效")
        if schema.get("format") in ("uri", "url", "https") and not _https_url(value):
            raise ValueError(f"{label}须为公开 HTTPS 链接")
    elif type(value) in (int, float):
        number = Decimal(str(value))
        for key, invalid in (("minimum", lambda bound: number < bound),
                             ("maximum", lambda bound: number > bound),
                             ("exclusiveMinimum", lambda bound: number <= bound),
                             ("exclusiveMaximum", lambda bound: number >= bound)):
            bound = schema.get(key)
            # OpenAPI 3.0 uses boolean exclusiveMinimum/Maximum.
            if type(bound) is bool:
                base = "minimum" if key == "exclusiveMinimum" else "maximum"
                bound = schema.get(base) if bound else None
            if bound is not None and invalid(Decimal(str(bound))):
                raise ValueError(f"{label}超出允许范围")
        if "multipleOf" in schema:
            divisor = Decimal(str(schema["multipleOf"]))
            try:
                invalid_multiple = divisor <= 0 or number % divisor != 0
            except InvalidOperation:
                invalid_multiple = True
            if invalid_multiple:
                raise ValueError(f"{label}不符合允许步长")
    elif isinstance(value, list):
        if not schema.get("minItems", 0) <= len(value) <= schema.get("maxItems", 1024):
            raise ValueError(f"{label}数量超出允许范围")
        if schema.get("uniqueItems") and any(
                _same_json_value(item, previous) for i, item in enumerate(value) for previous in value[:i]):
            raise ValueError(f"{label}不能包含重复项")
        for index, item in enumerate(value):
            _validate(schema["items"], item, f"{label}[{index + 1}]", depth + 1)
    elif isinstance(value, dict):
        properties = schema.get("properties", {})
        if set(value) - set(properties):
            raise ValueError(f"{label}包含未支持的字段")
        if not schema.get("minProperties", 0) <= len(value) <= schema.get("maxProperties", 512):
            raise ValueError(f"{label}字段数量超出允许范围")
        for name in schema.get("required", []):
            if name not in value:
                raise ValueError(f"请填写{label}.{name}")
        for name, item in value.items():
            _validate(properties[name], item, f"{label}.{name}", depth + 1)


def _safe_default(schema, name):
    if "default" not in schema:
        return False
    value = schema["default"]
    try:
        _validate(schema, value, name)
    except (ValueError, TypeError):
        return False
    # Documentation defaults often contain sample prompts, asset filenames,
    # session IDs or LoRA names. Only operational settings are auto-filled.
    if value is None or type(value) in (bool, int, float):
        return True
    if isinstance(value, str):
        return "enum" in schema or (name in {"size", "aspectRatio", "ratio"}
                                     and bool(re.fullmatch(r"\d{1,5}[*:x]\d{1,5}", value)))
    if isinstance(value, list):
        return not value or "enum" in schema.get("items", {})
    return False


def _prepare_schema(source, name="parameters", depth=0):
    if not isinstance(source, dict) or depth > MAX_SCHEMA_DEPTH or set(source) - SCHEMA_KEYS:
        raise ValueError("参数 schema 包含尚未支持的约束")
    schema = deepcopy(source)
    for key in ("example", "examples"):
        schema.pop(key, None)
    kind = schema.get("type")
    kinds = kind if isinstance(kind, list) else [kind]
    if not kinds or any(item not in {"object", "array", "string", "integer", "number", "boolean", "null"} for item in kinds):
        raise ValueError("参数 schema 类型不完整")
    if "object" in kinds:
        if schema.get("additionalProperties") not in (None, False):
            raise ValueError("开放对象参数需要专门适配")
        schema["additionalProperties"] = False
        schema["properties"] = {key: _prepare_schema(value, key, depth + 1)
                                for key, value in schema.get("properties", {}).items()}
        if set(schema.get("required", [])) - set(schema["properties"]):
            raise ValueError("参数 schema 的必填字段未定义")
    if "array" in kinds:
        schema["items"] = _prepare_schema(schema.get("items"), name, depth + 1)
    if "string" in kinds:
        if schema.get("format") not in (None, "uri", "url", "https"):
            raise ValueError("参数 schema 的格式需要专门适配")
        # A media URL remains HTTPS-only even if a future document omits format.
        if name.lower().endswith(("url", "urls")):
            schema["format"] = "https"
    if "default" in schema and not _safe_default(schema, name):
        schema.pop("default")
    return schema


def _response_properties(operation):
    return operation.get("responses", {}).get("200", {}).get("content", {}).get(
        "application/json", {}).get("schema", {}).get("properties", {})


def _shared_contracts(documents):
    operations = [op for document in documents for op in document.get("operations", [])]
    query = next((op for op in operations if op.get("path") == "/openapi/v2/query"), {})
    price = next((op for op in operations if op.get("path") == "/openapi/v2/price-preview/**"), {})
    price_fields = _response_properties(price)
    valid = (query.get("method") == price.get("method") == "POST"
             and not query.get("deprecated") and not price.get("deprecated")
             and query.get("schema", {}).get("properties", {}).get("taskId", {}).get("type") == "string"
             and all(price_fields.get(name, {}).get("type") == kind for name, kind in (
                 ("estimatedPrice", "number"), ("currency", "string"), ("isFreeThisCall", "boolean")))
             and "/openapi/v2/price-preview/" in price.get("description", ""))
    return valid


def _build_model(entry, shared_supported):
    model_id, endpoint = entry["id"], entry.get("path", "")
    category_parts = entry.get("category", "").split(" > ")
    media_kind = "image" if any("图像" in part for part in category_parts[:2]) else "video"
    capability = category_parts[2] if len(category_parts) > 2 else model_id.rsplit("/", 1)[-1]
    label = entry.get("label") or model_id
    deprecated = bool(entry.get("deprecated") or "deprecated" in model_id.lower() or "已下架" in label)
    disabled_reason = "官方已下架此接口，请选择其他模型" if deprecated else ""
    disabled_reason = CN_UNAVAILABLE.get(model_id) or disabled_reason
    response = _response_properties(entry)
    if (not shared_supported or entry.get("method") != "POST"
            or not re.fullmatch(r"/openapi/v2/[A-Za-z0-9_./\[\]-]+", endpoint)
            or endpoint != "/openapi/v2/" + model_id or ".." in endpoint
            or response.get("taskId", {}).get("type") != "string"
            or response.get("status", {}).get("type") != "string"
            or response.get("results", {}).get("type") != "array"
            or response.get("results", {}).get("items", {}).get("properties", {}).get("url", {}).get("type") != "string"
            or "/openapi/v2/query" not in str(entry.get("responses", {}))):
        disabled_reason = disabled_reason or "尚未确认统一任务、查询与报价契约"
    try:
        schema = _prepare_schema(entry.get("schema"))
        if schema.get("type") != "object":
            raise ValueError("顶层参数须为对象")
    except (ValueError, TypeError) as error:
        schema = {"type": "object", "properties": {}, "additionalProperties": False}
        disabled_reason = disabled_reason or str(error)
    legacy = next((item for item in LEGACY_MODELS if item["id"] == model_id), None)
    if legacy:
        label = legacy["label"]
        # Preserve the four previously shipped controls and their defaults.
        for field in legacy["fields"]:
            prop = schema["properties"].get(field["name"], {})
            if "default" in field:
                prop["default"] = field["default"]
            if field["type"] == "urls":
                prop["minItems"] = 1
    fields = []
    for name, prop in schema["properties"].items():
        old = next((item for item in legacy["fields"] if item["name"] == name), {}) if legacy else {}
        field = {**deepcopy(prop), "name": name,
                 "label": old.get("label") or FIELD_LABELS.get(name) or prop.get("title") or name,
                 "required": name in schema.get("required", []), "schema": deepcopy(prop)}
        if "enum" in prop:
            field["options"] = deepcopy(prop["enum"])
        if old.get("type") == "urls":
            field["type"] = "urls"
        fields.append(field)
    if legacy:
        order = {field["name"]: index for index, field in enumerate(legacy["fields"])}
        fields.sort(key=lambda field: order.get(field["name"], len(order)))
    family = model_id.split("/", 1)[0]
    spec = {"id": model_id, "modelId": model_id, "name": label, "label": label,
            "mediaKind": media_kind, "mediaType": media_kind, "capability": capability,
            "family": family, "vendor": family, "category": capability,
            "categories": entry.get("categories", [entry.get("category", "")]),
            "description": entry.get("description", ""), "endpoint": endpoint,
            "priceEndpoint": "/openapi/v2/price-preview/" + model_id,
            "queryEndpoint": "/openapi/v2/query", "responseAdapter": "runninghub_v2",
            "priceAdapter": "runninghub_v2_price_preview", "method": "POST",
            "schema": schema, "fields": fields,
            "defaults": {name: deepcopy(prop["default"]) for name, prop in schema["properties"].items() if "default" in prop},
            "deprecated": deprecated, "disabled": bool(disabled_reason),
            "disabledReason": disabled_reason, "available": not disabled_reason, "enabled": not disabled_reason,
            "status": "deprecated" if deprecated else "disabled" if disabled_reason else "available",
            "docUrl": entry.get("docUrl"), "sourceUrl": entry.get("docUrl")}
    if model_id in CN_UNAVAILABLE:
        spec.update(availabilityScope="runninghub.cn", availabilityEvidence="provider_40310",
                    availabilityCheckedAt="2026-10-25")
    contract = {key: spec[key] for key in ("endpoint", "priceEndpoint", "queryEndpoint", "method",
                "schema", "defaults", "responseAdapter", "priceAdapter", "available")}
    contract["validatorVersion"] = 1
    spec["contractHash"] = hashlib.sha256(json.dumps(contract, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    return spec


def _load_catalog():
    source = json.loads((CATALOG_DIR / "public-model-catalog.json").read_text(encoding="utf-8"))
    documents = json.loads((CATALOG_DIR / "public-document-schemas.json").read_text(encoding="utf-8"))
    supported = _shared_contracts(documents["documents"])
    result = [_build_model(entry, supported) for entry in source["models"]]
    if len({item["id"] for item in result}) != len(result):
        raise ValueError("模型目录包含重复接口")
    legacy_order = {item["id"]: index for index, item in enumerate(LEGACY_MODELS)}
    result.sort(key=lambda item: legacy_order.get(item["id"], len(legacy_order)))
    return tuple(result)


MODELS = _load_catalog()
_MODEL_BY_ID = {spec["id"]: spec for spec in MODELS}


def model_catalog():
    return deepcopy(list(MODELS))


def model_spec(model_id):
    spec = _MODEL_BY_ID.get(model_id) if isinstance(model_id, str) else None
    if spec is None:
        raise ValueError("请选择已接入的模型")
    return deepcopy(spec)


def normalize_parameters(spec, parameters):
    if spec.get("available") is False or spec.get("disabled"):
        raise ValueError(spec.get("disabledReason") or "该模型暂不可用")
    if not isinstance(parameters, dict):
        raise ValueError("模型参数须为对象")
    try:
        encoded = json.dumps(parameters, ensure_ascii=False, allow_nan=False)
    except (ValueError, TypeError, RecursionError):
        raise ValueError("模型参数须为有效 JSON") from None
    if len(encoded.encode("utf-8")) > MAX_PARAMETER_BYTES:
        raise ValueError("模型参数内容过大")
    result = deepcopy(spec.get("defaults", {}))
    result.update(deepcopy(parameters))
    # Seedream 5 Pro documents resolution as overriding width/height. Do not
    # silently inject its default when the caller explicitly chose dimensions.
    if (spec.get("id") in {DEFAULT_CN_IMAGE_MODEL, DEFAULT_CN_IMAGE_EDIT_MODEL}
            and "resolution" not in parameters and ("width" in parameters or "height" in parameters)):
        result.pop("resolution", None)
    _validate(spec["schema"], result, "模型参数")
    # This cross-field requirement is documented in the Seedance field prose.
    if (spec.get("id", "").startswith("bytedance/seedance-") and result.get("draft") is True
            and result.get("resolution") != "480p"):
        raise ValueError("样片模式的清晰度必须选择 480p")
    return result


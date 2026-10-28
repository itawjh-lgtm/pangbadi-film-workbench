"""Media provider registry and RunningHub workflow API adapter.

Official docs checked on 2026-10-24 via RunningHub's documentation center:
  create: https://www.runninghub.cn/runninghub-api-doc-cn/api-425749013
  query:  https://www.runninghub.cn/runninghub-api-doc-cn/api-425767306
Read-only discovery docs checked on 2026-10-25:
  account: https://www.runninghub.cn/runninghub-api-doc-cn/api-425748943
  workflow: https://www.runninghub.cn/runninghub-api-doc-cn/api-425749014
Create authenticates with apiKey in JSON; query uses Bearer auth. Discovery
uses Bearer plus JSON apikey (account) or apiKey (workflow), case-sensitive.
The legacy /task/openapi/status endpoint is marked for deprecation.

This module never submits in the background, retries a creation, downloads an
output, or executes content. The caller owns job persistence and idempotency.
"""

from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
import hashlib
import json
import math
import os
from pathlib import Path
import re
import secrets
import ssl
import sys
import tempfile
import threading
import time
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlsplit
from urllib.request import HTTPRedirectHandler, HTTPSHandler, Request, build_opener

from .media_models import DEFAULT_CN_IMAGE_MODEL, DEFAULT_CN_IMAGE_PARAMETERS, model_catalog, model_spec, normalize_parameters


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CONFIG_PATH = PROJECT_ROOT / "data" / "runtime" / "connections.json"
RUNNINGHUB_BASE_URL = "https://www.runninghub.cn"
CREATE_ENDPOINT = "/task/openapi/create"
QUERY_ENDPOINT = "/openapi/v2/query"
ACCOUNT_ENDPOINT = "/uc/openapi/accountStatus"
WORKFLOW_ENDPOINT = "/api/openapi/getJsonApiFormat"
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
MAX_TEXT_OUTPUTS = 20
MAX_TEXT_OUTPUT_CHARS = 64 * 1024
MAX_TOTAL_TEXT_OUTPUT_CHARS = 128 * 1024
MAX_WORKFLOW_NODES = 1000
MAX_WORKFLOW_FIELDS = 200
MAX_WORKFLOW_OUTPUT_BYTES = 512 * 1024
CURRENCIES = {"CNY", "USD", "RH_COIN"}
MODEL_QUOTE_TTL_SECONDS = 300
MEDIA_CONTEXT_FIELDS = ("projectId", "taskId", "shotId", "sourceArtifactId", "promptArtifactId", "name", "mediaKind")
MODEL_BUDGET_NOTICE = (
    "费用来自RunningHub官方实时估价，报价有效期5分钟。预算用于本次提交前核对，"
    "不是平台账单硬上限；实际费用以平台任务与账单为准。本工作台仅提交一次，不自动重试。"
)
BUDGET_NOTICE = (
    "费用为用户填写的单价估算，不是平台报价。预算仅用于提交前比较，"
    "不是 RunningHub 账单硬上限；工作流时长、节点、第三方模型及平台计费可能改变实际费用。"
    "本工作台每次仅提交一次，不自动重试或追加生成。实际费用以平台任务与账单为准。"
)
PROVIDERS = (
    {"id": "runninghub", "label": "RunningHub", "supportsApi": True,
     "platformUrl": "https://www.runninghub.cn/",
     "apiKeyUrl": "https://www.runninghub.cn/enterprise-api/consumerApi",
     "billingUrl": "https://www.runninghub.cn/call-api/bill-task",
     "docsUrl": "https://www.runninghub.cn/runninghub-api-doc-cn/",
     "mode": "workflow_api", "supportedModes": ["model_api", "workflow_api"], "priority": 1},
    {"id": "ark", "label": "火山方舟", "supportsApi": False,
     "platformUrl": "https://console.volcengine.com/ark/", "mode": "platform_link", "priority": 2},
    {"id": "minimax", "label": "MiniMax", "supportsApi": False,
     "platformUrl": "https://platform.minimaxi.com/", "mode": "platform_link", "priority": 3},
    {"id": "libtv", "label": "LibTV", "supportsApi": False,
     "platformUrl": None, "mode": "platform_link", "priority": 4},
    {"id": "jimeng", "label": "即梦", "supportsApi": False,
     "platformUrl": "https://jimeng.jianying.com/", "mode": "platform_link", "priority": 5},
)


class MediaValidationError(ValueError):
    """The request is not ready for an external API operation."""


class MediaRequestError(RuntimeError):
    """A provider request failed, possibly after a billable submission."""

    def __init__(self, message: str, code: str = "PROVIDER_ERROR", outcome_unknown: bool = False):
        super().__init__(message)
        self.code = code
        self.outcome_unknown = outcome_unknown


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Never forward a credential to a redirect destination.
        return None


def _safe_url(value: Any) -> str | None:
    if not isinstance(value, str) or len(value) > 12000:
        return None
    try:
        parsed = urlsplit(value)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
            return None
        if parsed.hostname.lower() in {"localhost", "127.0.0.1", "::1", "0.0.0.0"}:
            return None
    except ValueError:
        return None
    return value


def _number(value: Any, label: str, minimum: Decimal = Decimal("0"), positive: bool = False) -> Decimal:
    if isinstance(value, bool) or value is None:
        raise MediaValidationError(f"{label}须为有效数字")
    try:
        parsed = Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError):
        raise MediaValidationError(f"{label}须为有效数字") from None
    if not parsed.is_finite() or parsed < minimum or (positive and parsed <= 0) or parsed > Decimal("1e12"):
        raise MediaValidationError(f"{label}须为{'正数' if positive else '非负数'}，且不超过 1e12")
    return parsed


def _identifier(value: Any, label: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", value):
        raise MediaValidationError(f"{label}须为平台提供的 ID，不能填写网页地址")
    return value


def normalize_workflow_id(value: Any) -> str:
    """Extract an ID without ever requesting the supplied URL."""
    message = "请填写工作流ID或RunningHub官方工作流链接；不支持AI应用链接"
    if not isinstance(value, str) or not value.strip() or len(value) > 2048:
        raise MediaValidationError(message)
    value = value.strip()
    if re.fullmatch(r"[A-Za-z0-9_-]{1,100}", value):
        return value
    try:
        parsed = urlsplit(value)
        if (parsed.scheme != "https" or parsed.hostname not in {"runninghub.cn", "www.runninghub.cn"}
                or parsed.username or parsed.password or parsed.port not in {None, 443}
                or parsed.fragment):
            raise ValueError("not an official workflow link")
        match = re.fullmatch(r"/(?:workflow|workflow-detail)(?:/([A-Za-z0-9_-]{1,100}))?/?", parsed.path)
        if parsed.path != "/" and not match:
            raise ValueError("not a workflow path")
        query = parse_qs(parsed.query, keep_blank_values=True, max_num_fields=32)
        query_ids = query.get("workflowId", [])
        if len(query_ids) > 1:
            raise ValueError("ambiguous workflow ID")
        path_id = match.group(1) if match else None
        query_id = query_ids[0] if query_ids else None
        if query_id is not None and not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", query_id):
            raise ValueError("invalid workflow ID")
        if path_id and query_id and path_id != query_id:
            raise ValueError("ambiguous workflow ID")
        if path_id or query_id:
            return path_id or query_id
    except (ValueError, TypeError):
        pass
    raise MediaValidationError(message)


def _credential_field(value: str) -> bool:
    compact = re.sub(r"[^a-z0-9\u4e00-\u9fff]", "", value.lower())
    return (compact == "key" or compact.startswith(("auth", "cookie", "session"))
            or any(marker in compact for marker in (
                "apikey", "accesskey", "secret", "password", "passwd", "credential", "token",
                "privatekey", "clientkey", "密钥", "密码", "令牌")))


def _sensitive_default(value: Any, key: str) -> bool:
    if not isinstance(value, str):
        return False
    return bool(
        key in value
        or re.search(r"(?i)\b(?:bearer|basic)\s+\S+", value)
        or re.search(r"[a-z]+://[^\s/@]+:[^\s/@]+@", value, re.IGNORECASE)
        or re.search(r"(?i)(?:api[_ -]?key|password|secret|token|authorization)\s*[:=]", value)
        or re.search(r"\b(?:sk|rk|rh|pk)[_-][A-Za-z0-9_-]{16,}", value)
        or re.fullmatch(r"[A-Za-z0-9_+/=-]{32,}", value.strip())
        or re.search(r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", value)
    )


def _reject_json_constant(value: str) -> None:
    raise ValueError("non-finite JSON constant")


def _nodes(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list) or len(value) > 200:
        raise MediaValidationError("nodeInfoList须为不超过200项的数组")
    nodes = []
    seen = set()
    for item in value:
        if not isinstance(item, dict) or not {"nodeId", "fieldName", "fieldValue"}.issubset(item):
            raise MediaValidationError("每个节点须有nodeId、fieldName、fieldValue")
        node_id, field = item["nodeId"], item["fieldName"]
        if not isinstance(node_id, str) or not node_id.strip() or len(node_id) > 100:
            raise MediaValidationError("nodeId须为非空字符串")
        if not isinstance(field, str) or not field.strip() or len(field) > 200:
            raise MediaValidationError("fieldName须为非空字符串")
        if (node_id, field) in seen:
            raise MediaValidationError("同一节点字段不能重复填写")
        seen.add((node_id, field))
        nodes.append({"nodeId": node_id, "fieldName": field, "fieldValue": deepcopy(item["fieldValue"])})
    try:
        encoded = json.dumps(nodes, ensure_ascii=False, allow_nan=False).encode("utf-8")
    except (ValueError, TypeError, OverflowError):
        raise MediaValidationError("节点参数必须为有效JSON，不能包含NaN或无限值") from None
    if len(encoded) > 512 * 1024:
        raise MediaValidationError("节点参数过大，请使用平台资源引用而非内嵌文件")
    return nodes


def _tls_context() -> ssl.SSLContext:
    """Use local trust roots without changing process-wide TLS verification."""
    # Explicit trust configuration must not silently fall back to another CA
    # store. OpenSSL otherwise ignores a missing SSL_CERT_DIR until handshake.
    if "SSL_CERT_FILE" in os.environ or "SSL_CERT_DIR" in os.environ:
        cafile, capath = os.environ.get("SSL_CERT_FILE"), os.environ.get("SSL_CERT_DIR")
        if cafile is not None and (not cafile or not Path(cafile).is_file()):
            raise ValueError("SSL_CERT_FILE须指向有效的CA证书文件")
        if capath is not None and (not capath or not Path(capath).is_dir()):
            raise ValueError("SSL_CERT_DIR须指向有效的CA证书目录")
        return ssl.create_default_context(cafile=cafile, capath=capath)

    # Python.org macOS builds may have no OpenSSL CA bundle installed, even
    # though Keychain has the required roots. Do not inject truststore globally.
    if sys.platform == "darwin":
        try:
            import truststore
        except ImportError:
            pass
        else:
            return truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)

    context = ssl.create_default_context()
    if not context.get_ca_certs():
        try:
            import certifi
        except ImportError:
            pass  # Verification stays required; missing roots fail closed.
        else:
            context.load_verify_locations(cafile=certifi.where())
    return context


def _default_transport(url: str, payload: dict | bytes, headers: dict, timeout: float) -> dict:
    request = Request(url, data=payload if isinstance(payload, bytes) else json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8"),
                      headers=headers, method="POST")
    with build_opener(_NoRedirect(), HTTPSHandler(context=_tls_context())).open(request, timeout=timeout) as response:
        raw = response.read(MAX_RESPONSE_BYTES + 1)
    if len(raw) > MAX_RESPONSE_BYTES:
        raise ValueError("provider response too large")
    parsed = json.loads(raw.decode("utf-8"))
    if not isinstance(parsed, dict):
        raise ValueError("provider response is not an object")
    return parsed


class MediaRegistry:
    def __init__(self, config_path: str | Path | None = None,
                 transport: Callable | None = None, timeout: float = 40):
        self.config_path = Path(config_path) if config_path else DEFAULT_CONFIG_PATH
        self._transport = transport or _default_transport
        self.timeout = timeout
        self._lock = threading.RLock()
        self._providers = {item["id"]: item for item in PROVIDERS}
        # Verification is process-local. Restarting requires another read-only
        # check; no credential fingerprint or account details are persisted.
        self._verification: dict[str, dict] = {}
        self._credential_versions: dict[str, int] = {}
        self._verification_requests: dict[str, int] = {}
        self._model_quotes: dict[str, dict] = {}

    def upload_reference_image(self, content: bytes, mime_type: str, filename: str) -> str:
        """Official binary upload only; this endpoint does not create a model task."""
        if (not isinstance(content, bytes) or not 0 < len(content) <= 10 * 1024 * 1024
                or mime_type not in {"image/png", "image/jpeg", "image/webp"}
                or not re.fullmatch(r"[A-Za-z0-9_-]+\.(png|jpg|webp)", filename)):
            raise MediaValidationError("参考图片格式或大小无效")
        key, _ = self._credentials("runninghub", "model_api")
        boundary = "StudioReference" + secrets.token_hex(20)
        body = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{filename}"\r\n'
                f'Content-Type: {mime_type}\r\n\r\n').encode() + content + f"\r\n--{boundary}--\r\n".encode()
        try:
            result = self._transport(RUNNINGHUB_BASE_URL + "/openapi/v2/media/upload/binary", body,
                {"Content-Type": "multipart/form-data; boundary=" + boundary,
                 "Authorization": "Bearer " + key, "Accept": "application/json"}, max(self.timeout, 60))
            data = result.get("data") if isinstance(result, dict) else None
            url = _safe_url(data.get("download_url")) if isinstance(data, dict) else None
            if result.get("code") != 0 or not url or key in url:
                raise ValueError("invalid upload response")
            return url
        except HTTPError as error:
            if error.code in (401, 403):
                raise MediaRequestError("参考图上传被拒绝，请检查 RunningHub 模型 API Key 的权限。", "UPLOAD_AUTH") from None
            raise MediaRequestError("RunningHub 暂时无法接收参考图，请稍后重新核对生成费用。", "UPLOAD_FAILED") from None
        except Exception:
            raise MediaRequestError("参考图上传未完成，请检查连接后重试；本机原图仍保留。", "UPLOAD_FAILED") from None

    def _provider(self, provider: str) -> dict:
        if not isinstance(provider, str) or provider not in self._providers:
            raise MediaValidationError("未知媒体平台")
        return self._providers[provider]

    def _read_config(self) -> dict:
        if self.config_path.is_symlink():
            raise MediaValidationError("连接配置不能使用符号链接")
        if not self.config_path.exists():
            return {"version": 1, "providers": {}}
        try:
            # Fix an existing permissive file before touching its credentials.
            self.config_path.chmod(0o600)
            value = json.loads(self.config_path.read_text(encoding="utf-8"))
            if not isinstance(value, dict) or not isinstance(value.get("providers", {}), dict):
                raise ValueError("invalid config structure")
            availability = value.get("modelAvailability", {})
            if (not isinstance(availability, dict) or any(not isinstance(record, dict) or
                    any(not isinstance(record.get(field), str) or not record[field] for field in
                        ("reason", "observedAt", "modelId")) for record in availability.values())):
                raise ValueError("invalid model availability evidence")
            for config in value.get("providers", {}).values():
                if not isinstance(config, dict):
                    raise ValueError("invalid provider config")
                for field in ("apiKey", "modelApiKey"):
                    key = config.get(field)
                    if key is not None and (not isinstance(key, str) or re.search(r"\s", key)):
                        raise ValueError("invalid credential")
            return value
        except (OSError, UnicodeError, ValueError):
            raise MediaValidationError("连接配置无法读取，请检查本地文件格式和权限；未覆盖原文件") from None

    def _write_config(self, value: dict) -> None:
        self.config_path.parent.mkdir(parents=True, exist_ok=True)
        if self.config_path.is_symlink():
            raise MediaValidationError("连接配置不能使用符号链接")
        fd, temporary = tempfile.mkstemp(prefix=".connections-", suffix=".tmp", dir=self.config_path.parent)
        try:
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(value, handle, ensure_ascii=False, indent=2, allow_nan=False)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.config_path)
            self.config_path.chmod(0o600)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def configure(self, provider: str, config: dict) -> dict:
        spec = self._provider(provider)
        if not isinstance(config, dict):
            raise MediaValidationError("配置须为对象")
        allowed = {"apiKey", "clearApiKey", "modelApiKey", "clearModelApiKey", "workflowId", "unitPrice", "unit", "currency", "platformUrl"}
        if set(config) - allowed:
            raise MediaValidationError("配置包含不支持的字段")
        for key_field, clear_field in (("apiKey", "clearApiKey"), ("modelApiKey", "clearModelApiKey")):
            if key_field in config and not isinstance(config[key_field], str):
                raise MediaValidationError("API Key须为字符串；空字符串保留原密钥")
            if clear_field in config and not isinstance(config[clear_field], bool):
                raise MediaValidationError(f"{clear_field}须为布尔值")
            if config.get(key_field) and not spec["supportsApi"]:
                raise MediaValidationError("该平台API适配尚未实现，不保存其密钥；可配置平台链接与用户参考价格")
        with self._lock:
            data = self._read_config()
            providers = data.setdefault("providers", {})
            current = deepcopy(providers.get(provider, {}))
            previous_keys = {field: current.get(field) for field in ("apiKey", "modelApiKey")}
            for key_field, clear_field in (("apiKey", "clearApiKey"), ("modelApiKey", "clearModelApiKey")):
                if config.get(clear_field) is True:
                    current.pop(key_field, None)
                key = config.get(key_field)
                if key:
                    if len(key) > 4096 or re.search(r"\s", key):
                        raise MediaValidationError("API Key格式无效")
                    current[key_field] = key
            if "workflowId" in config:
                current["workflowId"] = (normalize_workflow_id(config["workflowId"])
                                         if config["workflowId"] else "")
            if "unitPrice" in config:
                current["unitPrice"] = None if config["unitPrice"] is None else float(_number(config["unitPrice"], "单价"))
            if "unit" in config:
                if not isinstance(config["unit"], str) or not 1 <= len(config["unit"].strip()) <= 40:
                    raise MediaValidationError("请填写单价单位，例如次、秒或张")
                current["unit"] = config["unit"].strip()
            if "currency" in config:
                if config["currency"] not in CURRENCIES:
                    raise MediaValidationError("币种须为CNY、USD或RH_COIN")
                current["currency"] = config["currency"]
            if "platformUrl" in config:
                if not _safe_url(config["platformUrl"]):
                    raise MediaValidationError("平台链接须为不含凭据的HTTPS地址")
                current["platformUrl"] = config["platformUrl"]
            providers[provider] = current
            self._write_config(data)
            for field, mode in (("apiKey", "workflow_api"), ("modelApiKey", "model_api")):
                if previous_keys[field] != current.get(field):
                    slot = self._credential_slot(provider, mode)
                    self._credential_versions[slot] = self._credential_versions.get(slot, 0) + 1
                    self._verification.pop(slot, None)
                    if mode == "model_api":
                        self._model_quotes.clear()
        return next(item for item in self.catalog()["providers"] if item["id"] == provider)

    def catalog(self) -> dict:
        with self._lock:
            configured = self._read_config().get("providers", {})
            for slot, verification in list(self._verification.items()):
                provider, _, mode = slot.partition(":")
                key = configured.get(provider, {}).get("modelApiKey" if mode == "model_api" else "apiKey", "")
                if verification["fingerprint"] != self._fingerprint(key):
                    self._verification.pop(slot, None)
            verifications = deepcopy(self._verification)
        result = []
        for spec in PROVIDERS:
            config = configured.get(spec["id"], {})
            key_configured = bool(config.get("apiKey"))
            ready = spec["supportsApi"] and key_configured
            recorded = verifications.get(spec["id"])
            verification = {"verified": bool(ready and recorded),
                            "checkedAt": recorded["checkedAt"] if ready and recorded else None,
                            "scope": "account" if ready and recorded else None}
            if not spec["supportsApi"]:
                reason = "API适配未接入；当前支持平台跳转与用户参考价格比较"
            elif not key_configured:
                reason = "待填写RunningHub API Key；尚未验证账号权限或发起生成"
            else:
                reason = ("账号连接已验证；工作流权限和实际生成需单独验证"
                          if verification["verified"] else
                          "密钥已保存；请测试连接。服务重启或更换密钥后需要重新验证")
            item = deepcopy(spec)
            item.update({
                "configured": key_configured if spec["supportsApi"] else bool(config),
                "keyConfigured": key_configured,
                "available": ready,
                "verified": verification["verified"],
                "verification": verification,
                "reason": reason,
                "platformUrl": config.get("platformUrl") or spec["platformUrl"],
                "config": {"workflowId": config.get("workflowId", ""),
                           "unitPrice": config.get("unitPrice"), "unit": config.get("unit", "次"),
                           "currency": config.get("currency", "CNY")},
                "pricingSource": "user_estimate",
                "hardBudgetCap": False,
            })
            if spec["id"] == "runninghub":
                model_ready = bool(config.get("modelApiKey"))
                recorded_model = verifications.get(self._credential_slot(spec["id"], "model_api"))
                model_verification = {"verified": bool(model_ready and recorded_model),
                                      "checkedAt": recorded_model["checkedAt"] if model_ready and recorded_model else None,
                                      "scope": "price_preview" if model_ready and recorded_model else None}
                item["models"] = self.models()["models"]
                item["modelConnection"] = {
                    "keyConfigured": model_ready, "available": model_ready,
                    "verified": model_verification["verified"], "verification": model_verification,
                    "reason": "官方模型估价连接已验证；生成需另行确认" if model_verification["verified"] else
                              "模型共享密钥已保存，待测试连接" if model_ready else
                              "独立模型需单独的共享API密钥；个人API密钥请使用工作流入口"}
            result.append(item)
        return {"providers": result, "budgetNotice": BUDGET_NOTICE,
                "defaultProvider": "runninghub", "scope": "local_configuration"}

    def health(self, provider: str | None = None) -> dict:
        """Local readiness only; no network calls and no paid probe."""
        result = self.catalog()
        if provider is None:
            return result
        self._provider(provider)
        return next(item for item in result["providers"] if item["id"] == provider)

    def models(self) -> dict:
        with self._lock:
            records = self._read_config().get("modelAvailability", {})
        return {"provider": "runninghub", "models": [self._availability(spec, records) for spec in model_catalog()]}

    @staticmethod
    def _availability(spec: dict, records: dict) -> dict:
        record = records.get(RUNNINGHUB_BASE_URL + spec["endpoint"])
        if record:
            spec.update(available=False, enabled=False, disabled=True, status="disabled",
                        disabledReason=record["reason"], availabilityScope="runninghub.cn",
                        availabilityEvidence="provider_retired", availabilityCheckedAt=record["observedAt"])
        return spec

    def _effective_model_spec(self, model_id: str) -> dict:
        with self._lock:
            return self._availability(model_spec(model_id), self._read_config().get("modelAvailability", {}))

    def _remember_model_retirement(self, spec: dict, response: dict, key: str,
                                   source_job_id: str | None = None, observed_at: str | None = None) -> dict | None:
        """Persist only explicit retirement evidence for this exact CN endpoint."""
        code = response.get("errorCode")
        code = str(code) if isinstance(code, (str, int)) and not isinstance(code, bool) else ""
        message = response.get("errorMessage")
        message = message if isinstance(message, str) else ""
        # Auth, payment, capacity and transient failures say nothing about
        # retirement. Never turn MODEL_UNAVAILABLE alone into a permanent ban.
        if (code in {"401", "429", "500", "502", "503", "504"} or
                re.search(r"AUTH|API.?KEY|TOKEN|PERMISSION|RATE|LIMIT|QUOTA|BALANCE|PAYMENT|CREDIT", code, re.I)):
            return None
        explicit_code = code.upper() in {"40310", "MODEL_DEPRECATED", "MODEL_RETIRED", "MODEL_DISCONTINUED",
                                        "ENDPOINT_DEPRECATED", "ENDPOINT_RETIRED", "ENDPOINT_DISCONTINUED"}
        explicit_message = bool(re.search(
            r"(?:模型|接口|model|endpoint)[^\n。！？.!?]{0,120}(?:已(?:经)?(?:下架|下线|退役|停用)|"
            r"(?:has\s+been|is|was)\s+(?:permanently\s+)?(?:deprecated|retired|discontinued|decommissioned))",
            message, re.I))
        if not explicit_code and not explicit_message:
            return None
        safe_code = code if re.fullmatch(r"[A-Za-z0-9_-]{1,80}", code) and (not key or key not in code) else "PROVIDER_RETIRED"
        record = {"modelId": spec["id"], "providerCode": safe_code,
                  "reason": f"RunningHub 中国站已明确下架此模型接口（{safe_code}），本机已停用，请选择其他可用模型。",
                  "observedAt": observed_at or datetime.now(timezone.utc).isoformat()}
        if source_job_id:
            record.update(sourceJobId=source_job_id, evidenceSource="historical_media_failure")
        with self._lock:
            data = self._read_config()
            records = data.setdefault("modelAvailability", {})
            endpoint = RUNNINGHUB_BASE_URL + spec["endpoint"]
            if endpoint not in records:
                records[endpoint] = record
                self._write_config(data)
            self._model_quotes = {token: quote for token, quote in self._model_quotes.items()
                                  if quote["result"].get("modelId") != spec["id"]}
            return records[endpoint]

    def backfill_model_retirements(self, jobs) -> int:
        """Recover explicit provider retirement from saved failures, without API calls."""
        added = 0
        for job in jobs:
            if (not isinstance(job, dict) or job.get("provider") != "runninghub" or
                    job.get("mode") != "model_api" or job.get("status") != "failed"):
                continue
            try:
                spec = model_spec(job.get("modelId"))
            except ValueError:
                continue
            error = job.get("error")
            if isinstance(error, dict):
                diagnostic = {"errorCode": error.get("code"), "errorMessage": error.get("message")}
            elif isinstance(error, str) and error.startswith(("RunningHub拒绝模型任务", "RunningHub 中国站已明确下架此模型接口")):
                match = re.search(r"[（(](40310|MODEL_RETIRED|MODEL_DEPRECATED|MODEL_DISCONTINUED)\b", error)
                diagnostic = {"errorCode": match.group(1) if match else "", "errorMessage": error}
            else:
                continue
            observed_at = None
            timestamp = job.get("updatedAt") or job.get("createdAt")
            if type(timestamp) in (int, float):
                try:
                    observed_at = datetime.fromtimestamp(timestamp / 1000, timezone.utc).isoformat()
                except (OSError, ValueError, OverflowError):
                    pass
            source_id = job.get("id")
            source_id = source_id if isinstance(source_id, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,160}", source_id) else None
            with self._lock:
                known = RUNNINGHUB_BASE_URL + spec["endpoint"] in self._read_config().get("modelAvailability", {})
                record = self._remember_model_retirement(spec, diagnostic, "", source_id, observed_at)
                added += bool(record and not known)
        return added

    def _config(self, provider: str) -> dict:
        self._provider(provider)
        with self._lock:
            return deepcopy(self._read_config().get("providers", {}).get(provider, {}))

    @staticmethod
    def _fingerprint(key: str) -> str:
        return hashlib.sha256(key.encode("utf-8")).hexdigest()

    @staticmethod
    def _mode(request: dict) -> str:
        mode = request.get("mode", "workflow_api")
        if mode not in ("workflow_api", "model_api"):
            raise MediaValidationError("生成模式须为模型直连或工作流")
        return mode

    @staticmethod
    def _credential_slot(provider: str, mode: str) -> str:
        return provider + ":model_api" if mode == "model_api" else provider

    def _credentials(self, provider: str, mode: str = "workflow_api") -> tuple[str, int]:
        if not self._provider(provider)["supportsApi"]:
            raise MediaValidationError("该平台尚未接入API")
        with self._lock:
            key = self._config(provider).get("modelApiKey" if mode == "model_api" else "apiKey")
            if not key:
                raise MediaValidationError("模型直连需单独的共享API密钥；个人API密钥请使用工作流入口" if mode == "model_api" else "尚未配置RunningHub API Key")
            return key, self._credential_versions.get(self._credential_slot(provider, mode), 0)

    def _assert_same_credentials(self, provider: str, key: str, version: int, mode: str = "workflow_api") -> None:
        if (self._credential_versions.get(self._credential_slot(provider, mode), 0) != version
                or self._config(provider).get("modelApiKey" if mode == "model_api" else "apiKey") != key):
            raise MediaRequestError("检测期间密钥已更换，请使用新配置重新操作。", "CONNECTION_CHANGED")

    @staticmethod
    def _read_only_data(response: dict, operation: str) -> dict:
        code = response.get("code")
        if type(code) is not int:
            raise MediaRequestError("RunningHub返回格式异常，请稍后重试。", "INVALID_RESPONSE")
        if code != 0:
            message = ("RunningHub未通过账号验证，请核对API密钥及账号权限。" if operation == "account"
                       else "RunningHub未允许读取工作流，请核对工作流ID、公开状态和账号权限。")
            # Provider messages/codes may contain credentials or account data.
            raise MediaRequestError(message, "ACCOUNT_REJECTED" if operation == "account" else "WORKFLOW_REJECTED")
        data = response.get("data")
        if not isinstance(data, dict):
            raise MediaRequestError("RunningHub返回格式异常，请稍后重试。", "INVALID_RESPONSE")
        return data

    def verify(self, provider: str, mode: str = "workflow_api") -> dict:
        """Authenticate with a read-only account or quote call; never generate."""
        if self._mode({"mode": mode}) == "model_api":
            return self._verify_model(provider)
        with self._lock:
            key, version = self._credentials(provider)
            request_version = self._verification_requests.get(provider, 0) + 1
            self._verification_requests[provider] = request_version
            self._verification.pop(provider, None)
        response = self._post(ACCOUNT_ENDPOINT, {"apikey": key}, key, False)
        data = self._read_only_data(response, "account")
        account_values = [data[field] for field in (
            "remainCoins", "currentTaskCounts", "remainMoney", "currency", "apiType") if field in data]
        if (not account_values or not any(value is not None for value in account_values)
                or any(value is not None and (type(value) not in {str, int, float}
                       or (isinstance(value, float) and not math.isfinite(value))) for value in account_values)):
            raise MediaRequestError("RunningHub未返回可核验的账号状态，请稍后重试。", "INVALID_RESPONSE")
        result = {"verified": True, "checkedAt": datetime.now(timezone.utc).isoformat(), "scope": "account"}
        with self._lock:
            self._assert_same_credentials(provider, key, version)
            if self._verification_requests.get(provider) != request_version:
                raise MediaRequestError("已有更新的连接检测，请查看最新检测结果。", "VERIFICATION_SUPERSEDED")
            self._verification[provider] = {**result, "fingerprint": self._fingerprint(key)}
        return result

    def _verify_model(self, provider: str) -> dict:
        """Use the official price preview endpoint; never submit a probe task."""
        slot = self._credential_slot(provider, "model_api")
        with self._lock:
            key, version = self._credentials(provider, "model_api")
            request_version = self._verification_requests.get(slot, 0) + 1
            self._verification_requests[slot] = request_version
            self._verification.pop(slot, None)
        try:
            spec = self._effective_model_spec(DEFAULT_CN_IMAGE_MODEL)
            parameters = normalize_parameters(spec, {**deepcopy(DEFAULT_CN_IMAGE_PARAMETERS), "prompt": "一艘白色纸船，清晨柔光"})
        except ValueError as error:
            raise MediaValidationError(str(error)) from None
        self._model_price(spec, parameters, key)
        result = {"verified": True, "checkedAt": datetime.now(timezone.utc).isoformat(), "scope": "price_preview"}
        with self._lock:
            self._assert_same_credentials(provider, key, version, "model_api")
            if self._verification_requests.get(slot) != request_version:
                raise MediaRequestError("已有更新的连接检测，请查看最新检测结果。", "VERIFICATION_SUPERSEDED")
            self._verification[slot] = {**result, "fingerprint": self._fingerprint(key)}
        return result

    def workflow(self, provider: str, value: Any) -> dict:
        """Read the workflow graph and expose scalar inputs, excluding credentials."""
        workflow_id = normalize_workflow_id(value)
        key, version = self._credentials(provider)
        if key in workflow_id:
            raise MediaValidationError("工作流ID不能包含API密钥，请从工作流页面复制链接")
        response = self._post(WORKFLOW_ENDPOINT, {"apiKey": key, "workflowId": workflow_id}, key, False)
        data = self._read_only_data(response, "workflow")
        prompt = data.get("prompt")
        try:
            if not isinstance(prompt, str) or len(prompt.encode("utf-8")) > MAX_RESPONSE_BYTES:
                raise ValueError("missing or oversized workflow")
            graph = json.loads(prompt, parse_constant=_reject_json_constant)
            if not isinstance(graph, dict) or not graph or len(graph) > MAX_WORKFLOW_NODES:
                raise ValueError("invalid workflow graph")
            fields = []
            for node_id, node in graph.items():
                if (not isinstance(node_id, str) or not 1 <= len(node_id) <= 100
                        or not isinstance(node, dict) or not isinstance(node.get("inputs"), dict)):
                    raise ValueError("invalid workflow node")
                class_type = node.get("class_type")
                if not isinstance(class_type, str) or not 1 <= len(class_type) <= 200:
                    raise ValueError("invalid node class")
                if _sensitive_default(node_id, key) or _sensitive_default(class_type, key):
                    continue
                metadata = node.get("_meta")
                title = metadata.get("title") if isinstance(metadata, dict) else None
                if not isinstance(title, str) or len(title) > 256 or _sensitive_default(title, key):
                    title = class_type
                for name, value in node["inputs"].items():
                    if not isinstance(name, str) or not 1 <= len(name) <= 200:
                        raise ValueError("invalid input name")
                    if _credential_field(name) or _sensitive_default(name, key) or _sensitive_default(value, key):
                        continue
                    if isinstance(value, (list, dict)) or value is None:
                        continue
                    if type(value) not in {str, int, float, bool}:
                        raise ValueError("invalid scalar input")
                    if isinstance(value, float) and not math.isfinite(value):
                        raise ValueError("invalid numeric input")
                    # JavaScript cannot round-trip larger integer seeds. The
                    # provider accepts decimal strings in nodeInfoList values.
                    if type(value) is int and abs(value) > 9007199254740991:
                        value = str(value)
                    fields.append({"nodeId": node_id, "nodeTitle": title, "classType": class_type,
                                   "fieldName": name, "fieldValue": value,
                                   "valueType": "boolean" if isinstance(value, bool) else
                                   "string" if isinstance(value, str) else "number"})
                    if len(fields) > MAX_WORKFLOW_FIELDS:
                        raise ValueError("too many editable fields")
            result = {"workflowId": workflow_id, "nodeCount": len(graph), "fields": fields,
                      "nodeInfoList": [{name: field[name] for name in ("nodeId", "fieldName", "fieldValue")}
                                       for field in fields]}
            if len(json.dumps(result, ensure_ascii=False, allow_nan=False).encode("utf-8")) > MAX_WORKFLOW_OUTPUT_BYTES:
                raise ValueError("workflow fields too large")
        except (ValueError, TypeError, OverflowError, RecursionError):
            raise MediaRequestError("工作流参数格式异常或超过读取上限，请到RunningHub检查工作流。", "INVALID_WORKFLOW") from None
        with self._lock:
            self._assert_same_credentials(provider, key, version)
        return result

    def _execution(self, config: dict, request: dict) -> dict:
        workflow = request.get("workflowId") or config.get("workflowId")
        # Estimation can be shown before a workflow is chosen; submit requires it.
        workflow = normalize_workflow_id(workflow) if workflow else ""
        payload = {"workflowId": workflow, "nodeInfoList": _nodes(request.get("nodeInfoList", []))}
        if "instanceType" in request:
            if request["instanceType"] not in {"default", "plus", "ultra"}:
                raise MediaValidationError("instanceType只支持default、plus、ultra")
            payload["instanceType"] = request["instanceType"]
        if "addMetadata" in request and not isinstance(request["addMetadata"], bool):
            raise MediaValidationError("addMetadata须为布尔值")
        payload["addMetadata"] = request.get("addMetadata", False)
        # These change billing, target workflow, or external destinations and
        # are deliberately outside the first adapter's supported contract.
        if any(k in request for k in ("retainSeconds", "workflow", "webhookUrl", "usePersonalQueue", "accessPassword",
                                      "apiKey", "modelApiKey", "modelId", "parameters")):
            raise MediaValidationError("请求包含未启用的工作流附加参数或密钥字段")
        return payload

    def estimate(self, provider: str, request: dict) -> dict:
        self._provider(provider)
        if not isinstance(request, dict):
            raise MediaValidationError("估价请求须为对象")
        if self._mode(request) == "model_api":
            return self._estimate_model(provider, request)
        config = self._config(provider)
        quantity = _number(request.get("quantity", 1), "数量", positive=True)
        price_value = request.get("unitPrice", config.get("unitPrice"))
        price = _number(price_value, "单价") if price_value is not None else None
        unit = request.get("unit", config.get("unit", "次"))
        currency = request.get("currency", config.get("currency", "CNY"))
        if currency not in CURRENCIES or not isinstance(unit, str) or not 1 <= len(unit.strip()) <= 40:
            raise MediaValidationError("请填写有效币种和计费单位")
        budget_value = request.get("budget")
        budget = _number(budget_value, "预算", positive=True) if budget_value is not None else None
        cost = quantity * price if price is not None else None
        execution = self._execution(config, request) if provider == "runninghub" else None
        result = {
            "provider": provider, "known": cost is not None,
            "estimatedCost": float(cost) if cost is not None else None,
            "quantity": float(quantity), "unitPrice": float(price) if price is not None else None,
            "unit": unit.strip(), "currency": currency,
            "budget": float(budget) if budget is not None else None,
            "withinBudget": cost <= budget if cost is not None and budget is not None else None,
            "pricingSource": "user_estimate" if cost is not None else "unknown",
            "hardBudgetCap": False, "budgetNotice": BUDGET_NOTICE,
        }
        binding = {"execution": execution, "estimate": result,
                   "context": {field: request.get(field) for field in MEDIA_CONTEXT_FIELDS}}
        result["estimateToken"] = hashlib.sha256(json.dumps(
            binding, sort_keys=True, ensure_ascii=False, allow_nan=False
        ).encode("utf-8")).hexdigest()
        return result

    def _model_context(self, provider: str, request: dict) -> tuple:
        if provider != "runninghub":
            raise MediaValidationError("该平台尚未接入模型直连")
        if any(name in request for name in ("apiKey", "modelApiKey", "headers", "endpoint", "url", "webhookUrl",
                                            "workflowId", "nodeInfoList", "instanceType", "addMetadata")):
            raise MediaValidationError("模型直连请求不能包含密钥、接口地址或工作流参数")
        try:
            spec = self._effective_model_spec(request.get("modelId"))
            parameters = normalize_parameters(spec, request.get("parameters", {}))
        except ValueError as error:
            raise MediaValidationError(str(error)) from None
        if _number(request.get("quantity", 1), "数量", positive=True) != 1:
            raise MediaValidationError("模型直连每次只提交一个任务，请将数量设为1")
        # A zero cap is valid for an explicitly free official model quote.
        budget = _number(request["budget"], "预算") if request.get("budget") is not None else None
        key, version = self._credentials(provider, "model_api")
        encoded = json.dumps(parameters, ensure_ascii=False, sort_keys=True, allow_nan=False)
        if key in encoded:
            raise MediaValidationError("模型输入不能包含API密钥")
        binding = {"provider": provider, "mode": "model_api", "modelId": spec["id"],
                   "contractHash": spec["contractHash"], "endpoint": spec["endpoint"],
                   "priceEndpoint": spec["priceEndpoint"],
                   "parameters": parameters, "budget": str(budget) if budget is not None else None,
                   "currency": request.get("currency"), "credentialVersion": version,
                   "credentialFingerprint": self._fingerprint(key),
                   "context": {field: request.get(field) for field in MEDIA_CONTEXT_FIELDS}}
        digest = hashlib.sha256(json.dumps(binding, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        return spec, parameters, key, version, budget, digest

    def _model_price(self, spec: dict, parameters: dict, key: str) -> tuple[Decimal, str, bool]:
        endpoint = spec["priceEndpoint"]
        response = self._post(endpoint, parameters, key, False, model_specification=spec)
        if (response.get("errorCode") not in (None, "", 0, "0") or response.get("errorMessage")
                or not isinstance(response.get("currency"), str) or response["currency"] not in CURRENCIES
                or type(response.get("isFreeThisCall")) is not bool):
            raise MediaRequestError("RunningHub未返回有效模型报价，请核对模型权限并重新估价。", "PRICE_UNAVAILABLE")
        try:
            price = _number(response.get("estimatedPrice"), "官方估价")
        except MediaValidationError:
            raise MediaRequestError("RunningHub报价金额未知，未按免费处理。", "PRICE_UNAVAILABLE") from None
        if price == 0 and response["isFreeThisCall"] is not True:
            raise MediaRequestError("RunningHub返回零金额但未确认免费，未允许提交。", "PRICE_UNAVAILABLE")
        return price, response["currency"], response["isFreeThisCall"]

    def _estimate_model(self, provider: str, request: dict) -> dict:
        spec, parameters, key, version, budget, binding = self._model_context(provider, request)
        token = request.get("estimateToken")
        with self._lock:
            self._model_quotes = {key_: quote for key_, quote in self._model_quotes.items()
                                  if quote["expires"] > time.monotonic()}
            if token is not None:
                quote = self._model_quotes.get(token) if isinstance(token, str) else None
                if not quote or quote["binding"] != binding:
                    raise MediaValidationError("模型报价已过期或参数、预算、密钥已变化，请重新估价并确认")
                return deepcopy(quote["result"])
        price, currency, free = self._model_price(spec, parameters, key)
        if request.get("currency") is not None and request["currency"] != currency:
            raise MediaValidationError("预算币种与官方报价不一致，请使用报价币种重新估价")
        now = datetime.now(timezone.utc)
        result = {"provider": provider, "mode": "model_api", "modelId": spec["id"], "modelName": spec["name"],
                  "known": True, "estimatedCost": float(price), "unitPrice": float(price), "quantity": 1,
                  "currency": currency, "unit": "次", "budget": float(budget) if budget is not None else None,
                  "withinBudget": price <= budget if budget is not None else None,
                  "pricingSource": "runninghub_price_preview", "isFreeThisCall": free,
                  "hardBudgetCap": False, "budgetNotice": MODEL_BUDGET_NOTICE,
                  "quotedAt": now.isoformat(), "expiresAt": (now + timedelta(seconds=MODEL_QUOTE_TTL_SECONDS)).isoformat(),
                  "estimateToken": secrets.token_urlsafe(32)}
        with self._lock:
            self._assert_same_credentials(provider, key, version, "model_api")
            if len(self._model_quotes) >= 256:
                self._model_quotes.pop(next(iter(self._model_quotes)))
            self._model_quotes[result["estimateToken"]] = {
                "binding": binding, "expires": time.monotonic() + MODEL_QUOTE_TTL_SECONDS,
                "result": deepcopy(result)}
        return result

    def bind_model_quote_budget(self, provider: str, request: dict, budget) -> dict:
        """Bind a cached, unbudgeted price to the canvas' exact quoted total.

        This internal operation neither reprices nor submits. All original
        inputs/credentials must still match, and the original expiry remains.
        The caller still needs a separate explicit batch cost confirmation.
        """
        if request.get("budget") is not None or not request.get("estimateToken"):
            raise MediaValidationError("只有未设置预算的有效报价可以绑定批次总价")
        cap = _number(budget, "批次总价")
        with self._lock:
            result = self._estimate_model(provider, request)
            if Decimal(str(result["estimatedCost"])) > cap:
                raise MediaValidationError("批次总价不能低于节点官方报价")
            bounded = {**deepcopy(request), "budget": float(cap)}
            *_, binding = self._model_context(provider, bounded)
            quote = self._model_quotes[request["estimateToken"]]
            result.update(budget=float(cap), withinBudget=True)
            quote.update(binding=binding, result=deepcopy(result))
            return result

    @staticmethod
    def _redact(value: Any, key: str) -> str:
        return str(value or "").replace(key, "[REDACTED]")[:1500] if key else str(value or "")[:1500]

    @classmethod
    def _model_rejection_message(cls, response: dict, key: str) -> str:
        # Only expose bounded scalar diagnostics, never the response or request.
        def safe(value, limit):
            if not isinstance(value, (str, int, float)) or isinstance(value, bool):
                return ""
            value = cls._redact(value, key)
            value = re.sub(r"(?i)\bBearer\s+[^\s,;\"']+", "Bearer [REDACTED]", value)
            value = re.sub(r"(?i)(api[_-]?key|access[_-]?token|authorization)(\s*[=:]\s*)[^\s,;\"']+",
                           r"\1\2[REDACTED]", value)
            return " ".join(value.split())[:limit]

        code = safe(response.get("errorCode"), 80)
        reason = safe(response.get("errorMessage"), 320)
        detail = " · ".join(part for part in (code, reason) if part)
        return "RunningHub拒绝模型任务" + (f"（{detail}）。" if detail else "，请核对模型权限和输入参数。")

    def _post(self, endpoint: str, payload: dict, key: str, submitting: bool, model_specification: dict | None = None) -> dict:
        headers = {"Content-Type": "application/json", "Accept": "application/json"}
        if endpoint in {QUERY_ENDPOINT, ACCOUNT_ENDPOINT, WORKFLOW_ENDPOINT} or endpoint.startswith("/openapi/v2/"):
            headers["Authorization"] = "Bearer " + key
        try:
            response = self._transport(RUNNINGHUB_BASE_URL + endpoint, payload, headers, self.timeout)
            if not isinstance(response, dict):
                raise ValueError("invalid provider response")
            matching_task = endpoint != QUERY_ENDPOINT or response.get("taskId") in (None, payload.get("taskId"))
            retired = self._remember_model_retirement(model_specification, response, key) if model_specification and matching_task else None
            if retired and not response.get("taskId"):
                raise MediaRequestError(retired["reason"], "MODEL_RETIRED")
            return response
        except HTTPError as exc:
            # Inspect a bounded model diagnostic only; never expose raw bodies,
            # URLs or headers. 401/429/5xx cannot establish model retirement.
            retired = None
            try:
                if model_specification and 400 <= exc.code < 500 and exc.code not in {401, 429}:
                    raw = exc.read(16385)
                    response = json.loads(raw.decode("utf-8")) if len(raw) <= 16384 else None
                    if isinstance(response, dict):
                        retired = self._remember_model_retirement(model_specification, response, key)
            except (OSError, ValueError, UnicodeError):
                pass
            finally:
                exc.close()
            if retired:
                raise MediaRequestError(retired["reason"], "MODEL_RETIRED") from None
            if endpoint in {ACCOUNT_ENDPOINT, WORKFLOW_ENDPOINT} or endpoint.startswith("/openapi/v2/price-preview/"):
                raise MediaRequestError("RunningHub连接检测或工作流读取失败，请检查网络、密钥及权限。",
                                        f"HTTP_{exc.code}") from None
            raise MediaRequestError(f"RunningHub返回HTTP {exc.code}，请到平台核对任务状态后再处理。",
                                    f"HTTP_{exc.code}", submitting and (exc.code >= 500 or exc.code in {408, 429})) from None
        except (URLError, OSError, TimeoutError, ValueError, UnicodeError):
            if endpoint in {ACCOUNT_ENDPOINT, WORKFLOW_ENDPOINT} or endpoint.startswith("/openapi/v2/price-preview/"):
                raise MediaRequestError("RunningHub连接检测或工作流读取未完成，请检查网络后重试。",
                                        "CONNECTION_FAILED") from None
            raise MediaRequestError("RunningHub请求中断或返回无法解析；请核对平台任务与账单，不要直接重复提交。",
                                    "OUTCOME_UNKNOWN" if submitting else "QUERY_FAILED", submitting) from None

    def submit(self, provider: str, request: dict) -> dict:
        spec = self._provider(provider)
        if not isinstance(request, dict):
            raise MediaValidationError("生成请求须为对象")
        if not spec["supportsApi"]:
            raise MediaValidationError("该平台尚未接入API，请使用平台链接")
        if request.get("confirmCost") is not True:
            raise MediaValidationError("提交前须明确确认本次预计费用和预算")
        if self._mode(request) == "model_api":
            return self._submit_model(provider, request)
        config = self._config(provider)
        key = config.get("apiKey")
        if not key:
            raise MediaValidationError("尚未配置RunningHub API Key")
        estimate = self.estimate(provider, request)
        if not estimate["known"]:
            raise MediaValidationError("费用未知；请先填写本次工作流的单价估算")
        if estimate["budget"] is None:
            raise MediaValidationError("请填写本次允许的预算")
        if not estimate["withinBudget"]:
            raise MediaValidationError("本次估价超过预算，未提交生成")
        if request.get("estimateToken") != estimate["estimateToken"]:
            raise MediaValidationError("请先重新估价并确认；工作流、节点或费用参数已变化")
        payload = self._execution(config, request)
        if not payload["workflowId"]:
            raise MediaValidationError("请填写要运行的workflowId")
        payload["apiKey"] = key
        response = self._post(CREATE_ENDPOINT, payload, key, True)
        if response.get("code") != 0:
            code = self._redact(response.get("code", "UNKNOWN"), key)
            if "code" not in response:
                raise MediaRequestError("提交响应缺少状态码，无法确认是否已创建任务。", "OUTCOME_UNKNOWN", True)
            message = self._redact(response.get("msg"), key)
            raise MediaRequestError(f"RunningHub拒绝任务（{code}）：{message}", code, False)
        data = response.get("data")
        if not isinstance(data, dict) or not data.get("taskId"):
            raise MediaRequestError("平台响应缺少任务ID，无法确认提交结果；请到平台核对。", "OUTCOME_UNKNOWN", True)
        task_id = str(data["taskId"])
        if key in task_id:
            raise MediaRequestError("平台返回的任务ID包含敏感内容，请到平台核对。", "OUTCOME_UNKNOWN", True)
        try:
            _identifier(task_id, "taskId")
        except MediaValidationError:
            raise MediaRequestError("平台返回了无法识别的任务ID，请到平台核对。", "OUTCOME_UNKNOWN", True) from None
        provider_status = self._redact(data.get("taskStatus", "UNKNOWN"), key).upper()
        status = self._status(provider_status)
        error = {"code": "TASK_FAILED", "message": "平台返回任务失败，请在平台查看详情。"} if status == "failed" else None
        return {"provider": provider, "task_id": task_id, "providerStatus": provider_status,
                "status": status, "outputs": [], "error": error,
                "estimate": estimate, "billingUrl": spec["billingUrl"],
                "evidence": {"endpoint": CREATE_ENDPOINT, "responseCode": 0, "taskId": task_id}}

    def job_metadata(self, provider: str, request: dict) -> dict:
        """Safe execution snapshot, persisted before a possibly billable call."""
        mode = self._mode(request)
        if mode == "model_api":
            spec, parameters, *_ = self._model_context(provider, request)
            return {"mode": mode, "modelId": spec["id"], "name": spec["name"],
                    "mediaKind": spec["mediaKind"], "parameters": parameters}
        return {"mode": mode, "workflowId": request.get("workflowId") or "",
                "parameters": {key: deepcopy(request[key]) for key in
                               ("nodeInfoList", "quantity", "unitPrice", "unit", "currency", "budget") if key in request}}

    def _submit_model(self, provider: str, request: dict) -> dict:
        if not isinstance(request.get("estimateToken"), str) or not request["estimateToken"]:
            raise MediaValidationError("请先取得官方模型报价，再确认提交")
        with self._lock:
            estimate = self._estimate_model(provider, request)  # Cached only: no second quote request.
            if estimate["budget"] is None:
                raise MediaValidationError("请填写本次允许的预算")
            if not estimate["withinBudget"]:
                raise MediaValidationError("本次官方估价超过预算，未提交生成")
            spec, parameters, key, version, _, binding = self._model_context(provider, request)
            quote = self._model_quotes.get(request["estimateToken"])
            if not quote or quote["binding"] != binding or quote["expires"] <= time.monotonic():
                raise MediaValidationError("模型报价已过期或配置已变化，请重新估价并确认")
            self._assert_same_credentials(provider, key, version, "model_api")
            # Claim once before sending, including uncertain outcomes. The HTTP
            # requestId record handles duplicate delivery of this same request.
            # Freeze the quoted credentials while holding the configuration lock.
            self._model_quotes.pop(request["estimateToken"])
        response = self._post(spec["endpoint"], parameters, key, True, model_specification=spec)
        task_id = response.get("taskId")
        if not task_id and (response.get("errorCode") not in (None, "", 0, "0") or response.get("errorMessage")):
            raise MediaRequestError(self._model_rejection_message(response, key), "MODEL_REJECTED")
        try:
            if not task_id or key in str(task_id):
                raise MediaValidationError("invalid task ID")
            task_id = _identifier(str(task_id), "taskId")
        except MediaValidationError:
            raise MediaRequestError("平台未返回有效任务编号，结果未知；请到平台核对，勿重复提交。", "OUTCOME_UNKNOWN", True) from None
        try:
            result = self._normalize_result(provider, task_id, response, key, spec["endpoint"])
        except MediaRequestError:
            # A task exists even if its initial outputs cannot be parsed.
            result = {"provider": provider, "task_id": task_id, "status": "unknown", "providerStatus": "UNKNOWN",
                      "outputs": [], "error": {"code": "INVALID_OUTPUTS", "message": "已取得任务编号，产物待查询核对。"},
                      "evidence": {"endpoint": spec["endpoint"], "taskId": task_id}}
        result.update(mode="model_api", modelId=spec["id"], name=spec["name"], mediaKind=spec["mediaKind"],
                      parameters=parameters, estimate=estimate)
        return result

    @staticmethod
    def _status(status: str) -> str:
        return {"QUEUED": "queued", "PENDING": "queued", "RUNNING": "running",
                "SUCCESS": "succeeded", "SUCCEEDED": "succeeded", "FAILED": "failed",
                "FAILURE": "failed", "CANCELLED": "cancelled", "CANCELED": "cancelled"}.get(status, "unknown")

    def poll(self, provider: str, task_id: str, mode: str = "workflow_api", model_id: str | None = None) -> dict:
        spec = self._provider(provider)
        if not spec["supportsApi"]:
            raise MediaValidationError("该平台尚未接入API")
        task_id = _identifier(task_id, "taskId")
        mode = self._mode({"mode": mode})
        key, _ = self._credentials(provider, mode)
        # History remains queryable even after an endpoint is retired. Only a
        # caller's persisted job model can attribute query evidence to a model.
        model = model_spec(model_id) if mode == "model_api" and model_id else None
        response = self._post(QUERY_ENDPOINT, {"taskId": task_id}, key, False, model_specification=model)
        result = self._normalize_result(provider, task_id, response, key, QUERY_ENDPOINT)
        result["mode"] = mode
        return result

    def _normalize_result(self, provider: str, task_id: str, response: dict, key: str, endpoint: str) -> dict:
        spec = self._provider(provider)
        if response.get("taskId") is not None and str(response["taskId"]) != task_id:
            raise MediaRequestError("平台返回的任务ID与查询对象不一致，未采用结果。", "TASK_ID_MISMATCH")
        provider_status = self._redact(response.get("status", "UNKNOWN"), key).upper()
        results = response.get("results")
        if results is not None and not isinstance(results, list):
            raise MediaRequestError("平台返回的产物列表格式异常，未采用结果。", "INVALID_OUTPUTS")
        outputs, text_outputs, ignored, text_chars = [], [], 0, 0
        for item in results or []:
            if not isinstance(item, dict):
                ignored += 1
                continue
            accepted_text = False
            raw_text = item.get("text")
            if (isinstance(raw_text, str) and raw_text.strip() and len(text_outputs) < MAX_TEXT_OUTPUTS
                    and text_chars < MAX_TOTAL_TEXT_OUTPUT_CHARS):
                # Provider text, including JSON strings, is inert content. Do
                # not parse objects, execute markup, or promote links to media.
                redacted = raw_text.replace(key, "[REDACTED]") if key else raw_text
                limit = min(MAX_TEXT_OUTPUT_CHARS, MAX_TOTAL_TEXT_OUTPUT_CHARS - text_chars)
                text_outputs.append({"text": redacted[:limit],
                                     "outputType": self._redact(item.get("outputType", "text"), key)[:80],
                                     "truncated": len(redacted) > limit})
                text_chars += len(text_outputs[-1]["text"])
                accepted_text = True
            if not _safe_url(item.get("url")):
                if item.get("url") not in (None, "") or not accepted_text:
                    ignored += 1
                continue
            url = item["url"]
            # A provider must not accidentally return the API key in a link.
            if key in url:
                ignored += 1
                continue
            outputs.append({"url": url, "outputType": self._redact(item.get("outputType", "unknown"), key)[:80],
                            "storage": "provider", "downloaded": False})
        error = None
        if response.get("errorCode") not in (None, "", 0, "0") or response.get("errorMessage"):
            error = {"code": self._redact(response.get("errorCode"), key),
                     "message": self._redact(response.get("errorMessage"), key)}
        return {"provider": provider, "task_id": task_id, "providerStatus": provider_status,
                "status": self._status(provider_status), "outputs": outputs,
                "textOutputs": text_outputs, "error": error,
                "ignoredOutputs": ignored, "actualCost": None, "billingUrl": spec["billingUrl"],
                "evidence": {"endpoint": endpoint, "taskId": task_id,
                             "outputCount": len(outputs), "textOutputCount": len(text_outputs),
                             "downloaded": False}}

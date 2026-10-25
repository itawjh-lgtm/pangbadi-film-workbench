"""Loopback-only HTTP server. No runtime files or credentials are served statically."""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import mimetypes
import os
import secrets
import signal
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

from .roles import RoleCatalog
from .provider import CodexProvider
from .runtime import InputError, Runtime, identifier, now
from .workspace import Workspace, MAX_BYTES
from .production import ProductionManager
from .media import MediaRequestError, MediaValidationError, external_media_fields, media_event, media_metadata

ROOT = Path(__file__).resolve().parents[1]


class StudioServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, runtime, media=None):
        self.runtime, self.media = runtime, media
        self.workspace = Workspace(runtime) if runtime else None
        self.csrf = secrets.token_urlsafe(32)
        self.media_locks = {}
        super().__init__(address, Handler)
        self.production = ProductionManager(runtime) if runtime else None

    def server_close(self):
        if getattr(self, "production", None):
            self.production.close()
        super().server_close()


class Handler(BaseHTTPRequestHandler):
    server_version = "DreamStudio/0.6"

    def log_message(self, fmt, *args):
        # Access paths only; request bodies, model text and credentials never enter logs.
        if self.command != "GET" or self.path.startswith("/api/health"):
            super().log_message(fmt, *args)

    def send(self, status, data, mime="application/json; charset=utf-8", extra=None):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8") if isinstance(data, (dict, list)) else data
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "SAMEORIGIN")
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def guard(self, write=False):
        port = self.server.server_port
        allowed = {f"127.0.0.1:{port}", f"localhost:{port}"}
        host = self.headers.get("Host", "")
        if host not in allowed:
            raise InputError("只允许本机工作台访问。", 403)
        origin = self.headers.get("Origin")
        if origin and origin != "http://" + host:
            raise InputError("拒绝跨来源访问。", 403)
        if self.headers.get("Sec-Fetch-Site") == "cross-site":
            raise InputError("拒绝跨站访问。", 403)
        if write and not secrets.compare_digest(self.headers.get("X-Studio-Token", ""), self.server.csrf):
            raise InputError("页面连接已过期，请刷新后重试。", 403)

    def read_json(self, maximum=1_000_000):
        if self.headers.get("Content-Type", "").split(";")[0] != "application/json":
            raise InputError("仅支持 JSON 请求。", 415)
        try:
            size = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            raise InputError("请求长度无效。")
        if not 0 < size <= maximum:
            raise InputError(f"请求过大，请拆分资料（上限 {maximum // 1_000_000} MB）。", 413)
        try:
            data = json.loads(self.rfile.read(size))
        except (ValueError, UnicodeDecodeError):
            raise InputError("JSON 格式无效。")
        if not isinstance(data, dict):
            raise InputError("请求必须是 JSON 对象。")
        return data

    def do_GET(self):
        self.handle_request(False)

    def do_POST(self):
        self.handle_request(True)

    def handle_request(self, write):
        try:
            self.guard(write)
            parsed = urlsplit(self.path)
            path, runtime = unquote(parsed.path), self.server.runtime
            parts = path.strip("/").split("/")
            if write:
                self.post(path, parts, self.read_json(MAX_BYTES if path == "/api/workspace" else 1_000_000))
            elif path == "/api/health":
                provider = runtime.provider.health()
                self.send(200, {"ok": True, "service": "dream-studio-runtime", "version": "0.6", "projectId": hashlib.sha256(str(ROOT.resolve()).encode()).hexdigest()[:24], "pid": os.getpid(), "workspaceSync": True, "csrfToken": self.server.csrf, "provider": provider, "capabilities": {"text": provider.get("available", False) and provider.get("authenticated", False), "files": True, "images": False, "video": False, "mediaConfiguration": self.server.media is not None, "workspaceSync": True, "automaticCollaboration": True}})
            elif path == "/api/service-status":
                # Desktop startup must not wait for the provider's authentication probe.
                self.send(200, {"ok": True, "service": "dream-studio-runtime", "version": "0.6", "projectId": hashlib.sha256(str(ROOT.resolve()).encode()).hexdigest()[:24], "pid": os.getpid(), "activeRunCount": sum(run.get("status") not in ("succeeded", "failed", "cancelled", "interrupted") for run in runtime.all("run")), "activeProductionCount": sum(plan.get("status") == "running" for plan in runtime.all("production")), "pendingMediaCount": sum(job.get("status") not in ("succeeded", "failed", "cancelled") for job in runtime.all("media"))})
            elif path == "/api/workspace":
                self.send(200, {"workspace": self.server.workspace.read()})
            elif path == "/api/productions":
                query = parse_qs(parsed.query)
                project = query.get("projectId", [None])[0]
                if not identifier(project) or len(query.get("projectId", [])) != 1:
                    raise InputError("请指定一个有效项目。")
                self.send(200, {"productions": self.server.production.list(project)})
            elif len(parts) == 3 and parts[:2] == ["api", "productions"]:
                if not identifier(parts[2]):
                    raise InputError("制作计划编号无效。")
                self.send(200, {"production": self.server.production.get(parts[2])})
            elif path == "/api/roles":
                self.send(200, {"roles": runtime.catalog.list_roles()})
            elif len(parts) == 3 and parts[:2] == ["api", "roles"]:
                try:
                    role = runtime.catalog.get_role(parts[2])
                    instructions = runtime.catalog.build_instructions(parts[2])
                except (KeyError, ValueError) as error:
                    raise InputError(str(error), 404)
                self.send(200, {"role": role, "instructions": instructions})
            elif path == "/api/runs":
                query = parse_qs(parsed.query)
                peer, project = query.get("peerId", [None])[0], query.get("projectId", [None])[0]
                if bool(peer) == bool(project) or not identifier(peer or project):
                    raise InputError("请指定一个有效的项目或工位。")
                self.send(200, {"runs": runtime.all("run", "peer:" + peer if peer else "project:" + project)})
            elif len(parts) == 3 and parts[:2] == ["api", "runs"]:
                self.send(200, {"run": runtime.get("run", parts[2])})
            elif len(parts) == 3 and parts[:2] == ["api", "artifacts"]:
                artifact = runtime.artifact(parts[2])
                self.send(200, artifact["body"].encode("utf-8"), "text/plain; charset=utf-8", {"Content-Disposition": 'attachment; filename="' + artifact["filename"] + '"', "Content-Security-Policy": "sandbox; default-src 'none'"})
            elif path == "/api/connections":
                self.send(200, self.server.media.catalog() if self.server.media else {"providers": []})
            elif path == "/api/media/jobs":
                self.send(200, {"jobs": runtime.all("media")})
            elif len(parts) == 4 and parts[:3] == ["api", "media", "jobs"]:
                self.send(200, {"job": runtime.get("media", parts[3])})
            elif path.startswith("/api/"):
                raise InputError("接口不存在。", 404)
            else:
                self.static(path)
        except InputError as error:
            self.send(error.status, {"error": str(error)})
        except Exception as error:
            # Media/provider exceptions must expose only curated public messages.
            if error.__class__.__module__.endswith(".media"):
                self.send(400, {"error": str(error)[:500]})
            else:
                self.send(500, {"error": "执行服务处理失败；原有记录保留，请查看服务日志。"})
                import traceback
                traceback.print_exc()

    def post(self, path, parts, data):
        runtime, media = self.server.runtime, self.server.media
        if path == "/api/workspace":
            self.send(200, {"workspace": self.server.workspace.save(data)})
        elif path == "/api/runs":
            self.send(202, {"run": runtime.start(data)})
        elif path == "/api/productions":
            self.send(202, {"production": self.server.production.start(data)})
        elif len(parts) == 4 and parts[:2] == ["api", "productions"] and parts[3] in ("pause", "resume", "review"):
            if not identifier(parts[2]):
                raise InputError("制作计划编号无效。")
            operation = getattr(self.server.production, parts[3])
            self.send(200, {"production": operation(parts[2], data)})
        elif len(parts) == 4 and parts[:2] == ["api", "runs"] and parts[3] == "cancel":
            self.send(200, {"run": runtime.cancel(parts[2])})
        elif len(parts) == 3 and parts[:2] == ["api", "connections"] and media:
            self.send(200, {"connection": media.configure(parts[2], data)})
        elif len(parts) == 4 and parts[:2] == ["api", "connections"] and parts[3] == "verify" and media:
            if data:
                raise InputError("请先保存连接配置，再测试已保存的密钥。")
            self.send(200, {"verification": media.verify(parts[2])})
        elif len(parts) == 4 and parts[:2] == ["api", "connections"] and parts[3] == "workflow" and media:
            if set(data) != {"workflowId"}:
                raise InputError("请只提供要读取的工作流 ID 或链接。")
            self.send(200, {"workflow": media.workflow(parts[2], data["workflowId"])})
        elif path == "/api/media/estimate" and media:
            self.send(200, {"estimate": media.estimate(data.get("provider"), data)})
        elif path == "/api/media/jobs" and media:
            self.submit_media(data)
        elif path == "/api/media/import":
            self.import_media(data)
        elif len(parts) == 5 and parts[:3] == ["api", "media", "jobs"] and parts[4] == "refresh" and media:
            self.refresh_media(parts[3])
        else:
            raise InputError("接口不存在。", 404)

    def submit_media(self, data):
        runtime, media = self.server.runtime, self.server.media
        if not identifier(data.get("requestId")):
            raise InputError("缺少有效请求编号。")
        if data.get("projectId") is not None and not identifier(data["projectId"]):
            raise InputError("关联项目编号无效。")
        metadata = media_metadata(data)
        digest = hashlib.sha256(json.dumps(data, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
        # Persist before the external call: uncertain outcomes never auto-retry.
        with runtime.lock:
            prior = runtime.by_request("media", data["requestId"])
            if prior:
                if prior.get("requestHash") != digest:
                    raise InputError("同一个请求编号不可修改参数后重用。", 409)
                self.send(200, {"job": prior})
                return
            estimate = media.estimate(data.get("provider"), data)
            timestamp = now()
            job = {"id": uuid.uuid4().hex, "requestId": data["requestId"], "requestHash": digest, "provider": data.get("provider"), "projectId": data.get("projectId"), "status": "submitting", "estimate": estimate, "createdAt": timestamp, "updatedAt": timestamp, "outputs": [], "source": "api", **metadata}
            job["workflowId"] = data.get("workflowId") or ""
            job["parameters"] = {key: data[key] for key in ("nodeInfoList", "quantity", "unitPrice", "unit", "currency", "budget") if key in data}
            media_event(job, "created", "本次提交已保存，正在请求生成平台。", timestamp)
            runtime.save("media", job)
        try:
            result = media.submit(data.get("provider"), data)
            job.update(result, updatedAt=now())
            media_event(job, "submitted", "平台已返回任务编号。", job["updatedAt"])
        except Exception as error:
            message = str(error)[:500] if isinstance(error, (MediaRequestError, MediaValidationError)) else "提交处理异常，请到平台核对任务，勿重复提交。"
            job.update(status="unknown" if getattr(error, "outcome_unknown", False) else "failed", error=message, updatedAt=now())
            media_event(job, "submit_error", message, job["updatedAt"])
            runtime.save("media", job)
            raise
        runtime.save("media", job)
        self.send(202, {"job": job})

    def refresh_media(self, job_id):
        runtime, media = self.server.runtime, self.server.media
        if not identifier(job_id):
            raise InputError("媒体任务编号无效。")
        # Serialize provider reads for one job, without blocking unrelated jobs
        # or keeping SQLite's shared lock across a network request.
        with runtime.lock:
            lock = self.server.media_locks.setdefault(job_id, threading.Lock())
        with lock:
            job = runtime.get("media", job_id)
            if job.get("source") == "external":
                raise InputError("这是手动登记的外部结果；请在来源平台查看生成过程。", 409)
            if not job.get("task_id"):
                raise InputError("暂无平台任务编号；请到平台核对，避免重复扣费。", 409)
            # A create response can already say SUCCESS but contain no outputs.
            # Query it once; completed query results then remain stable.
            if job.get("lastSuccessfulCheckAt") and job.get("status") in {"succeeded", "failed", "cancelled"}:
                self.send(200, {"job": job})
                return
            prior_status, prior_outputs = job.get("status"), job.get("outputs", [])
            timestamp = now()
            try:
                result = media.poll(job["provider"], job["task_id"])
            except (MediaRequestError, MediaValidationError) as error:
                message = str(error)[:500]
                if job.get("lastRefreshError") != message:
                    media_event(job, "refresh_error", message, timestamp)
                job.update(checkedAt=timestamp, lastRefreshError=message)
                runtime.save("media", job)
                self.send(200, {"job": job})
                return
            recovered = bool(job.get("lastRefreshError"))
            job.update(result, checkedAt=timestamp, lastSuccessfulCheckAt=timestamp, updatedAt=timestamp)
            job.pop("lastRefreshError", None)
            if prior_status != job["status"]:
                labels = {"queued": "平台排队中。", "running": "平台正在生成。", "succeeded": "平台报告生成完成。", "failed": "平台报告生成失败。", "cancelled": "平台任务已取消。", "unknown": "平台返回了暂无法识别的状态。"}
                media_event(job, "status", labels.get(job["status"], "平台状态已更新。"), timestamp)
            if prior_outputs != job.get("outputs") and job.get("outputs"):
                media_event(job, "outputs", f"收到 {len(job['outputs'])} 个平台结果链接，可在预览窗查看。", timestamp)
            if recovered:
                media_event(job, "refresh_recovered", "已重新获取平台状态。", timestamp)
            runtime.save("media", job)
            self.send(200, {"job": job})

    def import_media(self, data):
        runtime = self.server.runtime
        if not identifier(data.get("requestId")) or not identifier(data.get("projectId")):
            raise InputError("请提供有效的请求编号和关联项目编号。")
        fields = external_media_fields(data)
        digest = hashlib.sha256(json.dumps({"operation": "import", "data": data}, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
        with runtime.lock:
            prior = runtime.by_request("media", data["requestId"])
            if prior:
                if prior.get("requestHash") != digest:
                    raise InputError("同一个请求编号不可修改参数后重用。", 409)
                self.send(200, {"job": prior})
                return
            timestamp = now()
            job = {"id": uuid.uuid4().hex, "requestId": data["requestId"], "requestHash": digest,
                   "projectId": data["projectId"], "createdAt": timestamp, "updatedAt": timestamp, **fields}
            media_event(job, "imported", "已手动登记外部结果链接；未验证生成过程、链接有效性或画面质量，链接可能过期。", timestamp)
            runtime.save("media", job)
        self.send(201, {"job": job})

    def static(self, path):
        relative = path.lstrip("/") or "index.html"
        if any(segment in (".", "..") or segment.startswith(".") for segment in relative.split("/")):
            raise InputError("文件不存在。", 404)
        permitted = relative in ("index.html", "app.js", "styles.css") or relative.startswith(("assets/", "styles/", "lib/")) or relative in ("data/employees.js", "data/project-templates.js")
        target = (ROOT / relative).resolve()
        if not permitted or ROOT not in target.parents or not target.is_file():
            raise InputError("文件不存在。", 404)
        for ancestor in (ROOT / relative, *(ROOT / relative).parents):
            if ancestor == ROOT:
                break
            if ancestor.is_symlink():
                raise InputError("文件不存在。", 404)
        self.send(200, target.read_bytes(), mimetypes.guess_type(target.name)[0] or "application/octet-stream")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8767)
    parser.add_argument("--data-dir", type=Path, default=ROOT / "data" / "runtime")
    args = parser.parse_args()
    args.data_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    lockfile = (args.data_dir / ".service.lock").open("a")
    try:
        fcntl.flock(lockfile.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise SystemExit("该数据目录已有工作台服务在运行，未更改任何执行记录。")
    # Bind before recovery: a port conflict must not mutate active runs.
    server = StudioServer(("127.0.0.1", args.port), None)
    runtime = None
    try:
        runtime = Runtime(args.data_dir, RoleCatalog(), CodexProvider())
        from .media import MediaRegistry
        server.runtime = runtime
        server.workspace = Workspace(runtime)
        server.media = MediaRegistry(config_path=args.data_dir / "connections.json")
        server.production = ProductionManager(runtime)
    except Exception:
        server.server_close()
        lockfile.close()
        raise
    print(f"造梦工作室执行服务 http://127.0.0.1:{args.port}", flush=True)
    def stop_service(signum, frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, stop_service)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.production.close()
        runtime.close()
        server.server_close()
        lockfile.close()


if __name__ == "__main__":
    main()

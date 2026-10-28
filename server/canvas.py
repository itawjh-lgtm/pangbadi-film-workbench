"""Project canvases and explicitly confirmed, persistent media batches.

Only estimate() requests prices. Only a persisted generate() confirmation may
dispatch new tasks. Recovery polls known task IDs but never replays submission.
"""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
import hashlib
import json
import math
import re
import threading
import time
import uuid

from .runtime import InputError, identifier, now
from .storyboard import IMPORT_VERSION, LINK_FIELDS, _project, media_project_metadata, project_storyboard
from .media_models import model_spec, DEFAULT_CN_IMAGE_MODEL, DEFAULT_CN_IMAGE_EDIT_MODEL, DEFAULT_CN_IMAGE_PARAMETERS, IMAGE_RATIOS
from .trash import is_deleted, require_visible
from .project_assets import character_drafts, required_character_ids, image_output
from .reference_images import ReferenceImageStore


MAX_BATCH = 24
MAX_NODES = 1000
MAX_CANVAS_BYTES = 3_000_000
ACTIVE = {"pending", "submitting", "queued", "running"}
TERMINAL = {"succeeded", "failed", "cancelled", "unknown", "needs_requote", "needs_attention"}
DEFAULT_MODELS = {"image": DEFAULT_CN_IMAGE_MODEL,
                  "video": "bytedance/seedance-2.5-token/text-to-video"}
SHOT_VIDEO_MODEL = "bytedance/seedance-2.5-token/image-to-video"
CHARACTER_IMAGE_MODEL = DEFAULT_CN_IMAGE_EDIT_MODEL
WORKFLOW_VERSION = 3
MODEL_MIGRATION_VERSION = 1
# Former automatic defaults. The edit member moves with the default family;
# this is not evidence that the edit endpoint is retired.
FORMER_DEFAULT_IMAGE_MODELS = {
    "rhart-image-g-2-official/text-to-image", "rhart-image-g-2-official/image-to-image",
    "rhart-image-n-pro-official/text-to-image-ultra", "rhart-image-n-pro-official/edit-ultra",
}
EDITABLE = {"id", "mediaKind", "title", "shotId", "sourceArtifactId", "promptArtifactId", "taskId",
            "prompt", "modelId", "parameters", "parameterDraft", "position", "selected",
            "stylePreset", "referenceNodeId", "sourceVersion", "promptField", "optimization",
            "nodeKind", "assetId", "characterAssetIds", "modelSelectionOrigin", "referenceImages"}
REFERENCE_PURPOSES = {"appearance": "人物长相", "clothing": "服装造型", "composition": "构图",
                      "style": "画面风格", "general": "综合参考"}
MAX_REFERENCE_IMAGES = 10


def _hash(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, allow_nan=False).encode()).hexdigest()


def _error(error):
    if isinstance(error, InputError) or error.__class__.__module__.endswith(".media"):
        return str(error)[:800]
    return "执行服务处理失败，已保留记录；请检查本机服务后再处理。"


def _budget(value):
    try:
        number = Decimal(str(value)) if type(value) in (int, float, str) else Decimal("NaN")
    except InvalidOperation:
        number = Decimal("NaN")
    if not number.is_finite() or number <= 0:
        raise InputError("请填写大于零的本批预算。")
    return number


def _expired(value):
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")) <= datetime.now(timezone.utc)
    except (AttributeError, TypeError, ValueError):
        return True


class CanvasManager:
    def __init__(self, runtime, workspace, media, *, poll_interval=5, start_worker=True):
        self.runtime, self.workspace, self.media = runtime, workspace, media
        self.references = ReferenceImageStore(runtime, workspace, media)
        self.poll_interval = max(.01, float(poll_interval))
        self._stop, self._wake = threading.Event(), threading.Event()
        self._step_lock = threading.Lock()
        self._thread = None
        self._recover()
        if start_worker:
            self._thread = threading.Thread(target=self._loop, name="studio-canvas", daemon=True)
            self._thread.start()

    def _check(self, project_id):
        if self._stop.is_set() or self.runtime.closed:
            raise InputError("执行服务正在停止，请重新连接后继续。", 503)
        require_visible(self.runtime, "project", project_id, project_id)
        project, state = _project(self.workspace, project_id)
        if project.get("isDemo"):
            raise InputError("示例项目不创建真实媒体画布，请先创建自己的项目。")
        return project, state

    def _stored(self, project_id):
        try:
            return self.runtime.get("canvas", project_id)
        except InputError as error:
            if error.status != 404:
                raise
            return {"id": project_id, "projectId": project_id, "revision": 0,
                    "sourceRevision": "", "nodes": [], "viewport": {"x": 0, "y": 0, "scale": 1},
                    "updatedAt": now()}

    def _board(self, project_id):
        board = project_storyboard(self.runtime, self.workspace, project_id)
        plans = sorted(self.runtime.all("production", "project:" + project_id),
                       key=lambda plan: plan.get("createdAt", 0), reverse=True)
        plan = plans[0] if plans else None
        stages = {stage.get("id"): stage for stage in (plan or {}).get("stages", [])}
        delivery = stages.get("delivery", {})
        review = delivery.get("review") or {}
        accepted = {artifact.get("id") for stage in (plan or {}).get("stages", [])
                    if stage.get("id") in ("storyboard", "prompts") and stage.get("status") == "completed"
                    for artifact in stage.get("artifacts", [])}
        confirmed = bool(plan and plan.get("status") == "completed" and board["sources"]
                         and not is_deleted(self.runtime, "production", plan["id"], project_id)
                         and all(not is_deleted(self.runtime, "artifact", artifact_id, project_id) for artifact_id in accepted)
                         and all(stage.get("status") == "completed" for stage in stages.values())
                         and review.get("action") == "approve" and review.get("reviewer") == "user"
                         and delivery.get("outputArtifactIds")
                         and set(review.get("artifactIds", [])) == set(delivery["outputArtifactIds"])
                         and all(stages.get(phase, {}).get("artifacts") and stages.get(phase, {}).get("outputArtifactIds")
                                 and set(stages[phase]["outputArtifactIds"]) == {artifact.get("id") for artifact in stages[phase]["artifacts"]}
                                 for phase in ("storyboard", "prompts"))
                         and all(source["id"] in accepted for source in board["sources"]))
        board["confirmed"] = confirmed
        board["productionId"] = plan.get("id") if plan else None
        board["sourceRevision"] = _hash({"productionId": plan["id"],
            "storyboard": stages["storyboard"]["outputArtifactIds"],
            "prompts": stages["prompts"]["outputArtifactIds"]}) if confirmed else ""
        if not confirmed:
            board["shots"] = []
            board["warnings"] = [*board["warnings"], "团队文字成果尚未完成总策划确认，确认后会自动落入画布。"]
        return board

    @staticmethod
    def _parameters(model_id, prompt, shot=None):
        spec = model_spec(model_id)
        values = {**deepcopy(spec.get("defaults", {})), "prompt": prompt}
        fields = spec["schema"]["properties"]
        if model_id in {DEFAULT_CN_IMAGE_MODEL, DEFAULT_CN_IMAGE_EDIT_MODEL}:
            values.update(deepcopy(DEFAULT_CN_IMAGE_PARAMETERS))
            # Explicit pixel dimensions preserve the project's aspect ratio.
            # This provider gives resolution precedence over width/height.
            values.pop("resolution", None)
        if shot:
            ratios = {r for r in re.findall(r"(?<!\d)(\d{1,2}:\d{1,2})(?!\d)",
                       shot.get("imagePrompt", "")) if r in IMAGE_RATIOS}
            if not ratios and shot.get("aspectRatio") in IMAGE_RATIOS:
                ratios = {shot["aspectRatio"]}
            if len(ratios) == 1:
                ratio = next(iter(ratios))
                for field in ("aspectRatio", "ratio"):
                    if ratio in fields.get(field, {}).get("enum", []):
                        values[field] = ratio
                if "width" in fields and "height" in fields:
                    w, h = map(int, ratio.split(":"))
                    values["width"] = round(2048 * w / max(w, h) / 16) * 16
                    values["height"] = round(2048 * h / max(w, h) / 16) * 16
            duration = shot.get("targetDuration")
            durations = sorted((float(v), v) for v in fields.get("duration", {}).get("enum", [])
                               if re.fullmatch(r"\d+(?:\.\d+)?", str(v)) and float(v) > 0)
            if duration and durations:
                values["duration"] = next((v for seconds, v in durations if seconds >= duration), durations[-1][1])
        return values

    def _sync_assets(self, canvas):
        source = character_drafts(self.runtime, canvas["projectId"])
        assets = canvas.setdefault("characterAssets", [])
        existing = {a["id"] for a in assets}
        changed, added = False, False
        for draft in source["assets"]:
            if draft["id"] in existing:
                continue
            node_id = "asset-" + _hash(draft["id"])[:24]
            if is_deleted(self.runtime, "canvas_node", node_id, canvas["projectId"]):
                continue
            if len(canvas["nodes"]) >= MAX_NODES:
                break
            asset = {**deepcopy(draft), "nodeId": node_id, "status": "draft", "history": [], "createdAt": now()}
            assets.append(asset)
            parameters = self._parameters(DEFAULT_MODELS["image"], draft["prompt"])
            if "width" in parameters:
                parameters.update(width=1536, height=2048)
            next_x = max((n.get("position", {}).get("x", -360) for n in canvas["nodes"]), default=-360) + 360
            canvas["nodes"].append({"id": node_id, "nodeKind": "character", "assetId": asset["id"],
                "mediaKind": "image", "title": asset["name"] + " · 人物定妆", "prompt": asset["prompt"],
                "sourceArtifactId": asset["sourceArtifactId"], "sourceVersion": asset["sourceVersion"],
                "modelId": DEFAULT_MODELS["image"], "modelSelectionOrigin": "default", "parameters": parameters, "parameterDraft": {},
                "characterAssetIds": [],
                "position": {"x": next_x, "y": 0}, "selected": True, "jobIds": [], "status": "draft"})
            changed = True
            added = True
        if added:
            for node in canvas["nodes"]:
                if node.get("nodeKind") == "shot" or (node.get("nodeKind") == "character" and
                        node.get("sourceVersion") and node["sourceVersion"] != source["sourceVersion"]):
                    node["selected"] = False
        if canvas.get("assetSourceVersion", "") != source["sourceVersion"]:
            canvas["assetSourceVersion"] = source["sourceVersion"]
            changed = True
        return changed, source

    def _sync(self, canvas, board):
        changed, asset_source = self._sync_assets(canvas)
        current_assets = [a for a in canvas["characterAssets"] if a.get("manual") or a.get("sourceVersion") == asset_source["sourceVersion"]]
        sync_shots = board["confirmed"] and (canvas.get("sourceRevision") != board["sourceRevision"]
            or canvas.get("importVersion") != IMPORT_VERSION or canvas.get("importBlocked")
            or canvas.get("workflowVersion") != WORKFLOW_VERSION)
        blocked, full = set(), False
        if sync_shots:
            migrated, blocked = self._migrate_truncated_shots(canvas, board)
            changed = changed or migrated
            existing = {node["id"] for node in canvas["nodes"]}
            next_x = max((n.get("position", {}).get("x", -360) for n in canvas["nodes"]), default=-360) + 720
            for index, shot in enumerate(board["shots"]):
                asset_ids = required_character_ids(shot, current_assets)
                for kind in ("image", "video"):
                    if (shot["id"].split("-")[0], kind) in blocked:
                        continue
                    node_id = "shot-" + _hash([shot["id"], board["sourceRevision"], kind])[:24]
                    if node_id in existing or is_deleted(self.runtime, "canvas_node", node_id, canvas["projectId"]):
                        continue
                    if len(canvas["nodes"]) >= MAX_NODES:
                        full = True
                        continue
                    prompt = shot.get("imagePrompt" if kind == "image" else "videoPrompt", "")
                    model_id = SHOT_VIDEO_MODEL if kind == "video" else CHARACTER_IMAGE_MODEL if asset_ids else DEFAULT_MODELS["image"]
                    item = {"id": node_id, "nodeKind": "shot", "mediaKind": kind,
                        "title": (shot["id"] + " · " + shot.get("title", shot["id"]) + (" · 图片" if kind == "image" else " · 视频"))[:160],
                        "shotId": shot["id"], "sourceArtifactId": shot["sourceArtifactId"], "promptArtifactId": shot.get("promptArtifactId"),
                        "sourceVersion": board["sourceRevision"], "targetDuration": shot.get("targetDuration"),
                        "prompt": prompt, "modelId": model_id, "modelSelectionOrigin": "default", "parameters": self._parameters(model_id, prompt, shot),
                        "parameterDraft": {}, "characterAssetIds": asset_ids,
                        "position": {"x": next_x + index * 360, "y": 0 if kind == "image" else 440},
                        "selected": kind == "image" and not current_assets, "jobIds": [], "status": "draft"}
                    if kind == "video":
                        item["referenceNodeId"] = "shot-" + _hash([shot["id"], board["sourceRevision"], "image"])[:24]
                    canvas["nodes"].append(item)
                    changed = True
            canvas.update(sourceRevision=canvas.get("sourceRevision", "") if full else board["sourceRevision"],
                          importVersion=IMPORT_VERSION, importBlocked=bool(blocked))
        if board["confirmed"] and canvas.get("workflowVersion") != WORKFLOW_VERSION:
            shots = {shot["id"]: shot for shot in board["shots"]}
            jobs = self.runtime.all("media", "project:" + canvas["projectId"])
            for node in canvas["nodes"]:
                if node.get("sourceVersion") != board["sourceRevision"] or node.get("shotId") not in shots:
                    continue
                shot = shots[node["shotId"]]
                asset_ids = required_character_ids(shot, current_assets)
                node.setdefault("migrationHistory", []).append({"at": now(), "reason": "人物资产优先制作", "node": deepcopy(node)})
                node.update(nodeKind="shot", characterAssetIds=asset_ids)
                if node["mediaKind"] == "video" and node.get("modelId") == DEFAULT_MODELS["video"]:
                    old = {**node.get("parameters", {}), **node.get("parameterDraft", {})}
                    node.update(modelId=SHOT_VIDEO_MODEL, parameters=self._parameters(SHOT_VIDEO_MODEL, node.get("prompt", ""), shot), parameterDraft={},
                                referenceNodeId="shot-" + _hash([shot["id"], board["sourceRevision"], "image"])[:24])
                    allowed = model_spec(SHOT_VIDEO_MODEL)["schema"]["properties"]
                    node["parameters"].update({k: v for k, v in old.items() if k in allowed and k not in {"ratio", "firstFrameUrl", "lastFrameUrl"}})
                if current_assets:
                    node["selected"] = False
            canvas["workflowVersion"] = WORKFLOW_VERSION
            changed = True
        if board["confirmed"]:
            shots = {shot["id"]: shot for shot in board["shots"]}
            for node in canvas["nodes"]:
                if (node.get("nodeKind") == "shot" and node["mediaKind"] == "video" and
                        node.get("sourceVersion") == board["sourceRevision"] and node.get("shotId") in shots):
                    required = required_character_ids(shots[node["shotId"]], current_assets)
                    combined = list(dict.fromkeys([*required, *node.get("characterAssetIds", [])]))
                    if combined != node.get("characterAssetIds", []):
                        node["characterAssetIds"] = combined
                        changed = True
        changed = self._migrate_default_models(canvas, board) or changed
        if canvas.get("layoutVersion") != WORKFLOW_VERSION:
            groups = list(dict.fromkeys((n.get("sourceVersion", ""), n.get("shotId")) for n in canvas["nodes"] if n.get("shotId")))
            character_nodes = [n for n in canvas["nodes"] if n.get("nodeKind") == "character"]
            for node in canvas["nodes"]:
                if node.get("nodeKind") == "character":
                    position = {"x": character_nodes.index(node) * 360, "y": 0}
                elif node.get("shotId"):
                    position = {"x": (len(character_nodes) + groups.index((node.get("sourceVersion", ""), node["shotId"])) + 1) * 360,
                                "y": 0 if node["mediaKind"] == "image" else 440}
                else:
                    continue
                node.setdefault("positionSnapshot", deepcopy(node.get("position", {})))
                node["layoutPosition"] = deepcopy(position)
                node["position"] = position
            canvas["layoutVersion"] = WORKFLOW_VERSION
            changed = True
        if full:
            board["warnings"].append("画布已达到节点上限，请整理历史节点后重新同步当前分镜。")
        board["warnings"].extend(asset_source["warnings"])
        if changed:
            canvas.update(revision=canvas["revision"] + 1, updatedAt=now())
            self.runtime.save("canvas", canvas)

    def _migrate_default_models(self, canvas, board):
        """Update only idle automatic defaults, retaining full pre-migration data."""
        changed = False
        jobs = self.runtime.all("media", "project:" + canvas["projectId"])
        batches = self.runtime.all("canvas_batch", "project:" + canvas["projectId"])
        shots = {shot["id"]: shot for shot in board["shots"]}
        jobs_by_id = {job["id"]: job for job in jobs}
        for node in canvas["nodes"]:
            if (node.get("mediaKind") != "image" or node.get("modelId") not in FORMER_DEFAULT_IMAGE_MODELS
                    or node.get("nodeKind") not in {"character", "shot"}
                    or node.get("modelSelectionOrigin") == "user"
                    or is_deleted(self.runtime, "canvas_node", node["id"], canvas["projectId"])):
                continue
            related = [job for job in jobs if job.get("canvasNodeId") == node["id"] or job["id"] in node.get("jobIds", [])]
            # A missing linked record or an ambiguous/active submission is not
            # proof of a failed task; keep it intact for recovery.
            if (any(job_id not in jobs_by_id for job_id in node.get("jobIds", []))
                    or any(job.get("status") != "failed" for job in related)
                    or node.get("status", "draft") not in {"draft", "failed"}
                    or any(item.get("nodeId") == node["id"] and item.get("status") in ACTIVE | {"unknown", "needs_attention"}
                           for batch in batches for item in batch.get("items", []))):
                continue
            original = deepcopy(node)
            previous = {**node.get("parameters", {}), **node.get("parameterDraft", {})}
            model_id = (CHARACTER_IMAGE_MODEL if node.get("nodeKind") == "shot" and node.get("characterAssetIds")
                        else DEFAULT_MODELS["image"])
            shot = deepcopy(shots.get(node.get("shotId"), {}))
            ratio = previous.get("aspectRatio") or previous.get("ratio")
            if ratio in IMAGE_RATIOS:
                shot = {"aspectRatio": ratio}
            elif node.get("nodeKind") == "character":
                shot = {"aspectRatio": "3:4"}
            parameters = self._parameters(model_id, node.get("prompt", ""), shot)
            allowed = model_spec(model_id)["schema"]["properties"]
            parameters.update({key: deepcopy(value) for key, value in previous.items()
                               if key in allowed and key not in {"prompt", "resolution", "width", "height"}})
            if all(type(previous.get(key)) is int and 240 <= previous[key] <= 8192 for key in ("width", "height")):
                parameters.update(width=previous["width"], height=previous["height"])
            node.setdefault("migrationHistory", []).append({"at": now(), "reason": "中国站默认图片模型更新",
                "modelMigrationVersion": MODEL_MIGRATION_VERSION, "node": original})
            node.update(modelId=model_id, modelSelectionOrigin="default", parameters=parameters,
                        parameterDraft={}, modelMigrationVersion=MODEL_MIGRATION_VERSION)
            changed = True
        if canvas.get("modelMigrationVersion") != MODEL_MIGRATION_VERSION:
            canvas["modelMigrationVersion"] = MODEL_MIGRATION_VERSION
            changed = True
        return changed

    def _migrate_truncated_shots(self, canvas, board):
        """Retain old drafts and archive only the exact untouched parser output.

        A prior parser read S01-001 as S01. Its blank automatic node is not a
        user's shot. Keep a full recoverable snapshot of it, while preserving
        anything edited, generated, quoted, referenced, or already trashed.
        """
        shots = {shot["id"]: shot for shot in board["shots"]}
        roots = list(dict.fromkeys(shot["id"].split("-")[0] for shot in board["shots"]))
        jobs = self.runtime.all("media", "project:" + canvas["projectId"])
        batches = self.runtime.all("canvas_batch", "project:" + canvas["projectId"])
        changed, blocked, kept = False, set(), []
        for node in canvas["nodes"]:
            root, kind = node.get("shotId"), node.get("mediaKind")
            descendants = [shot for shot in board["shots"] if shot["id"].startswith(str(root) + "-")]
            candidate = (root not in shots and descendants and kind in DEFAULT_MODELS
                         and node.get("sourceVersion") == board["sourceRevision"]
                         and node.get("id") == "shot-" + _hash([root, board["sourceRevision"], kind])[:24])
            if not candidate:
                kept.append(node)
                continue
            if is_deleted(self.runtime, "canvas_node", node["id"], canvas["projectId"]):
                blocked.add((root, kind))
                kept.append(node)
                continue
            first = descendants[0]
            old_title = first["id"].split("-", 1)[1] + "／" + first.get("sourceTitle", first["id"])
            expected_title = root + " · " + old_title + (" · 图片" if kind == "image" else " · 视频")
            linked = (node.get("jobIds") or any(job.get("canvasNodeId") == node["id"] or
                      (job.get("shotId") == root and job.get("mediaKind") == kind
                       and job.get("sourceArtifactId") == node.get("sourceArtifactId")) for job in jobs)
                      or any(item.get("nodeId") == node["id"] for batch in batches for item in batch.get("items", []))
                      or any(other.get("referenceNodeId") == node["id"] for other in canvas["nodes"]))
            old_position = {"x": roots.index(root) * 370, "y": 0 if kind == "image" else 380}
            untouched_position = (node.get("position") == old_position or
                                  node.get("position") == node.get("layoutPosition") and node.get("positionSnapshot") == old_position)
            legacy_model = "rhart-image-g-2-official/text-to-image" if kind == "image" else DEFAULT_MODELS[kind]
            untouched = (not linked and node.get("status", "draft") == "draft" and node.get("prompt") == ""
                         and node.get("parameters") == {"prompt": ""} and node.get("modelId") in {DEFAULT_MODELS[kind], legacy_model}
                         and node.get("title") == expected_title
                         and untouched_position
                         and node.get("selected") is (kind == "image")
                         and not any(node.get(field) for field in ("parameterDraft", "stylePreset", "referenceNodeId", "referenceImages", "optimization", "taskId")))
            if untouched:
                canvas.setdefault("importArchive", []).append({"node": deepcopy(node), "archivedAt": now(),
                    "reason": "分层镜号解析修复：已保留原空节点快照", "importVersion": IMPORT_VERSION})
                changed = True
            else:
                if not node.get("legacy"):
                    node.update(legacy=True, legacyReason="旧解析镜号，已保留你的编辑或生成记录；请使用完整镜号的新节点。")
                    changed = True
                kept.append(node)
        canvas["nodes"] = kept
        if blocked:
            board["warnings"].append("旧镜号节点在回收站中，对应的新镜头未自动重新导入；恢复旧节点后可继续同步。")
        return changed, blocked

    def get(self, project_id):
        with self.runtime.lock:
            self._check(project_id)
            canvas, board = self._stored(project_id), self._board(project_id)
            self._sync(canvas, board)
            jobs = {job["id"]: job for job in self.runtime.all("media", "project:" + project_id)
                    if not is_deleted(self.runtime, "media", job["id"], project_id)}
            self._adopt_jobs(canvas, jobs)
            self._asset_views(canvas, jobs)
            canvas["nodes"] = [node for node in canvas["nodes"]
                               if not is_deleted(self.runtime, "canvas_node", node["id"], project_id)]
            canvas["storyboard"] = board
            visible_ids = {node["id"] for node in canvas["nodes"]}
            for node in canvas["nodes"]:
                node["referenceMissing"] = bool(node.get("referenceNodeId") and node["referenceNodeId"] not in visible_ids)
                node["sourceMissing"] = any(is_deleted(self.runtime, "artifact", node.get(field), project_id)
                                            for field in ("sourceArtifactId", "promptArtifactId") if node.get(field))
                if node["referenceMissing"]:
                    board["warnings"].append(node.get("title", node["id"]) + " 的参考图片节点已移入回收站，请恢复或重新选择。")
                if node["sourceMissing"]:
                    board["warnings"].append(node.get("title", node["id"]) + " 的来源文稿已移入回收站，恢复前不能生成。")
                expected_source = canvas.get("assetSourceVersion") if node.get("nodeKind") == "character" else board["sourceRevision"]
                node["stale"] = bool(node.get("sourceVersion") and node["sourceVersion"] != expected_source)
                latest = next((jobs[job_id] for job_id in reversed(node.get("jobIds", [])) if job_id in jobs), None)
                if latest:
                    node.update(status=latest["status"], error=latest.get("error"), outputs=latest.get("outputs", []),
                                textOutputs=latest.get("textOutputs", []), lastJobId=latest["id"])
            canvas["batches"] = self.history(project_id)
            return canvas

    def _asset_views(self, canvas, jobs):
        nodes = {node["id"]: node for node in canvas["nodes"]}
        assets = []
        for original in canvas.get("characterAssets", []):
            if is_deleted(self.runtime, "canvas_node", original["nodeId"], canvas["projectId"]):
                continue
            asset = deepcopy(original)
            node = nodes.get(asset["nodeId"], {})
            asset.update(name=node.get("title", asset["name"]).removesuffix(" · 人物定妆"), prompt=node.get("prompt", asset["prompt"]))
            asset["referenceUsable"] = False
            if asset.get("sourceVersion") and asset["sourceVersion"] != canvas.get("assetSourceVersion"):
                asset["status"] = "stale"
            elif asset.get("sourceArtifactId") and is_deleted(self.runtime, "artifact", asset["sourceArtifactId"], canvas["projectId"]):
                asset["status"] = "missing"
            else:
                if asset.get("confirmedAt"):
                    try:
                        url = self._asset_reference(canvas, original)
                        asset.update(status="ready", referenceUrl=url, referenceUsable=True)
                    except InputError as error:
                        asset.update(status="missing" if "回收站" in str(error) or "过期" in str(error) else "stale", error=str(error))
                else:
                    asset["status"] = "draft"
                baseline = asset.get("candidateBaselineJobIds")
                if baseline is None:
                    # Old confirmations predate the candidate baseline. Earlier
                    # jobs remain history; later successful jobs need a choice.
                    ids = node.get("jobIds", [])
                    index = ids.index(asset["referenceJobId"]) + 1 if asset.get("referenceJobId") in ids else 0
                    baseline = [*ids[:index], asset.get("referenceJobId")]
                candidates = [candidate for candidate in self._character_candidates(canvas, node, jobs)
                              if candidate["jobId"] not in baseline]
                if candidates:
                    asset.update(status="pending_review", reviewCandidate=candidates[-1])
            assets.append(asset)
        canvas["characterAssets"] = assets

    def _character_candidates(self, canvas, node, jobs):
        if not node:
            return []
        current_hash = _hash(self._execution_node(node))
        ordered = list(dict.fromkeys([*node.get("jobIds", []), *jobs]))
        candidates = []
        for job_id in ordered:
            job = jobs.get(job_id, {})
            if (job.get("projectId") != canvas["projectId"] or job.get("canvasNodeId") != node["id"] or
                    job.get("canvasNodeHash") != current_hash or job.get("status") != "succeeded"):
                continue
            for output_index in range(len(job.get("outputs", []))):
                try:
                    url = image_output(job, output_index)
                except InputError:
                    continue
                candidates.append({"jobId": job_id, "outputIndex": output_index, "url": url})
                break
        return candidates

    def _asset_reference(self, canvas, asset):
        project_id = canvas["projectId"]
        require_visible(self.runtime, "canvas_node", asset["nodeId"], project_id)
        if asset.get("sourceArtifactId"):
            require_visible(self.runtime, "artifact", asset["sourceArtifactId"], project_id)
        source = character_drafts(self.runtime, project_id)
        if asset.get("sourceVersion") and asset["sourceVersion"] != source["sourceVersion"]:
            raise InputError(asset["name"] + " 的人物设定原稿已更新，请确认新版人物图片。", 409)
        if not asset.get("confirmedAt") or not identifier(asset.get("referenceJobId")):
            raise InputError("请先生成并确认人物：" + asset["name"] + "。", 409)
        require_visible(self.runtime, "media", asset["referenceJobId"], project_id)
        job = self.runtime.get("media", asset["referenceJobId"])
        node = next((node for node in canvas["nodes"] if node["id"] == asset["nodeId"]), None)
        if (job.get("projectId") != project_id or job.get("canvasNodeId") != asset["nodeId"]
                or not node or asset.get("confirmedNodeHash") != _hash(self._execution_node(node))):
            raise InputError(asset["name"] + " 的人物提示词或参数已修改，请重新生成并确认。", 409)
        url = image_output(job, asset.get("referenceOutputIndex"))
        if url != asset.get("referenceUrl"):
            raise InputError(asset["name"] + " 的图片输出已变化，请重新确认。", 409)
        return url

    def add_asset(self, project_id, data):
        with self.runtime.lock:
            self._check(project_id)
            canvas = self._stored(project_id)
            if type(data.get("expectedRevision")) is not int or data["expectedRevision"] != canvas["revision"]:
                raise InputError("画布已更新，请刷新后新增人物。", 409)
            if len(canvas["nodes"]) >= MAX_NODES or len(canvas.get("characterAssets", [])) >= 100:
                raise InputError("人物或画布节点已达上限，请整理后再添加。")
            name, description, prompt = data.get("name"), data.get("description", ""), data.get("prompt")
            if not isinstance(name, str) or not name.strip() or len(name) > 120:
                raise InputError("人物名称须为 1 至 120 字。")
            if not isinstance(description, str) or len(description) > 15000:
                raise InputError("人物说明不能超过 15000 字。")
            if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 20000:
                raise InputError("请填写不超过 20000 字的人物提示词。")
            asset_id, node_id = "character-" + uuid.uuid4().hex, "asset-" + uuid.uuid4().hex
            asset = {"id": asset_id, "nodeId": node_id, "name": name.strip(), "description": description,
                     "prompt": prompt, "manual": True, "sourceVersion": "", "status": "draft", "version": 1,
                     "aliases": [name.strip()], "history": [], "createdAt": now()}
            canvas.setdefault("characterAssets", []).append(asset)
            for node in canvas["nodes"]:
                if node.get("nodeKind") == "shot":
                    node["selected"] = False
            parameters = self._parameters(DEFAULT_MODELS["image"], prompt)
            if "width" in parameters:
                parameters.update(width=1536, height=2048)
            canvas["nodes"].append({"id": node_id, "nodeKind": "character", "assetId": asset_id, "mediaKind": "image",
                "title": name.strip() + " · 人物定妆", "prompt": prompt, "modelId": DEFAULT_MODELS["image"], "modelSelectionOrigin": "default",
                "parameters": parameters, "parameterDraft": {}, "characterAssetIds": [], "position": {"x": -360 * len(canvas["characterAssets"]), "y": 0},
                "selected": True, "jobIds": [], "status": "draft"})
            canvas.update(revision=canvas["revision"] + 1, updatedAt=now())
            self.runtime.save("canvas", canvas)
            return self.get(project_id)

    def _validated_asset_confirmation(self, project_id, canvas, item):
        asset = next((a for a in canvas.get("characterAssets", []) if a["id"] == item["assetId"]), None)
        if not asset or not identifier(item.get("jobId")):
            raise InputError("人物或图片任务不存在。", 404)
        require_visible(self.runtime, "canvas_node", asset["nodeId"], project_id)
        if asset.get("sourceArtifactId"):
            require_visible(self.runtime, "artifact", asset["sourceArtifactId"], project_id)
        if asset.get("sourceVersion") and asset["sourceVersion"] != character_drafts(self.runtime, project_id)["sourceVersion"]:
            raise InputError("此人物原稿已更新，请确认当前版本。", 409)
        require_visible(self.runtime, "media", item["jobId"], project_id)
        job = self.runtime.get("media", item["jobId"])
        node = next((n for n in canvas["nodes"] if n["id"] == asset["nodeId"]), None)
        if (job.get("projectId") != project_id or job.get("canvasNodeId") != asset["nodeId"] or not node
                or job.get("canvasNodeHash") != _hash(self._execution_node(node))):
            raise InputError("这张图不属于当前人物草稿，请选择对应版本的真实生成图片。", 409)
        url = image_output(job, item.get("outputIndex"))
        return asset, node, {"referenceJobId": job["id"], "referenceOutputIndex": item["outputIndex"],
                            "referenceUrl": url, "confirmedNodeHash": _hash(self._execution_node(node))}

    def confirm_asset(self, project_id, asset_id, data):
        return self.confirm_assets(project_id, {"expectedRevision": data.get("expectedRevision"),
            "items": [{"assetId": asset_id, "jobId": data.get("jobId"), "outputIndex": data.get("outputIndex")}]})

    def confirm_assets(self, project_id, data):
        """Validate the full review selection before committing one canvas record."""
        with self.runtime.lock:
            self._check(project_id)
            canvas = self._stored(project_id)
            if type(data.get("expectedRevision")) is not int or data["expectedRevision"] != canvas["revision"]:
                raise InputError("画布已更新，请查看当前人物图片后再确认。", 409)
            items = data.get("items")
            if (not isinstance(items, list) or not 1 <= len(items) <= 100 or
                    any(not isinstance(item, dict) or not identifier(item.get("assetId")) for item in items) or
                    len({item["assetId"] for item in items}) != len(items)):
                raise InputError("请选择 1 至 100 个不同人物的成功图片。")
            checked = [self._validated_asset_confirmation(project_id, canvas, item) for item in items]
            jobs = {job["id"]: job for job in self.runtime.all("media", "project:" + project_id)
                    if not is_deleted(self.runtime, "media", job["id"], project_id)}
            changed = False
            for asset, node, confirmation in checked:
                baseline = [candidate["jobId"] for candidate in self._character_candidates(canvas, node, jobs)]
                if asset.get("confirmedAt") and all(asset.get(key) == value for key, value in confirmation.items()):
                    if baseline != asset.get("candidateBaselineJobIds", []):
                        asset["candidateBaselineJobIds"] = baseline
                        node["selected"] = False
                        changed = True
                    continue
                if asset.get("confirmedAt"):
                    asset.setdefault("history", []).append({key: deepcopy(asset.get(key)) for key in
                        ("version", "referenceJobId", "referenceOutputIndex", "referenceUrl", "confirmedAt", "confirmedNodeHash")})
                    asset["version"] = asset.get("version", 1) + 1
                asset.update(status="ready", confirmedAt=now(), candidateBaselineJobIds=baseline, **confirmation)
                node["selected"] = False
                changed = True
            if changed:
                canvas.update(revision=canvas["revision"] + 1, updatedAt=now())
                self.runtime.save("canvas", canvas)
            return self.get(project_id)

    def _adopt_jobs(self, canvas, jobs):
        """Attach pre-canvas jobs only to the exact project/shot/source version."""
        changed = False
        for node in canvas["nodes"]:
            if not node.get("shotId") or not node.get("sourceArtifactId"):
                continue
            matched = [job["id"] for job in jobs.values()
                       if job.get("projectId") == canvas["projectId"]
                       and job.get("canvasNodeId") in (None, node["id"])
                       and all(job.get(field) == node.get(field) for field in
                               ("shotId", "sourceArtifactId", "promptArtifactId", "mediaKind"))]
            ids = list(dict.fromkeys([*node.get("jobIds", []), *matched]))
            ids.sort(key=lambda job_id: (jobs.get(job_id, {}).get("createdAt", 0), job_id))
            if ids != node.get("jobIds", []):
                node["jobIds"] = ids
                changed = True
        if changed:
            # Job attachment is server-owned state; do not invalidate a user's
            # position/prompt edit revision while generation is progressing.
            self.runtime.save("canvas", canvas)

    def save(self, project_id, data):
        with self.runtime.lock:
            self._check(project_id)
            canvas = self._stored(project_id)
            if type(data.get("expectedRevision")) is not int or data["expectedRevision"] != canvas["revision"]:
                raise InputError("画布已被其他窗口更新，请刷新后重试；当前编辑未覆盖。", 409)
            nodes, viewport = data.get("nodes"), data.get("viewport", canvas["viewport"])
            if not isinstance(nodes, list) or len(nodes) > MAX_NODES or not isinstance(viewport, dict):
                raise InputError("画布节点或视口格式无效。")
            try:
                if len(json.dumps(data, ensure_ascii=False, allow_nan=False).encode()) > MAX_CANVAS_BYTES:
                    raise InputError("画布内容过大，请拆分项目。", 413)
            except (ValueError, TypeError):
                raise InputError("画布包含无效 JSON 值。")
            clean_view = self._position(viewport, viewport=True)
            old = {node["id"]: node for node in canvas["nodes"]}
            clean, ids = [], set()
            for item in nodes:
                if not isinstance(item, dict) or not identifier(item.get("id")) or item["id"] in ids:
                    raise InputError("画布节点编号无效或重复。")
                if item.get("projectId", project_id) != project_id:
                    raise InputError("不能保存其他项目的画布节点。")
                if is_deleted(self.runtime, "canvas_node", item["id"], project_id):
                    # A stale window may still send this node. Keep its last
                    # pre-deletion draft; restoration is an explicit action.
                    ids.add(item["id"])
                    continue
                node = {key: deepcopy(value) for key, value in item.items() if key in EDITABLE}
                ids.add(node["id"])
                if node.get("mediaKind") not in DEFAULT_MODELS:
                    raise InputError("节点类型只支持图片或视频。")
                if "referenceImages" in node:
                    node["referenceImages"] = self._reference_images(project_id, node)
                prior = old.get(node["id"], {})
                node["nodeKind"] = prior.get("nodeKind") or ("shot" if prior.get("shotId") else "free")
                if node["nodeKind"] in {"shot", "character"}:
                    for field in ("shotId", "sourceArtifactId", "promptArtifactId", "sourceVersion"):
                        node.pop(field, None)
                        if field in prior:
                            node[field] = deepcopy(prior[field])
                if prior.get("assetId"):
                    node["assetId"] = prior["assetId"]
                elif node.get("assetId"):
                    raise InputError("请通过新增人物入口创建人物资产。")
                asset_ids = node.get("characterAssetIds", prior.get("characterAssetIds", []))
                if (not isinstance(asset_ids, list) or len(asset_ids) > 10
                        or any(not identifier(value) for value in asset_ids) or len(set(asset_ids)) != len(asset_ids)):
                    raise InputError("每个镜头最多关联 10 个不同人物资产。")
                known_assets = {asset["id"] for asset in canvas.get("characterAssets", [])}
                if any(value not in known_assets for value in asset_ids):
                    raise InputError("引用人物必须属于当前项目。")
                node["characterAssetIds"] = asset_ids
                for field, maximum in (("title", 160), ("prompt", 30000), ("stylePreset", 100), ("sourceVersion", 100), ("promptField", 200)):
                    if field in node and (not isinstance(node[field], str) or len(node[field]) > maximum):
                        raise InputError("节点的" + field + "格式无效或过长。")
                for field in ("parameters", "parameterDraft"):
                    if not isinstance(node.get(field, {}), dict):
                        raise InputError("节点参数须为 JSON 对象。")
                    node.setdefault(field, {})
                if "optimization" in node and (not isinstance(node["optimization"], dict)
                        or len(json.dumps(node["optimization"], ensure_ascii=False)) > 100000):
                    raise InputError("提示词优化记录格式无效或过大。")
                if not isinstance(node.get("modelId", ""), str) or len(node.get("modelId", "")) > 200:
                    raise InputError("模型编号格式无效。")
                node.setdefault("modelId", DEFAULT_MODELS[node["mediaKind"]])
                origin = node.get("modelSelectionOrigin")
                if origin is not None and origin not in {"default", "user"}:
                    raise InputError("模型选择来源格式无效。")
                if (prior.get("modelSelectionOrigin") == "user" or origin == "user"
                        or prior and node["modelId"] != prior.get("modelId")):
                    node["modelSelectionOrigin"] = "user"
                elif prior.get("modelSelectionOrigin"):
                    node["modelSelectionOrigin"] = prior["modelSelectionOrigin"]
                elif not prior:
                    node["modelSelectionOrigin"] = "user" if item.get("modelId") else "default"
                else:
                    node.pop("modelSelectionOrigin", None)
                node.setdefault("title", "图片节点" if node["mediaKind"] == "image" else "视频节点")
                node.setdefault("prompt", "")
                node["position"] = self._position(node.get("position", {"x": 0, "y": 0}))
                if type(node.get("selected", False)) is not bool:
                    raise InputError("节点选择状态须为开关值。")
                node.setdefault("selected", False)
                # Saving historical drafts checks ownership, not latest-shot freshness.
                context = {key: node[key] for key in ("taskId", "sourceArtifactId", "promptArtifactId") if node.get(key)}
                media_project_metadata(self.runtime, self.workspace, {"projectId": project_id, **context}, allow_deleted_sources=True)
                if node.get("shotId") is not None and not identifier(node["shotId"]):
                    raise InputError("镜号格式无效。")
                node["jobIds"] = deepcopy(old.get(node["id"], {}).get("jobIds", []))
                node["status"] = old.get(node["id"], {}).get("status", "draft")
                for field in ("targetDuration", "legacy", "legacyReason", "migrationHistory", "modelMigrationVersion", "positionSnapshot", "layoutPosition"):
                    if field in old.get(node["id"], {}):
                        node[field] = deepcopy(old[node["id"]][field])
                clean.append(node)
            clean.extend(deepcopy(node) for node in old.values()
                         if node["id"] not in ids or is_deleted(self.runtime, "canvas_node", node["id"], project_id))
            by_id = {node["id"]: node for node in clean}
            for node in clean:
                ref = node.get("referenceNodeId")
                if ref and (ref not in by_id or ref == node["id"] or by_id[ref]["mediaKind"] != "image"):
                    raise InputError("参考节点须为同一画布中的其他图片节点。")
            canvas.update(nodes=clean, viewport=clean_view, revision=canvas["revision"] + 1, updatedAt=now())
            self.runtime.save("canvas", canvas)
            return self.get(project_id)

    @staticmethod
    def _position(value, viewport=False):
        if not isinstance(value, dict):
            raise InputError("节点位置格式无效。")
        result = {}
        for key in ("x", "y", "scale") if viewport else ("x", "y"):
            item = value.get(key, 1 if key == "scale" else 0)
            if type(item) not in (int, float) or not math.isfinite(item) or abs(item) > 1_000_000:
                raise InputError("画布位置或缩放无效。")
            if key == "scale" and not .05 <= item <= 5:
                raise InputError("画布缩放应在 5% 至 500% 之间。")
            result[key] = item
        return result

    def _character_reference_inputs(self, project_id, canvas, node):
        asset_ids = list(node.get("characterAssetIds", []))
        if node.get("shotId"):
            board = self._board(project_id)
            shot = next((shot for shot in board["shots"] if shot["id"] == node["shotId"]), {})
            source_version = character_drafts(self.runtime, project_id)["sourceVersion"]
            active_assets = [asset for asset in canvas.get("characterAssets", []) if asset.get("manual") or
                             asset.get("sourceVersion") == source_version or not source_version]
            asset_ids = list(dict.fromkeys([*required_character_ids(shot, active_assets), *asset_ids]))
        if len(asset_ids) > 10:
            raise InputError("本镜头引用人物超过模型的 10 张参考图上限，请拆分镜头。")
        references, snapshots = [], []
        for asset_id in asset_ids:
            asset = next((a for a in canvas.get("characterAssets", []) if a["id"] == asset_id), None)
            if not asset:
                raise InputError("引用人物不存在，请选择当前项目人物。", 409)
            references.append(self._asset_reference(canvas, asset))
            snapshots.append({"assetId": asset_id, **{key: deepcopy(asset.get(key)) for key in
                ("version", "sourceVersion", "referenceJobId", "referenceOutputIndex", "referenceUrl", "confirmedNodeHash")}})
        return list(dict.fromkeys(references)), snapshots

    def _reference_images(self, project_id, node):
        """Keep node-owned upload IDs; never accept client-supplied remote URLs."""
        entries = node.get("referenceImages", [])
        if not isinstance(entries, list) or len(entries) > MAX_REFERENCE_IMAGES:
            raise InputError("每个图片节点最多添加 10 张参考图。")
        if entries and node.get("mediaKind") != "image":
            raise InputError("参考图窗口用于图片或人物资产；视频请使用已生成图片作为首帧。")
        result, seen = [], set()
        for entry in entries:
            if not isinstance(entry, dict) or not identifier(entry.get("id")) or entry["id"] in seen:
                raise InputError("参考图片编号无效或重复。")
            purpose, note = entry.get("purpose", "general"), entry.get("note", "")
            if not isinstance(purpose, str) or purpose not in REFERENCE_PURPOSES:
                raise InputError("请选择有效的参考用途。")
            if not isinstance(note, str) or len(note) > 1000:
                raise InputError("每张参考图的说明最多 1000 字。")
            metadata = self.references.validate(project_id, node["id"], entry["id"])
            result.append({"id": metadata["id"], "name": metadata["name"], "purpose": purpose, "note": note})
            seen.add(entry["id"])
        return result

    @staticmethod
    def _reference_limit(spec):
        field = next((field for field in spec["fields"] if field["name"] == "imageUrls"), None)
        if field is None:
            raise InputError("当前模型不支持多图参考，请选择支持参考图的图生图模型。", 409)
        schema = spec.get("schema", {}).get("properties", {}).get("imageUrls", {})
        return schema.get("maxItems", field.get("maxItems", MAX_REFERENCE_IMAGES))

    @staticmethod
    def _check_reference_count(spec, count):
        maximum = CanvasManager._reference_limit(spec)
        if count > maximum:
            raise InputError(f"当前模型最多支持 {maximum} 张参考图（包含已确认人物）；请减少参考图或更换模型。", 409)

    @staticmethod
    def _reference_instructions(entries, image_urls, urls):
        if not entries:
            return ""
        lines = ["【参考图片使用说明】", "按输入图片的顺序使用以下参考，只借鉴所标注的要素，其他内容以本次画面提示词为准。"]
        for entry, url in zip(entries, urls):
            number = image_urls.index(url) + 1
            line = f"参考图 {number}：{REFERENCE_PURPOSES[entry['purpose']]}。"
            if entry["note"].strip():
                line += "用户说明：" + entry["note"].strip()
            lines.append(line)
        return "\n\n" + "\n".join(lines)

    def _request(self, project_id, node, budget, currency=None):
        require_visible(self.runtime, "canvas_node", node["id"], project_id)
        request = {"provider": "runninghub", "mode": "model_api", "projectId": project_id,
                   "modelId": node["modelId"], "mediaKind": node["mediaKind"], "name": node["title"],
                   "quantity": 1, "parameters": deepcopy(node.get("parameters", {}))}
        if budget is not None:
            request["budget"] = float(budget)
        if currency:
            request["currency"] = currency
        for key in ("taskId", "shotId", "sourceArtifactId", "promptArtifactId"):
            if node.get(key):
                request[key] = node[key]
        if node.get("sourceVersion") and node.get("nodeKind") == "character":
            if node["sourceVersion"] != character_drafts(self.runtime, project_id)["sourceVersion"]:
                raise InputError("人物设定原稿已更新或尚未确认，请使用当前人物版本。", 409)
        elif node.get("sourceVersion"):
            board = self._board(project_id)
            if node["sourceVersion"] != board["sourceRevision"]:
                raise InputError("此节点引用的分镜版本尚未确认或已更新，请选择当前已确认节点。", 409)
        media_project_metadata(self.runtime, self.workspace, request)
        try:
            spec = model_spec(node["modelId"])
        except ValueError as error:
            raise InputError(str(error)) from None
        if spec["mediaKind"] != node["mediaKind"]:
            raise InputError("模型与节点的图片/视频类型不一致。")
        fields = {field["name"] for field in spec["fields"]}
        if "prompt" in fields and "prompt" not in request["parameters"]:
            request["parameters"]["prompt"] = node.get("prompt", "")
        canvas = self._stored(project_id)
        references, reference_snapshot = self._character_reference_inputs(project_id, canvas, node)
        user_references = self._reference_images(project_id, node)
        user_urls = []
        if reference_snapshot:
            request["characterReferenceSnapshot"] = reference_snapshot
            if node["mediaKind"] == "image":
                if "imageUrls" not in fields:
                    raise InputError("此镜头需要复用已确认人物，请选择支持参考图的图生图模型。", 409)
                request["parameters"]["imageUrls"] = references
        if user_references:
            self._check_reference_count(spec, len(references) + len(user_references))
            user_urls = self.references.urls(project_id, node["id"], [entry["id"] for entry in user_references])
            request["parameters"]["imageUrls"] = list(dict.fromkeys([*references, *user_urls]))
        reference_id = node.get("referenceNodeId")
        if node.get("nodeKind") == "shot" and node.get("mediaKind") == "video":
            if "firstFrameUrl" not in fields and "imageUrl" not in fields:
                raise InputError("请先完成本镜头图片，再使用图生视频模型制作视频。", 409)
            reference_id = reference_id or "shot-" + _hash([node["shotId"], node.get("sourceVersion"), "image"])[:24]
        if reference_id:
            require_visible(self.runtime, "canvas_node", reference_id, project_id)
            jobs = {job["id"]: job for job in self.runtime.all("media", "project:" + project_id)
                    if not is_deleted(self.runtime, "media", job["id"], project_id)}
            self._adopt_jobs(canvas, jobs)
            reference = next((item for item in canvas["nodes"] if item["id"] == reference_id and item["mediaKind"] == "image"), None)
            if reference is None:
                raise InputError("参考图片节点已不存在。", 409)
            if (node.get("nodeKind") == "shot" and node["mediaKind"] == "video" and
                    (reference.get("shotId") != node.get("shotId") or reference.get("sourceVersion") != node.get("sourceVersion"))):
                raise InputError("视频需要使用本镜头当前版本的分镜图片，请先生成对应图片。", 409)
            missing = next((field for field in ("firstFrameUrl", "imageUrl", "imageUrls") if field in fields), None)
            if missing:
                for field in ("sourceArtifactId", "promptArtifactId"):
                    if reference.get(field):
                        require_visible(self.runtime, "artifact", reference[field], project_id)
                required_urls, required_snapshot = self._character_reference_inputs(project_id, canvas, reference)
                image = None
                for job_id in reversed(reference.get("jobIds", [])):
                    job = jobs.get(job_id, {})
                    if (job.get("status") != "succeeded" or job.get("projectId") != project_id
                            or job.get("canvasNodeId") not in (None, reference["id"])):
                        continue
                    if job.get("canvasNodeHash") and job["canvasNodeHash"] != _hash(self._execution_node(reference)):
                        continue
                    if reference.get("referenceImages") and job.get("canvasNodeHash") != _hash(self._execution_node(reference)):
                        continue
                    generated_urls = job.get("parameters", {}).get("imageUrls", [])
                    character_inputs_match = (isinstance(generated_urls, list) and
                        (generated_urls[:len(required_urls)] == required_urls if reference.get("referenceImages")
                         else generated_urls == required_urls))
                    if required_snapshot and (job.get("canvasNodeHash") != _hash(self._execution_node(reference)) or
                            job.get("characterReferenceSnapshot") != required_snapshot or
                            not character_inputs_match):
                        continue
                    for index in range(len(job.get("outputs", []))):
                        try:
                            image = image_output(job, index)
                            break
                        except InputError:
                            continue
                    if image:
                        break
                if not image:
                    raise InputError("本镜头尚无当前版本的成功图片，请先生成分镜图片，再生成视频。", 409)
                request["parameters"][missing] = (list(dict.fromkeys([*request["parameters"].get("imageUrls", []), image]))
                                                    if missing == "imageUrls" else image)
        if node["mediaKind"] == "image" and request["parameters"].get("imageUrls"):
            self._check_reference_count(spec, len(request["parameters"]["imageUrls"]))
        if user_references:
            if "prompt" not in fields:
                raise InputError("当前模型不支持参考用途说明，请选择支持提示词的图生图模型。", 409)
            if not isinstance(request["parameters"].get("prompt", ""), str):
                raise InputError("画面提示词须为文字。")
            request["parameters"]["prompt"] = request["parameters"].get("prompt", "") + self._reference_instructions(
                user_references, request["parameters"]["imageUrls"], user_urls)
        return request

    @staticmethod
    def _execution_node(node):
        result = {key: value for key, value in node.items() if key in EDITABLE - {"position", "selected", "modelSelectionOrigin"}}
        result.setdefault("characterAssetIds", [])
        result.setdefault("nodeKind", "shot" if node.get("shotId") else "free")
        # Empty upload lists and display names do not invalidate pre-existing
        # generation/character confirmations. IDs, order, purposes and notes do.
        if result.get("referenceImages"):
            result["referenceImages"] = [{key: value for key, value in entry.items() if key != "name"}
                                         for entry in result["referenceImages"]]
        else:
            result.pop("referenceImages", None)
        return result

    @staticmethod
    def _execution_request(request):
        return {key: value for key, value in request.items() if key not in {"requestId", "estimateToken", "confirmCost"}}

    def estimate(self, project_id, data):
        budget = _budget(data["budget"]) if data.get("budget") is not None else None
        ids = data.get("nodeIds")
        if not isinstance(ids, list) or not 1 <= len(ids) <= MAX_BATCH or any(not identifier(item) for item in ids) or len(set(ids)) != len(ids):
            raise InputError(f"每批请选择 1 至 {MAX_BATCH} 个不同节点。")
        with self.runtime.lock:
            self._check(project_id)
            canvas = self._stored(project_id)
            if data.get("expectedRevision", canvas["revision"]) != canvas["revision"]:
                raise InputError("画布已变化，请保存最新编辑后再估价。", 409)
            nodes = {node["id"]: node for node in canvas["nodes"]}
            if any(node_id not in nodes for node_id in ids):
                raise InputError("部分节点不属于当前项目画布。")
            selected = [deepcopy(nodes[node_id]) for node_id in ids]
            preparations, character_snapshots = [], {}
            for node in selected:
                uploads = self._reference_images(project_id, node)
                characters, snapshot = self._character_reference_inputs(project_id, canvas, node)
                character_snapshots[node["id"]] = snapshot
                if uploads:
                    try:
                        spec = model_spec(node["modelId"])
                    except ValueError as error:
                        raise InputError(str(error)) from None
                    if spec["mediaKind"] != node["mediaKind"]:
                        raise InputError("模型与节点的图片/视频类型不一致。")
                    if not any(field["name"] == "prompt" for field in spec["fields"]):
                        raise InputError("当前模型不支持参考用途说明，请选择支持提示词的图生图模型。", 409)
                    self._check_reference_count(spec, len(characters) + len(uploads) + bool(node.get("referenceNodeId")))
                    preparations.append((node["id"], [entry["id"] for entry in uploads]))
        # Uploads can take seconds. Never hold the workspace's shared lock over
        # provider I/O (the store also acquires its own lock before runtime).
        for node_id, reference_ids in preparations:
            self.references.prepare(project_id, node_id, reference_ids)
        with self.runtime.lock:
            self._check(project_id)
            current_canvas = self._stored(project_id)
            current = {node["id"]: node for node in current_canvas["nodes"]}
            for node in selected:
                require_visible(self.runtime, "canvas_node", node["id"], project_id)
                latest = current.get(node["id"])
                if latest is None or _hash(self._execution_node(latest)) != _hash(self._execution_node(node)):
                    raise InputError("参考图上传期间节点内容已变化，请保存最新内容后重新估价。", 409)
                _, snapshot = self._character_reference_inputs(project_id, current_canvas, latest)
                if snapshot != character_snapshots[node["id"]]:
                    raise InputError("参考图上传期间人物资产已变化，请重新估价。", 409)
            requests = [self._request(project_id, node, budget, data.get("currency")) for node in selected]
        items, total, currency, expiry = [], Decimal(0), None, None
        for node, request in zip(selected, requests):
            quote = self.media.estimate("runninghub", request)
            if not quote.get("known") or not quote.get("expiresAt"):
                raise InputError("部分节点没有有效的官方报价，未允许生成。")
            if currency and currency != quote["currency"]:
                raise InputError("本批包含不同计费币种，请按币种分别生成。")
            currency = quote["currency"]
            cost = Decimal(str(quote["estimatedCost"]))
            if not cost.is_finite() or cost < 0:
                raise InputError("平台报价金额无效。")
            total += cost
            expiry = min(expiry, quote["expiresAt"]) if expiry else quote["expiresAt"]
            request["estimateToken"] = quote["estimateToken"]
            items.append({"nodeId": node["id"], "modelId": node["modelId"], "title": node["title"],
                          "mediaKind": node["mediaKind"], "estimatedCost": float(cost), "currency": currency,
                          "nodeHash": _hash(self._execution_node(node)), "request": request, "quote": quote})
        automatic_budget = budget is None
        if automatic_budget:
            budget = total
            for item in items:
                item["quote"] = self.media.bind_model_quote_budget("runninghub", item["request"], float(total))
                item["request"]["budget"] = float(total)
        estimate = {"id": uuid.uuid4().hex, "projectId": project_id, "nodeIds": ids, "items": items,
                    "estimatedCost": float(total), "totalCost": float(total), "budget": float(budget),
                    "budgetMode": "quoted_total" if automatic_budget else "explicit",
                    "currency": currency, "withinBudget": total <= budget, "expiresAt": expiry,
                    "createdAt": now(), "status": "quoted", "budgetNotice": items[0]["quote"].get("budgetNotice", "")}
        estimate["estimateToken"] = estimate["id"]
        with self.runtime.lock:
            self._check(project_id)
            current = {node["id"]: node for node in self._stored(project_id)["nodes"]}
            for item in items:
                require_visible(self.runtime, "canvas_node", item["nodeId"], project_id)
            if any(item["nodeId"] not in current or item["nodeHash"] != _hash(self._execution_node(current[item["nodeId"]])) for item in items):
                raise InputError("估价期间节点内容已变化，请重新估价。", 409)
            self.runtime.save("canvas_estimate", estimate)
        return self._public_estimate(estimate)

    @staticmethod
    def _public_estimate(estimate):
        result = deepcopy(estimate)
        for item in result["items"]:
            item.pop("request", None)
            item.pop("quote", None)
            item.pop("nodeHash", None)
        return result

    def generate(self, project_id, data):
        if not identifier(data.get("requestId")) or not identifier(data.get("estimateToken")) or data.get("confirmCost") is not True:
            raise InputError("请一次确认本批节点、官方报价和预算后生成。")
        digest = _hash({"projectId": project_id, **data})
        with self.runtime.lock:
            self._check(project_id)
            previous = self.runtime.by_request("canvas_batch", data["requestId"])
            if previous:
                if previous["projectId"] != project_id or previous["requestHash"] != digest:
                    raise InputError("同一个请求编号不能用于其他批次或项目。", 409)
                return self._public_batch(previous)
            estimate = self.runtime.get("canvas_estimate", data["estimateToken"])
            if estimate["projectId"] != project_id:
                raise InputError("报价不属于当前项目。", 403)
            if estimate["status"] != "quoted" or any(batch.get("estimateId") == estimate["id"] for batch in self.runtime.all("canvas_batch")):
                raise InputError("此报价已经确认过，未重复提交。", 409)
            if _expired(estimate["expiresAt"]) or not estimate["withinBudget"]:
                raise InputError("批次报价已过期或总价超出预算，请重新估价。", 409)
            nodes = {node["id"]: node for node in self._stored(project_id)["nodes"]}
            occupied = {item["nodeId"] for batch in self.runtime.all("canvas_batch", "project:" + project_id)
                        for item in batch["items"] if item["status"] in ACTIVE | {"unknown", "needs_attention"}}
            if occupied & set(estimate["nodeIds"]):
                raise InputError("部分节点已有执行中或待核对任务，请先查看已有结果，避免重复生成。", 409)
            for item in estimate["items"]:
                node = nodes.get(item["nodeId"])
                if not node or item["nodeHash"] != _hash(self._execution_node(node)):
                    raise InputError("节点内容或参数已变化，请重新估价后确认。", 409)
                current_request = self._request(project_id, node, estimate["budget"], item["request"].get("currency"))
                if self._execution_request(current_request) != self._execution_request(item["request"]):
                    raise InputError("引用图片等实际生成输入已变化，请重新估价后确认。", 409)
                # A supplied model token is cache-only; never silently reprice.
                self.media.estimate("runninghub", item["request"])
            batch = {"id": uuid.uuid4().hex, "projectId": project_id, "requestId": data["requestId"],
                     "requestHash": digest, "estimateId": estimate["id"], "status": "running", "confirmedAt": now(),
                     "createdAt": now(), "updatedAt": now(), "budget": estimate["budget"],
                     "estimatedCost": estimate["estimatedCost"], "currency": estimate["currency"],
                     "expiresAt": estimate["expiresAt"], "stopRequested": False, "items": []}
            for item in estimate["items"]:
                request = deepcopy(item["request"])
                request.update(confirmCost=True, requestId="canvas-" + uuid.uuid4().hex)
                batch["items"].append({**deepcopy(item), "request": request, "status": "pending", "jobId": None,
                                       "error": None, "lastPollAt": 0, "pollFailures": 0})
            self.runtime.save("canvas_batch", batch)
            estimate.update(status="confirmed", batchId=batch["id"])
            self.runtime.save("canvas_estimate", estimate)
            self._wake.set()
            return self._public_batch(batch)

    @staticmethod
    def _public_batch(batch):
        result = deepcopy(batch)
        for item in result["items"]:
            for key in ("request", "quote", "nodeHash"):
                item.pop(key, None)
        result["counts"] = {status: sum(item["status"] == status for item in result["items"])
                            for status in ACTIVE | TERMINAL}
        return result

    def history(self, project_id):
        self._check(project_id)
        return [self._public_batch(batch) for batch in reversed(self.runtime.all("canvas_batch", "project:" + project_id))][:100]

    def batch(self, project_id, batch_id):
        self._check(project_id)
        batch = self.runtime.get("canvas_batch", batch_id)
        if batch["projectId"] != project_id:
            raise InputError("批次不属于当前项目。", 404)
        return self._public_batch(batch)

    def stop(self, project_id, batch_id):
        with self.runtime.lock:
            self._check(project_id)
            self.batch(project_id, batch_id)
            batch = self.runtime.get("canvas_batch", batch_id)
            batch["stopRequested"] = True
            for item in batch["items"]:
                if item["status"] == "pending":
                    item.update(status="cancelled", error="已停止，未向平台提交。")
            self._save_batch(batch)
            return self._public_batch(batch)

    def _save_batch(self, batch):
        states = {item["status"] for item in batch["items"]}
        batch["status"] = ("running" if states & ACTIVE else "succeeded" if states == {"succeeded"}
                           else "needs_requote" if "needs_requote" in states else "needs_attention" if states & {"unknown", "needs_attention"}
                           else "stopped" if batch.get("stopRequested") else "partial" if "succeeded" in states else "failed")
        batch["updatedAt"] = now()
        self.runtime.save("canvas_batch", batch)

    def _recover(self):
        with self.runtime.lock:
            for batch in self.runtime.all("canvas_batch"):
                for item in batch["items"]:
                    job = self.runtime.by_request("media", item.get("request", {}).get("requestId"))
                    if job and job.get("batchId") == batch["id"]:
                        item["jobId"] = job["id"]
                        item["status"] = "unknown" if job["status"] == "submitting" else job["status"]
                        canvas = self._stored(batch["projectId"])
                        node = next((node for node in canvas["nodes"] if node["id"] == item["nodeId"]), None)
                        if node is not None and job["id"] not in node.setdefault("jobIds", []):
                            node["jobIds"].append(job["id"])
                            self.runtime.save("canvas", canvas)
                    if item["status"] == "pending":
                        item.update(status="needs_requote", error="服务已重启，未提交节点须重新估价并整体确认。")
                    if item["status"] == "submitting":
                        job = self.runtime.get("media", item["jobId"]) if item.get("jobId") else None
                        if job and job.get("task_id"):
                            item["status"] = job["status"]
                        else:
                            item.update(status="unknown", error="服务在提交期间中断，请核对平台记录；不会重复提交。")
                    item["lastPollAt"] = 0
                self._save_batch(batch)

    def _halt_pending(self, batch, message):
        for item in batch["items"]:
            if item["status"] == "pending":
                item.update(status="needs_requote", error=message)

    def _claim(self):
        with self.runtime.lock:
            for batch in self.runtime.all("canvas_batch"):
                if not batch.get("confirmedAt") or batch.get("stopRequested"):
                    continue
                item = next((item for item in batch["items"] if item["status"] == "pending"), None)
                if item is None:
                    continue
                try:
                    self._check(batch["projectId"])
                    if _expired(batch["expiresAt"]):
                        raise InputError("批次报价已过期，尚未提交的节点须重新估价。", 409)
                    current = next((node for node in self._stored(batch["projectId"])["nodes"] if node["id"] == item["nodeId"]), None)
                    if not current or item["nodeHash"] != _hash(self._execution_node(current)):
                        raise InputError("排队节点已被修改，剩余节点须重新估价并确认。", 409)
                    current_request = self._request(batch["projectId"], current, batch["budget"], item["request"].get("currency"))
                    if self._execution_request(current_request) != self._execution_request(item["request"]):
                        raise InputError("引用图片等实际生成输入已变化，剩余节点须重新估价。", 409)
                    self.media.estimate("runninghub", item["request"])
                except Exception as error:
                    self._halt_pending(batch, _error(error))
                    self._save_batch(batch)
                    continue
                request = item["request"]
                metadata = self.media.job_metadata("runninghub", request)
                job = {"id": uuid.uuid4().hex, "requestId": request["requestId"], "requestHash": _hash(request),
                       "provider": "runninghub", "projectId": batch["projectId"], "canvasNodeId": item["nodeId"],
                       "canvasNodeHash": item["nodeHash"],
                       "characterReferenceSnapshot": deepcopy(request.get("characterReferenceSnapshot", [])),
                       "batchId": batch["id"], "status": "submitting", "createdAt": now(), "updatedAt": now(),
                       "estimate": item["quote"], "outputs": [], **metadata}
                job.update(media_project_metadata(self.runtime, self.workspace, request))
                self.runtime.save("media", job)  # Persist before the potentially billable call.
                item.update(status="submitting", jobId=job["id"])
                self._save_batch(batch)
                canvas = self._stored(batch["projectId"])
                node = next((node for node in canvas["nodes"] if node["id"] == item["nodeId"]), None)
                if node:
                    node.setdefault("jobIds", []).append(job["id"])
                    self.runtime.save("canvas", canvas)
                return batch["id"], item["nodeId"], deepcopy(job), deepcopy(request)
        return None

    def _finish_submit(self, claim):
        batch_id, node_id, job, request = claim
        invalid_quote = False
        context = {key: deepcopy(job[key]) for key in (*LINK_FIELDS, "canvasNodeId", "canvasNodeHash", "characterReferenceSnapshot", "batchId") if key in job}
        try:
            result = self.media.submit("runninghub", request)
            job.update(result, updatedAt=now())
            job.update(context)
        except Exception as error:
            job.update(status="unknown" if getattr(error, "outcome_unknown", False) else "failed", error=_error(error), updatedAt=now())
            invalid_quote = error.__class__.__name__ == "MediaValidationError"
        with self.runtime.lock:
            if self._stop.is_set() or self.runtime.closed:
                return  # Recovery reconciles the persisted pre-submit marker.
            self.runtime.save("media", job)
            batch = self.runtime.get("canvas_batch", batch_id)
            item = next(item for item in batch["items"] if item["nodeId"] == node_id)
            item.update(status=job["status"], error=job.get("error"))
            if job["status"] == "unknown":
                self._halt_pending(batch, "已有节点提交结果未知，请先到平台核对，再处理尚未提交节点。")
            elif invalid_quote:
                self._halt_pending(batch, "提交前校验或报价已变化，剩余节点须重新估价并确认。")
            self._save_batch(batch)

    def _poll_one(self):
        candidate = None
        with self.runtime.lock:
            for batch in self.runtime.all("canvas_batch"):
                for item in batch["items"]:
                    if item["status"] not in {"queued", "running", "unknown", "needs_attention"} or not item.get("jobId"):
                        continue
                    job = self.runtime.get("media", item["jobId"])
                    if job["status"] in {"succeeded", "failed", "cancelled"}:
                        item.update(status=job["status"], error=job.get("error"))
                        self._save_batch(batch)
                        continue
                    if not job.get("task_id") or item.get("pollFailures", 0) >= 5:
                        continue
                    if time.time() - item.get("lastPollAt", 0) < self.poll_interval:
                        continue
                    item["lastPollAt"] = time.time()
                    self._save_batch(batch)
                    candidate = (batch["id"], item["nodeId"], job)
                    break
                if candidate:
                    break
        if candidate is None:
            return
        batch_id, node_id, job = candidate
        failure = None
        try:
            job.update(self.media.poll(job["provider"], job["task_id"], mode=job.get("mode", "model_api"), model_id=job.get("modelId")), updatedAt=now())
        except Exception as error:
            failure = _error(error)
        with self.runtime.lock:
            if self._stop.is_set() or self.runtime.closed:
                return
            batch = self.runtime.get("canvas_batch", batch_id)
            item = next(item for item in batch["items"] if item["nodeId"] == node_id)
            if failure:
                item["pollFailures"] = item.get("pollFailures", 0) + 1
                item["error"] = failure
                if item["pollFailures"] >= 5:
                    item["status"] = "needs_attention"
                    job.update(status="needs_attention", error=failure, updatedAt=now())
                    self.runtime.save("media", job)
            else:
                self.runtime.save("media", job)
                item.update(status=job["status"], error=job.get("error"), pollFailures=0)
            self._save_batch(batch)

    def reconcile(self):
        if self._stop.is_set() or self.runtime.closed or not self._step_lock.acquire(blocking=False):
            return
        try:
            claim = self._claim()
            if claim:
                self._finish_submit(claim)
            self._poll_one()
        finally:
            self._step_lock.release()

    def _loop(self):
        while not self._stop.is_set():
            try:
                self.reconcile()
            except Exception as error:
                # Surface scheduler failures without leaking arbitrary tracebacks.
                # No failed queue item is automatically re-dispatched.
                with self.runtime.lock:
                    if self._stop.is_set() or self.runtime.closed:
                        return
                    for batch in self.runtime.all("canvas_batch"):
                        changed = False
                        for item in batch["items"]:
                            if item["status"] == "pending":
                                item.update(status="needs_requote", error=_error(error))
                                changed = True
                            elif item["status"] == "submitting":
                                item.update(status="unknown", error="批次调度中断，提交结果待核对；不会重复提交。")
                                changed = True
                        if changed:
                            self._save_batch(batch)
            self._wake.wait(.25)
            self._wake.clear()

    def active_count(self):
        with self.runtime.lock:
            return sum(any(item["status"] in ACTIVE for item in batch["items"]) for batch in self.runtime.all("canvas_batch"))

    def pending_count(self):
        with self.runtime.lock:
            return sum(item["status"] == "pending" for batch in self.runtime.all("canvas_batch") for item in batch["items"])

    def close(self):
        self._stop.set()
        self._wake.set()
        if self._thread and self._thread is not threading.current_thread():
            self._thread.join(2)

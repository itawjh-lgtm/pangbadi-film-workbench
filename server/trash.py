"""Recoverable deletion and explicit permanent deletion with minimal tombstones.

Tombstones deliberately live outside workspace/run bodies: stale browser
snapshots and background task updates cannot accidentally restore an item.
"""
from __future__ import annotations

from copy import deepcopy
import hashlib
import json
import shutil
import uuid
from pathlib import Path

from .runtime import InputError, identifier, now


KINDS = {"project", "task", "decision", "local_artifact", "note", "run",
         "artifact", "media", "production", "canvas_node"}
WORKSPACE_KEYS = {"project": "projects", "task": "tasks", "decision": "decisions",
                  "local_artifact": "artifacts", "note": "messages"}
RUN_ACTIVE = {"queued", "running"}
MEDIA_UNSETTLED = {"pending", "submitting", "queued", "running", "unknown", "needs_attention"}


def entry_id(kind, target_id, project_id=None):
    return "trash-" + hashlib.sha256(json.dumps([kind, target_id, project_id or ""],
        ensure_ascii=False).encode()).hexdigest()[:32]


def active_entries(runtime):
    return [entry for entry in runtime.all("trash") if not entry.get("restoredAt")]


def production_lineage(plan):
    run_ids, artifact_ids = set(), set()
    for stage in plan.get("stages", []):
        for version in [stage, *stage.get("history", [])]:
            if version.get("runId"):
                run_ids.add(version["runId"])
            artifact_ids.update(item.get("id") for item in version.get("artifacts", []))
            artifact_ids.update(version.get("outputArtifactIds", []))
    return run_ids, artifact_ids


def is_deleted(runtime, kind, target_id, project_id=None):
    entries = active_entries(runtime)
    if any(entry.get("kind") == kind and entry.get("targetId") == target_id
           and (not project_id or entry.get("projectId") == project_id) for entry in entries):
        return True
    if project_id and any(entry.get("kind") == "project" and entry.get("targetId") == project_id for entry in entries):
        return True
    if kind in {"run", "artifact"}:
        deleted_plans = {entry["targetId"] for entry in entries if entry.get("kind") == "production"}
        for plan in runtime.all("production"):
            if plan["id"] not in deleted_plans:
                continue
            run_ids, artifact_ids = production_lineage(plan)
            if target_id in (run_ids if kind == "run" else artifact_ids):
                return True
        if kind == "run" and deleted_plans:
            if any(run["id"] == target_id and run.get("productionId") in deleted_plans for run in runtime.all("run")):
                return True
    if kind == "artifact":
        for run in runtime.all("run"):
            if any(item.get("id") == target_id for item in run.get("artifacts", [])):
                return is_deleted(runtime, "run", run["id"], run.get("projectId"))
    return False


def require_visible(runtime, kind, target_id, project_id=None):
    if target_id and is_deleted(runtime, kind, target_id, project_id):
        if is_purged(runtime, kind, target_id, project_id):
            raise InputError("此内容已彻底删除，无法继续操作。", 409)
        raise InputError("此内容已移入回收站，请先恢复后再继续操作。", 409)


class TrashManager:
    def __init__(self, runtime, workspace):
        self.runtime, self.workspace = runtime, workspace

    def list(self):
        with self.runtime.lock:
            return sorted((entry for entry in active_entries(self.runtime) if not entry.get("purgedAt")), key=lambda item: item.get("deletedAt", 0), reverse=True)

    def snapshot(self):
        with self.runtime.lock:
            return {"items": self.list(), "tombstones": [entry for entry in active_entries(self.runtime) if entry.get("purgedAt")]}

    def _touch_canvases(self, project_ids):
        """Called inside the same SQLite transaction as an overlay change."""
        for project_id in project_ids:
            try:
                canvas = self.runtime.get("canvas", project_id)
            except InputError:
                continue
            canvas.update(revision=canvas.get("revision", 0) + 1, updatedAt=now())
            self.runtime.db.execute("UPDATE records SET body=? WHERE kind='canvas' AND id=?",
                                    (json.dumps(canvas, ensure_ascii=False), canvas["id"]))

    def _resolve(self, item):
        if not isinstance(item, dict) or item.get("kind") not in KINDS or not identifier(item.get("targetId")):
            raise InputError("请选择有效的删除对象。")
        if item.get("projectId") is not None and not identifier(item["projectId"]):
            raise InputError("关联项目编号无效。")
        kind, target_id = item["kind"], item["targetId"]
        state = (self.workspace.read() or {}).get("state", {})
        parent_run = None
        if kind in WORKSPACE_KEYS:
            value = next((value for value in state.get(WORKSPACE_KEYS[kind], [])
                          if isinstance(value, dict) and value.get("id") == target_id), None)
        elif kind == "artifact":
            value = None
            for run in self.runtime.all("run"):
                value = next((value for value in run.get("artifacts", []) if value.get("id") == target_id), None)
                if value:
                    parent_run = run
                    break
        elif kind == "canvas_node":
            matches = [(canvas, node) for canvas in self.runtime.all("canvas")
                       if not item.get("projectId") or canvas.get("projectId") == item["projectId"]
                       for node in canvas.get("nodes", []) if node.get("id") == target_id]
            if len(matches) > 1:
                raise InputError("请指定节点所属项目。")
            value = {**matches[0][1], "projectId": matches[0][0]["projectId"]} if matches else None
        else:
            value = self.runtime.get(kind, target_id)
        if value is None:
            raise InputError("删除对象不存在，请刷新后重试。", 404)
        project_id = target_id if kind == "project" else (parent_run or value).get("projectId")
        if item.get("projectId") is not None and item["projectId"] != project_id:
            raise InputError("删除对象不属于所选项目。", 403)
        title = value.get("title") or value.get("name") or value.get("prompt") or value.get("text") or value.get("filename") or target_id
        return {"id": entry_id(kind, target_id, project_id), "kind": kind, "targetId": target_id,
                "projectId": project_id, "peerId": (parent_run or value).get("peerId"),
                "runId": parent_run.get("id") if parent_run else value.get("runId"),
                "title": str(title).splitlines()[0][:160]}, value

    def _busy(self, entry, value, deleting):
        kind, target, project = entry["kind"], entry["targetId"], entry.get("projectId")
        runs = self.runtime.all("run")
        plans = self.runtime.all("production")
        jobs = self.runtime.all("media")
        batches = self.runtime.all("canvas_batch")
        related_run = entry.get("runId") or (target if kind == "run" else None)
        # A project-wide source mutation can race a running hand-off. Block it
        # while the project executes; the normal stop control remains separate.
        source_kind = kind in {"project", "artifact", "local_artifact", "production", "decision", "run"}
        active_runs = [run for run in runs if run.get("status") in RUN_ACTIVE and
                       ((source_kind and project and run.get("projectId") == project)
                        or run.get("id") == related_run
                        or (kind == "task" and run.get("taskId") == target))]
        active_plans = [plan for plan in plans if plan.get("status") == "running" and
                        ((project and source_kind and plan.get("projectId") == project)
                         or plan.get("id") == target and kind == "production"
                         or bool(related_run) and any(stage.get("runId") == related_run for stage in plan.get("stages", [])))]
        if active_runs or active_plans:
            raise InputError("相关伙伴或自动协作正在执行，请先停止或等待完成，再移入回收站。", 409)
        def touches_job(job):
            if kind == "project":
                return job.get("projectId") == target
            if kind == "media":
                return job.get("id") == target
            if kind == "canvas_node":
                same_source = bool(value.get("shotId") and value.get("sourceArtifactId")) and all(
                    job.get(field) == value.get(field) for field in
                    ("shotId", "sourceArtifactId", "promptArtifactId", "mediaKind"))
                return job.get("projectId") == project and (job.get("canvasNodeId") == target
                    or job.get("id") in value.get("jobIds", []) or same_source)
            if kind == "task":
                return job.get("taskId") == target
            if kind == "artifact":
                return target in (job.get("sourceArtifactId"), job.get("promptArtifactId"))
            if kind in {"run", "production"}:
                plan_runs, plan_artifacts = production_lineage(value) if kind == "production" else (set(), set())
                ids = {artifact.get("id") for run in runs if run.get("id") == target or run.get("productionId") == target or run.get("id") in plan_runs
                       for artifact in run.get("artifacts", [])}
                ids.update(plan_artifacts)
                return bool(ids & {job.get("sourceArtifactId"), job.get("promptArtifactId")})
            return False
        if any(job.get("status") not in {"succeeded", "failed", "cancelled"} and touches_job(job) for job in jobs):
            raise InputError("相关生成任务尚未结束或结果待核对，请先停止未提交任务或核对平台结果，再移入回收站。", 409)
        for batch in batches:
            for item in batch.get("items", []):
                if item.get("status") not in MEDIA_UNSETTLED:
                    continue
                request = {**item.get("request", {}), "projectId": batch.get("projectId"),
                           "canvasNodeId": item.get("nodeId"), "id": item.get("jobId")}
                if touches_job(request):
                    raise InputError("相关画布批次正在排队、生成或等待核对，请先停止未提交部分并等待已提交任务结束。", 409)
        if kind == "task":
            state = (self.workspace.read() or {}).get("state", {})
            downstream = [task for task in state.get("tasks", []) if target in task.get("dependencies", [])
                          and task.get("projectId") == project
                          and ("task", task.get("id"), project) not in deleting
                          and ("project", project, project) not in deleting
                          and not is_deleted(self.runtime, "task", task.get("id"), project)]
            if downstream:
                raise InputError("还有任务依赖此任务，请先解除依赖，或将相关任务一起移入回收站。", 409)

    def delete(self, data):
        items = data.get("items") if isinstance(data, dict) and "items" in data else [data]
        if not isinstance(items, list) or not 1 <= len(items) <= 100:
            raise InputError("每次请选择 1 至 100 个对象。")
        with self.runtime.lock:
            resolved = [self._resolve(item) for item in items]
            deleting = {(entry["kind"], entry["targetId"], entry.get("projectId")) for entry, _ in resolved}
            already_deleted = {entry["id"] for entry in self.list()}
            for entry, value in resolved:
                if entry["id"] not in already_deleted:
                    self._busy(entry, value, deleting)
            timestamp = now()
            # One SQLite transaction after every target passed validation.
            with self.runtime.db:
                touched = set()
                for entry, _ in resolved:
                    try:
                        prior = self.runtime.get("trash", entry["id"])
                    except InputError:
                        prior = None
                    if prior and not prior.get("restoredAt"):
                        continue
                    entry.update(deletedAt=timestamp, restoredAt=None, revision=(prior or {}).get("revision", 0) + 1)
                    self.runtime.db.execute("INSERT INTO records VALUES(?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body",
                        ("trash", entry["id"], None, "project:" + (entry.get("projectId") or ""), json.dumps(entry, ensure_ascii=False)))
                    if entry["kind"] in {"canvas_node", "project"} and entry.get("projectId"):
                        touched.add(entry["projectId"])
                self._touch_canvases(touched)
            return self.list()

    def restore(self, trash_id):
        if not identifier(trash_id):
            raise InputError("回收站记录编号无效。")
        with self.runtime.lock:
            entry = self.runtime.get("trash", trash_id)
            if entry.get("purgedAt") or is_purged(self.runtime, "project", entry.get("projectId"), entry.get("projectId")):
                raise InputError("此内容已彻底删除，无法恢复。", 409)
            # Parent restoration is separate; restoring a child never silently
            # restores its project or schedules any work.
            if not entry.get("restoredAt"):
                entry.update(restoredAt=now(), revision=entry.get("revision", 0) + 1)
                with self.runtime.db:
                    self.runtime.db.execute("UPDATE records SET body=? WHERE kind='trash' AND id=?",
                                            (json.dumps(entry, ensure_ascii=False), entry["id"]))
                    from .workspace import check_visible_limits
                    check_visible_limits(self.runtime, (self.workspace.read() or {}).get("state", {}))
                    if entry["kind"] in {"canvas_node", "project"} and entry.get("projectId"):
                        self._touch_canvases({entry["projectId"]})
            return self.list()

    def purge(self, data):
        if not isinstance(data, dict) or data.get("confirmation") != "permanent-delete":
            raise InputError("请确认彻底删除；此操作无法恢复。")
        ids = data.get("ids")
        if (not isinstance(ids, list) or not 1 <= len(ids) <= 1000
                or any(not identifier(value) for value in ids) or len(set(ids)) != len(ids)):
            raise InputError("每次请选择 1 至 1000 条不同的回收站记录。")
        with self.runtime.lock:
            chosen = [self.runtime.get("trash", value) for value in ids]
            if any(item.get("restoredAt") or item.get("purgedAt") for item in chosen):
                raise InputError("部分记录已经恢复或彻底删除，请刷新回收站后重试。", 409)
            expanded = self._purge_lineage(chosen)
            deleting = {(item["kind"], item["targetId"], item.get("projectId")) for item in expanded.values()}
            for item in chosen:
                _, value = self._resolve(item)
                self._busy(item, value, deleting)
            run_ids = {item["targetId"] for item in expanded.values() if item["kind"] == "run"}
            run_ids.update(item.get("runId") for item in expanded.values() if item["kind"] == "artifact")
            if run_ids & set(self.runtime.cancel_events):
                raise InputError("相关伙伴仍在结束执行，请稍后再彻底删除。", 409)
            self._purge_dependencies(expanded)
            paths = self._purge_paths(expanded)
            staging = self.runtime.directory / (".purge-" + uuid.uuid4().hex)
            moved = []
            try:
                if paths:
                    staging.mkdir(mode=0o700)
                for index, source in enumerate(paths):
                    target = staging / str(index)
                    source.rename(target)
                    moved.append((source, target))
                timestamp = now()
                with self.runtime.db:
                    for item in expanded.values():
                        marker = {key: item[key] for key in ("id", "kind", "targetId", "projectId", "peerId", "runId") if item.get(key) is not None}
                        marker.update(deletedAt=item.get("deletedAt", timestamp), purgedAt=timestamp,
                                      revision=item.get("revision", 0) + 1)
                        self.runtime.db.execute("INSERT INTO records VALUES(?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body",
                            ("trash", marker["id"], None, "project:" + (marker.get("projectId") or ""), json.dumps(marker, ensure_ascii=False)))
                    self._remove_purged_records(expanded)
                    self.workspace.purge_records()
            except Exception:
                for source, target in reversed(moved):
                    if target.exists():
                        target.rename(source)
                if staging.exists():
                    staging.rmdir()
                raise
            if staging.exists():
                shutil.rmtree(staging)
            return {**self.snapshot(), "deletedIds": ids}

    def _purge_lineage(self, chosen):
        result = {item["id"]: deepcopy(item) for item in chosen}
        owners = {}
        def expect(kind, target, project):
            key = (kind, target)
            if key in owners and owners[key] != project:
                raise InputError("自动协作的关联记录归属不一致，已停止整批彻底删除。", 409)
            owners[key] = project
        for entry in chosen:
            if entry["kind"] in {"run", "artifact"}:
                expect(entry["kind"], entry["targetId"], entry.get("projectId"))
        def add(kind, target, project, run_id=None):
            if not target:
                return
            if not identifier(target) or project is not None and not identifier(project):
                raise InputError("关联记录编号异常，已停止彻底删除。", 409)
            if kind in {"run", "artifact"}:
                expect(kind, target, project)
            key = entry_id(kind, target, project)
            if key not in result:
                result[key] = {"id": key, "kind": kind, "targetId": target, "projectId": project}
                if run_id:
                    result[key]["runId"] = run_id
        projects = {item["targetId"] for item in chosen if item["kind"] == "project"}
        plans = {item["targetId"] for item in chosen if item["kind"] == "production"}
        runs = {item["targetId"] for item in chosen if item["kind"] == "run"}
        state = (self.workspace.read() or {}).get("state", {})
        for kind, key in WORKSPACE_KEYS.items():
            for item in state.get(key, []):
                if isinstance(item, dict) and item.get("projectId") in projects:
                    add(kind, item.get("id"), item.get("projectId"))
        plan_projects = {}
        for plan in self.runtime.all("production"):
            if plan.get("projectId") in projects or plan["id"] in plans:
                plan_projects[plan["id"]] = plan.get("projectId")
                add("production", plan["id"], plan.get("projectId"))
                plan_runs, plan_artifacts = production_lineage(plan)
                for target in plan_runs:
                    expect("run", target, plan.get("projectId"))
                runs.update(plan_runs)
                for target in plan_artifacts:
                    add("artifact", target, plan.get("projectId"))
        for run in self.runtime.all("run"):
            if run.get("projectId") in projects or run["id"] in runs or run.get("productionId") in plans:
                if run.get("productionId") in plans:
                    expect("run", run["id"], plan_projects[run["productionId"]])
                add("run", run["id"], run.get("projectId"))
                runs.add(run["id"])
                for artifact in run.get("artifacts", []):
                    add("artifact", artifact.get("id"), run.get("projectId"), run["id"])
        for job in self.runtime.all("media"):
            if job.get("projectId") in projects:
                add("media", job["id"], job.get("projectId"))
        for canvas in self.runtime.all("canvas"):
            if canvas.get("projectId") in projects:
                for node in canvas.get("nodes", []):
                    add("canvas_node", node["id"], canvas.get("projectId"))
        for run in self.runtime.all("run"):
            if ("run", run["id"]) in owners:
                expect("run", run["id"], run.get("projectId"))
            for artifact in run.get("artifacts", []):
                if ("artifact", artifact.get("id")) in owners:
                    expect("artifact", artifact["id"], run.get("projectId"))
        # Descendant entries already in the recycle bin must not remain restorable.
        for entry in active_entries(self.runtime):
            if entry.get("projectId") in projects or entry.get("runId") in runs:
                result.setdefault(entry["id"], deepcopy(entry))
        return result

    def _purge_dependencies(self, expanded):
        removing = {(item["kind"], item["targetId"], item.get("projectId")) for item in expanded.values()}
        projects = {item["targetId"] for item in expanded.values() if item["kind"] == "project"}
        artifacts = {item["targetId"] for item in expanded.values() if item["kind"] == "artifact"}
        runs = {item["targetId"] for item in expanded.values() if item["kind"] == "run"}
        tasks = {item["targetId"] for item in expanded.values() if item["kind"] == "task"}
        decisions = {item["targetId"] for item in expanded.values() if item["kind"] == "decision"}
        media = {item["targetId"] for item in expanded.values() if item["kind"] == "media"}
        for plan in self.runtime.all("production"):
            if plan.get("projectId") in projects or ("production", plan["id"], plan.get("projectId")) in removing:
                continue
            plan_runs, plan_artifacts = production_lineage(plan)
            for stage in plan.get("stages", []):
                for version in [stage, *stage.get("history", [])]:
                    plan_artifacts.update(version.get("inputArtifactIds", []))
            if runs & plan_runs or artifacts & plan_artifacts:
                raise InputError("自动协作「" + str(plan.get("title") or plan.get("project", {}).get("title") or plan["id"])[:100] + "」仍引用所选文稿或执行记录，请将关联自动协作移入回收站后一并彻底删除。", 409)
        for canvas in self.runtime.all("canvas"):
            project = canvas.get("projectId")
            if project in projects:
                continue
            removed_nodes = {target for kind, target, owner in removing if kind == "canvas_node" and owner == project}
            removed_assets = {asset["id"] for asset in canvas.get("characterAssets", []) if asset.get("nodeId") in removed_nodes}
            for asset in canvas.get("characterAssets", []):
                if asset.get("nodeId") not in removed_nodes and asset.get("referenceJobId") in media:
                    raise InputError("人物资产「" + str(asset.get("name") or asset["id"])[:100] + "」仍采用这张图片，请先更换参考，或将该人物资产一并彻底删除。", 409)
            for node in canvas.get("nodes", []):
                if node["id"] in removed_nodes:
                    continue
                if (node.get("referenceNodeId") in removed_nodes or removed_assets & set(node.get("characterAssetIds", []))
                        or artifacts & {node.get("sourceArtifactId"), node.get("promptArtifactId")}
                        or node.get("taskId") in tasks):
                    raise InputError("画布节点「" + str(node.get("title") or node["id"])[:100] + "」仍引用所选内容，请先解除引用，或将关联节点移入回收站后一并彻底删除。", 409)
        state = (self.workspace.read() or {}).get("state", {})
        for task in state.get("tasks", []):
            if task.get("projectId") in projects or ("task", task.get("id"), task.get("projectId")) in removing:
                continue
            if task.get("decisionId") in decisions:
                raise InputError("任务「" + str(task.get("title") or task.get("id"))[:100] + "」仍引用所选决策，请先解除关联，或将该任务一并彻底删除。", 409)
            if tasks & set(task.get("dependencies", [])):
                raise InputError("任务「" + str(task.get("title") or task.get("id"))[:100] + "」仍有依赖，请先解除依赖或一并彻底删除。", 409)

    def _purge_paths(self, expanded):
        runs_root = self.runtime.directory / "runs"
        if runs_root.is_symlink():
            raise InputError("本地执行目录路径异常，已停止彻底删除。", 409)
        root = runs_root.resolve()
        whole_runs = {item["targetId"] for item in expanded.values() if item["kind"] == "run"}
        artifacts = {item["targetId"] for item in expanded.values() if item["kind"] == "artifact"}
        paths = []
        def checked(path):
            if path.is_symlink() or not path.resolve().is_relative_to(root):
                raise InputError("本地成果路径异常，已停止彻底删除。", 409)
            if path.exists():
                paths.append(path)
        for run_id in whole_runs:
            if not identifier(run_id):
                raise InputError("本地执行目录编号异常，已停止彻底删除。", 409)
            checked(runs_root / run_id)
        for run in self.runtime.all("run"):
            if run["id"] in whole_runs:
                continue
            for artifact in run.get("artifacts", []):
                if artifact.get("id") in artifacts and artifact.get("filename"):
                    filename = artifact["filename"]
                    if not isinstance(filename, str) or Path(filename).name != filename:
                        raise InputError("本地成果文件名异常，已停止彻底删除。", 409)
                    if (runs_root / run["id"]).is_symlink():
                        raise InputError("本地执行目录路径异常，已停止彻底删除。", 409)
                    checked(runs_root / run["id"] / filename)
        projects = {item["targetId"] for item in expanded.values() if item["kind"] == "project"}
        nodes = {(item.get("projectId"), item["targetId"]) for item in expanded.values() if item["kind"] == "canvas_node"}
        references_root = self.runtime.directory / "reference-images"
        for record in self.runtime.all("reference_image"):
            if record.get("projectId") not in projects and (record.get("projectId"), record.get("nodeId")) not in nodes:
                continue
            if references_root.is_symlink() or not identifier(record.get("id")) or record.get("suffix") not in (".png", ".jpg", ".webp"):
                raise InputError("本地参考图路径异常，已停止彻底删除。", 409)
            path = references_root / (record["id"] + record["suffix"])
            if path.is_symlink() or not path.resolve().is_relative_to(references_root.resolve()):
                raise InputError("本地参考图路径异常，已停止彻底删除。", 409)
            if path.exists():
                paths.append(path)
        return list(dict.fromkeys(paths))

    def _remove_purged_records(self, expanded):
        projects = {item["targetId"] for item in expanded.values() if item["kind"] == "project"}
        targets = {(item["kind"], item["targetId"]) for item in expanded.values()}
        nodes = {(item.get("projectId"), item["targetId"]) for item in expanded.values() if item["kind"] == "canvas_node"}
        for row in self.runtime.db.execute("SELECT kind,id,body FROM records WHERE kind!='trash'").fetchall():
            kind, key, body = row
            record = json.loads(body)
            if ((kind, key) in targets or record.get("projectId") in projects
                    or kind == "reference_image" and (record.get("projectId"), record.get("nodeId")) in nodes):
                self.runtime.db.execute("DELETE FROM records WHERE kind=? AND id=?", (kind, key))
                continue
            clean = sanitize_purged_record(self.runtime, kind, record)
            if clean != record:
                if kind == "canvas":
                    clean.update(revision=clean.get("revision", 0) + 1, updatedAt=now())
                if kind == "production":
                    clean.update(revision=clean.get("revision", 0) + 1, updatedAt=now())
                self.runtime.db.execute("UPDATE records SET body=? WHERE kind=? AND id=?", (json.dumps(clean, ensure_ascii=False), kind, key))


def preserve_hidden_workspace(runtime, previous, incoming):
    """Omitting an identity from a snapshot is never permanent deletion.

Keep hidden originals immutable, and keep omitted restored items as well. An
older tab may have loaded while they were hidden; its next save must not erase
what another tab just recovered. All intentional removal uses the overlay.
"""
    previous = strip_purged_workspace(runtime, previous)
    state = strip_purged_workspace(runtime, incoming)
    for kind, key in WORKSPACE_KEYS.items():
        hidden = {item["id"]: item for item in previous.get(key, []) if isinstance(item, dict)
                  and is_deleted(runtime, kind, item.get("id"), item.get("id") if kind == "project" else item.get("projectId"))}
        state[key] = [deepcopy(hidden.get(item.get("id"), item)) if isinstance(item, dict) else item
                      for item in state.get(key, [])]
        ids = {item.get("id") for item in state[key] if isinstance(item, dict)}
        for index, item in enumerate(previous.get(key, [])):
            if isinstance(item, dict) and item.get("id") not in ids:
                state[key].insert(min(index, len(state[key])), deepcopy(item))
                ids.add(item["id"])
    return state


def is_purged(runtime, kind, target_id, project_id=None):
    for entry in runtime.all("trash"):
        if not entry.get("purgedAt"):
            continue
        if entry.get("kind") == kind and entry.get("targetId") == target_id and (not project_id or entry.get("projectId") == project_id):
            return True
        if project_id and entry.get("kind") == "project" and entry.get("targetId") == project_id:
            return True
    return False


def strip_purged_workspace(runtime, source):
    state = deepcopy(source)
    markers = [item for item in runtime.all("trash") if item.get("purgedAt")]
    projects = {item["targetId"] for item in markers if item["kind"] == "project"}
    targets = {(item["kind"], item["targetId"], item.get("projectId")) for item in markers}
    for kind, key in WORKSPACE_KEYS.items():
        state[key] = [item for item in state.get(key, []) if not isinstance(item, dict)
                      or ((item.get("id") if kind == "project" else item.get("projectId")) not in projects
                          and (kind, item.get("id"), item.get("id") if kind == "project" else item.get("projectId")) not in targets)]
    state["activity"] = [item for item in state.get("activity", []) if not isinstance(item, dict) or item.get("projectId") not in projects]
    return state


def sanitize_purged_record(runtime, kind, source, artifact_bodies=None):
    record = deepcopy(source)
    markers = [entry for entry in runtime.all("trash") if entry.get("purgedAt")]
    if not markers:
        return record
    artifact_ids = {entry["targetId"] for entry in markers if entry["kind"] == "artifact"}
    if artifact_bodies is None:
        artifact_bodies = {item.get("body") for item in record.get("artifacts", []) if item.get("id") in artifact_ids and item.get("body")}
    def prune(value):
        if isinstance(value, list):
            return [prune(item) for item in value if not isinstance(item, dict) or item.get("id") not in artifact_ids]
        if isinstance(value, dict):
            return {key: prune(item) for key, item in value.items()}
        return value
    record = prune(record)
    if kind == "run":
        record["messages"] = [message for message in record.get("messages", []) if message.get("content") not in (artifact_bodies or set())]
    if kind == "canvas":
        removed = {entry["targetId"] for entry in markers if entry["kind"] == "canvas_node" and entry.get("projectId") == record.get("projectId")}
        record["nodes"] = [node for node in record.get("nodes", []) if node["id"] not in removed]
        record["characterAssets"] = [asset for asset in record.get("characterAssets", []) if asset.get("nodeId") not in removed]
        for node in record["nodes"]:
            node["jobIds"] = [job_id for job_id in node.get("jobIds", []) if not is_purged(runtime, "media", job_id, record.get("projectId"))]
    if kind in {"canvas_batch", "canvas_estimate"}:
        record["items"] = [item for item in record.get("items", []) if not is_purged(runtime, "canvas_node", item.get("nodeId"), record.get("projectId"))
                           and not is_purged(runtime, "media", item.get("jobId"), record.get("projectId"))]
    if kind == "canvas_estimate":
        record["nodeIds"] = [value for value in record.get("nodeIds", []) if not is_purged(runtime, "canvas_node", value, record.get("projectId"))]
        if record.get("items") != source.get("items"):
            record.update(expiresAt=0, status="expired", withinBudget=False)
    return record

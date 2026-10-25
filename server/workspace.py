"""Versioned workspace snapshots, sharing the runtime's SQLite connection/lock."""
from __future__ import annotations

import json

from .runtime import InputError, now
from .trash import preserve_hidden_workspace, is_deleted, WORKSPACE_KEYS, strip_purged_workspace

MAX_BYTES = 5_000_000
ARRAY_LIMITS = {"projects": 20, "tasks": 120, "decisions": 40, "artifacts": 40,
                "messages": 80, "activity": 80, "favorites": 50}
STORAGE_LIMITS = {key: value * (10 if key in WORKSPACE_KEYS.values() else 1) for key, value in ARRAY_LIMITS.items()}


def check_visible_limits(runtime, state):
    for kind, key in WORKSPACE_KEYS.items():
        count = sum(not is_deleted(runtime, kind, item.get("id"), item.get("id") if kind == "project" else item.get("projectId"))
                    for item in state.get(key, []) if isinstance(item, dict))
        if count > ARRAY_LIMITS[key]:
            raise InputError(f"工作台 {key} 的活跃数量已达上限 {ARRAY_LIMITS[key]}，请先整理现有内容后再保存或恢复。", 409)


class Workspace:
    def __init__(self, runtime):
        self.runtime = runtime
        with runtime.lock:
            runtime.db.execute("CREATE TABLE IF NOT EXISTS workspace_snapshots (revision INTEGER PRIMARY KEY, updated_at INTEGER NOT NULL, body TEXT NOT NULL)")
            runtime.db.commit()

    def read(self):
        with self.runtime.lock:
            row = self.runtime.db.execute("SELECT revision,updated_at,body FROM workspace_snapshots ORDER BY revision DESC LIMIT 1").fetchone()
            return {"revision": row[0], "updatedAt": row[1], "state": json.loads(row[2])} if row else None

    def purge_records(self):
        """Called by TrashManager inside its transaction; never commits independently."""
        rows = self.runtime.db.execute("SELECT revision,body FROM workspace_snapshots ORDER BY revision").fetchall()
        changed = False
        for revision, body in rows:
            original = json.loads(body)
            clean = strip_purged_workspace(self.runtime, original)
            if clean != original:
                changed = True
                self.runtime.db.execute("UPDATE workspace_snapshots SET body=? WHERE revision=?", (json.dumps(clean, ensure_ascii=False), revision))
        if changed and rows:
            latest = self.read()
            self.runtime.db.execute("INSERT INTO workspace_snapshots VALUES(?,?,?)", (latest["revision"] + 1, now(), json.dumps(latest["state"], ensure_ascii=False)))

    def save(self, data):
        expected, state = data.get("expectedRevision"), data.get("state")
        if type(expected) is not int or expected < 0:
            raise InputError("缺少有效的数据版本。")
        if not isinstance(state, dict) or state.get("version") != 3 or state.get("truncated") or state.get("pointerOnly"):
            raise InputError("请提供完整的 v3 工作台快照。")
        for key, maximum in STORAGE_LIMITS.items():
            values = state.get(key)
            if not isinstance(values, list) or len(values) > maximum:
                raise InputError(f"工作台 {key} 数据格式或数量无效。")
        try:
            body = json.dumps(state, ensure_ascii=False, allow_nan=False)
        except (ValueError, TypeError):
            raise InputError("工作台数据包含无效值。")
        if len(body.encode("utf-8")) > MAX_BYTES:
            raise InputError("工作台快照超过 5 MB，请先导出备份。", 413)
        with self.runtime.lock:
            current = self.read()
            state = strip_purged_workspace(self.runtime, state)
            body = json.dumps(state, ensure_ascii=False, allow_nan=False)
            if current:
                state = preserve_hidden_workspace(self.runtime, current["state"], state)
                for key, maximum in STORAGE_LIMITS.items():
                    if len(state[key]) > maximum:
                        raise InputError(f"工作台 {key} 数量超过上限；回收站原始数据仍保留。")
                body = json.dumps(state, ensure_ascii=False, allow_nan=False)
                if len(body.encode("utf-8")) > MAX_BYTES:
                    raise InputError("工作台快照超过 5 MB，请先导出备份。", 413)
            check_visible_limits(self.runtime, state)
            # A response may have been lost after a successful write. Identical
            # content is an idempotent acknowledgement, never a second revision.
            if current and current["state"] == state:
                return current
            if (current["revision"] if current else 0) != expected:
                raise InputError("其他窗口已更新工作台；本页数据已保留，请先处理版本冲突。", 409)
            revision, updated = expected + 1, now()
            self.runtime.db.execute("INSERT INTO workspace_snapshots VALUES(?,?,?)", (revision, updated, body))
            self.runtime.db.commit()
            return {"revision": revision, "updatedAt": updated, "state": state}

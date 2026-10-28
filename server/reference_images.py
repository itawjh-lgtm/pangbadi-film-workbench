"""Private, node-owned image originals; provider URLs are temporary, replaceable copies."""
from __future__ import annotations

import base64
import binascii
import hashlib
import os
import struct
import threading
import time
import uuid

from .runtime import InputError, identifier, now
from .trash import require_visible

MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_UPLOAD_JSON = ((MAX_IMAGE_BYTES + 2) // 3) * 4 + 4096


def image_type(data):
    """Reject non-raster input and oversized dimensions before serving or uploading."""
    width = height = 0
    mime, suffix = "", ""
    if len(data) >= 45 and data.startswith(b"\x89PNG\r\n\x1a\n") and data[12:16] == b"IHDR" and data[-8:-4] == b"IEND":
        width, height = struct.unpack(">II", data[16:24])
        mime, suffix = "image/png", ".png"
    elif data.startswith(b"\xff\xd8") and data.endswith(b"\xff\xd9"):
        offset = 2
        while offset + 4 <= len(data):
            if data[offset] != 255:
                break
            while offset < len(data) and data[offset] == 255:
                offset += 1
            if offset >= len(data):
                break
            marker = data[offset]
            offset += 1
            if marker in (0xD8, 0xD9) or 0xD0 <= marker <= 0xD7:
                continue
            if marker == 0xDA:
                break
            length = int.from_bytes(data[offset:offset + 2], "big")
            if length < 2 or offset + length > len(data):
                break
            if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF) and length >= 8:
                height, width = struct.unpack(">HH", data[offset + 3:offset + 7])
                mime, suffix = "image/jpeg", ".jpg"
                break
            offset += length
    elif len(data) >= 30 and data[:4] == b"RIFF" and data[8:12] == b"WEBP" and int.from_bytes(data[4:8], "little") + 8 == len(data):
        kind = data[12:16]
        if kind == b"VP8X":
            width = int.from_bytes(data[24:27], "little") + 1
            height = int.from_bytes(data[27:30], "little") + 1
        elif kind == b"VP8 " and data[23:26] == b"\x9d\x01\x2a":
            width, height = (value & 0x3FFF for value in struct.unpack("<HH", data[26:30]))
        elif kind == b"VP8L" and data[20] == 0x2F:
            bits = int.from_bytes(data[21:25], "little")
            width, height = (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
        mime, suffix = "image/webp", ".webp"
    if not mime or min(width, height) <= 0 or max(width, height) > 16384 or width * height > 60_000_000:
        raise InputError("请上传有效的 PNG、JPG 或 WebP 图片（最长边不超过 16384 像素）。")
    return mime, suffix, width, height


class ReferenceImageStore:
    def __init__(self, runtime, workspace, media):
        self.runtime, self.workspace, self.media = runtime, workspace, media
        self.directory = runtime.directory / "reference-images"
        self.lock = threading.RLock()

    def _node(self, project_id, node_id):
        if not identifier(project_id) or not identifier(node_id):
            raise InputError("参考图的项目或节点编号无效。")
        require_visible(self.runtime, "project", project_id, project_id)
        require_visible(self.runtime, "canvas_node", node_id, project_id)
        state = self.workspace.read().get("state", {})
        project = next((p for p in state.get("projects", []) if p.get("id") == project_id), None)
        if not project or project.get("isDemo"):
            raise InputError("请在自己的项目中添加参考图。", 404)
        canvas = self.runtime.get("canvas", project_id)
        node = next((n for n in canvas.get("nodes", []) if n.get("id") == node_id), None)
        if not node or node.get("mediaKind") != "image":
            raise InputError("请先保存人物资产或生图节点，再添加参考图。", 409)
        return node

    @staticmethod
    def _public(record):
        return {key: record[key] for key in ("id", "name", "mimeType", "size", "width", "height")} | {
            "previewUrl": "/api/projects/" + record["projectId"] + "/reference-images/" + record["id"]}

    def add(self, project_id, payload):
        node_id = payload.get("nodeId")
        self._node(project_id, node_id)
        encoded, name = payload.get("contentBase64"), payload.get("name", "参考图片")
        if not isinstance(name, str) or not name.strip() or len(name) > 240 or any(ord(c) < 32 for c in name):
            raise InputError("图片名称无效或过长。")
        if not isinstance(encoded, str) or not encoded or len(encoded) > MAX_UPLOAD_JSON - 4096:
            raise InputError("每张参考图最大 10 MB。", 413)
        try:
            data = base64.b64decode(encoded, validate=True)
        except (ValueError, binascii.Error):
            raise InputError("图片数据无效，请重新选择文件。") from None
        if not data or len(data) > MAX_IMAGE_BYTES:
            raise InputError("每张参考图最大 10 MB。", 413)
        mime, suffix, width, height = image_type(data)
        digest = hashlib.sha256(data).hexdigest()
        with self.lock, self.runtime.lock:
            self._node(project_id, node_id)
            # Re-selecting the same local file does not create duplicate originals.
            for item in self.runtime.all("reference_image", "project:" + project_id):
                if item.get("nodeId") == node_id and item.get("sha256") == digest:
                    try:
                        self.read(project_id, item["id"])
                    except InputError:
                        continue  # Re-selecting a lost/corrupt original repairs it with a new ID.
                    else:
                        return self._public(item)
            if self.directory.is_symlink():
                raise InputError("参考图目录异常，请检查本机存储。", 409)
            self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
            reference_id = "ref-" + uuid.uuid4().hex
            path = self.directory / (reference_id + suffix)
            with path.open("xb") as handle:
                os.chmod(path, 0o600)
                handle.write(data)
            record = {"id": reference_id, "projectId": project_id, "nodeId": node_id,
                      "name": name.strip(), "mimeType": mime, "suffix": suffix, "size": len(data),
                      "width": width, "height": height, "sha256": digest, "createdAt": now()}
            try:
                self.runtime.save("reference_image", record)
            except Exception:
                path.unlink(missing_ok=True)
                raise
            return self._public(record)

    def _record(self, project_id, reference_id, node_id=None):
        if not identifier(reference_id):
            raise InputError("参考图编号无效。")
        record = self.runtime.get("reference_image", reference_id)
        if record.get("projectId") != project_id or (node_id and record.get("nodeId") != node_id):
            raise InputError("参考图不属于当前项目和节点。", 409)
        self._node(project_id, record["nodeId"])
        return record

    def validate(self, project_id, node_id, reference_id):
        return self._public(self._record(project_id, reference_id, node_id))

    def read(self, project_id, reference_id):
        record = self._record(project_id, reference_id)
        if record.get("suffix") not in (".png", ".jpg", ".webp"):
            raise InputError("参考图记录无效。", 409)
        path = self.directory / (reference_id + record["suffix"])
        if self.directory.is_symlink() or path.is_symlink() or not path.is_file():
            raise InputError("本机参考图已不可用，请重新选择图片。", 404)
        with path.open("rb") as handle:
            data = handle.read(MAX_IMAGE_BYTES + 1)
        if len(data) != record["size"] or hashlib.sha256(data).hexdigest() != record["sha256"]:
            raise InputError("本机参考图发生变化，请重新选择图片。", 409)
        return data, record["mimeType"]

    def prepare(self, project_id, node_id, reference_ids):
        if len(reference_ids) > 10:
            raise InputError("每个节点最多使用 10 张参考图。")
        with self.lock:
            for reference_id in dict.fromkeys(reference_ids):
                record = self._record(project_id, reference_id, node_id)
                if record.get("remoteUrl") and record.get("remoteExpiresAt", 0) > time.time() + 600:
                    continue
                data, mime = self.read(project_id, reference_id)
                remote = self.media.upload_reference_image(data, mime, reference_id + record["suffix"])
                with self.runtime.lock:
                    self._node(project_id, node_id)
                    record.update(remoteUrl=remote, remoteExpiresAt=time.time() + 23 * 3600)
                    self.runtime.save("reference_image", record)

    def urls(self, project_id, node_id, reference_ids):
        urls = []
        for reference_id in reference_ids:
            record = self._record(project_id, reference_id, node_id)
            if not record.get("remoteUrl") or record.get("remoteExpiresAt", 0) <= time.time() + 60:
                raise InputError("参考图上传链接尚未准备好或已过期，请重新核对生成费用。", 409)
            urls.append(record["remoteUrl"])
        return urls

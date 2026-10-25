#!/usr/bin/env python3
"""Start/reuse this project's loopback service without killing unrelated jobs."""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
import urllib.request

VERSION = "0.6"


def identity(root):
    return hashlib.sha256(str(Path(root).resolve()).encode()).hexdigest()[:24]


def health(port, timeout=2):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(f"http://127.0.0.1:{port}/api/service-status", timeout=timeout) as response:
            data = json.loads(response.read(65536))
        return data if isinstance(data, dict) else None
    except (OSError, ValueError):
        return None


def compatible(data, root):
    return bool(data and data.get("ok") and data.get("service") == "dream-studio-runtime"
                and data.get("projectId") == identity(root) and data.get("version") == VERSION)


def occupied(port):
    with socket.socket() as connection:
        connection.settimeout(.5)
        return connection.connect_ex(("127.0.0.1", port)) == 0


def result(ok, port, reason="", owned=False, pid=None):
    return {"ok": ok, "url": f"http://127.0.0.1:{port}/" if ok else None,
            "owned": owned, "reason": reason, "pid": pid}


def check_existing(data, root, port):
    if compatible(data, root):
        return result(True, port, pid=data.get("pid"))
    if data and data.get("service") == "dream-studio-runtime":
        if data.get("projectId") == identity(root):
            message = "后台版本需要更新。请先完成正在执行的任务，再更新本机工作台；已有记录保留。"
        elif not data.get("projectId"):
            message = "检测到旧版工作台后台。请完成当前任务后升级后台；客户端未停止任何任务。"
        else:
            message = "此端口属于另一个工作台项目，请关闭其后台或调整客户端端口。"
        return result(False, port, message)
    if data or occupied(port):
        return result(False, port, f"本机 {port} 端口已被其他程序占用或服务尚未就绪。未关闭任何进程，请稍后重试。")
    return None


def ensure(root, port):
    deadline = time.monotonic() + 40
    root = Path(root).resolve()
    if not (root / "server/httpd.py").is_file() or not (root / "index.html").is_file():
        return result(False, port, "找不到原工作台文件夹，请恢复文件夹位置或重新构建客户端。")
    directory = root / "data/runtime"
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (directory / ".launcher.lock").open("a") as lock:
        while True:
            try:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() > deadline:
                    return result(False, port, "另一个窗口正在启动后台，请稍后点击重新连接。")
                time.sleep(.2)
        existing = check_existing(health(port), root, port)
        if existing is not None:
            return existing
        log_path = directory / "server.log"
        with log_path.open("ab") as log:
            log_path.chmod(0o600)
            environment = os.environ.copy()
            environment["PYTHONUNBUFFERED"] = "1"
            environment["PATH"] = str(Path(sys.executable).parent) + os.pathsep + environment.get("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
            child = subprocess.Popen([sys.executable, "-m", "server.httpd", "--port", str(port)], cwd=root,
                                     stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                                     env=environment, start_new_session=True, close_fds=True)
        while time.monotonic() < deadline:
            data = health(port)
            if compatible(data, root):
                return result(True, port, owned=True, pid=data.get("pid", child.pid))
            if data and data.get("service"):
                return check_existing(data, root, port)
            if child.poll() is not None:
                return result(False, port, "后台启动失败。请通过菜单“显示 → 查看启动与运行日志”查看原因。")
            time.sleep(.25)
        return result(False, port, "后台启动超过等待时间。未终止后台，请稍后重新连接或查看日志。")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["ensure"])
    parser.add_argument("--project-root", type=Path, required=True)
    parser.add_argument("--port", type=int, default=8767)
    args = parser.parse_args()
    try:
        if not 1024 <= args.port <= 65535:
            raise ValueError("端口必须在 1024–65535 之间。")
        answer = ensure(args.project_root, args.port)
    except Exception as error:
        answer = result(False, args.port, "无法启动本机后台：" + str(error)[:500])
    print(json.dumps(answer, ensure_ascii=False), flush=True)
    return 0 if answer["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())

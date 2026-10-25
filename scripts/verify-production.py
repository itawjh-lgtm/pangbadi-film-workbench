"""Isolated manual QA, never opens the user's production database.

Default: serve a clearly marked fake-provider workspace for browser testing.
--real: exercise six text-only stages through the installed Codex provider.
"""
import argparse
import json
from pathlib import Path
import signal
import sys
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server.httpd import StudioServer
from server.production import ProductionManager
from server.provider import CodexProvider, ProviderError
from server.roles import RoleCatalog
from server.runtime import Runtime


class FixtureProvider:
    def health(self):
        return {"available": True, "authenticated": True, "label": "隔离测试提供者", "reason": "仅验证交互，不调用模型"}

    def generate(self, instructions, prompt, workdir, cancel_event=None, **kwargs):
        for _ in range(25):
            if cancel_event is not None and cancel_event.wait(.1):
                raise ProviderError("cancelled", "测试任务已暂停。")
        return {"text": "# 隔离测试文稿\n\n这是用于验证协作交互的固定测试数据，不是真实模型生成。\n\n" + prompt[-900:], "usage": {}}


def workspace():
    return {"version": 3, "revision": 0, "presentationVersion": 1, "view": "project", "projectTab": "production", "activeProjectId": "qa-auto-film", "favorites": [], "projects": [{"id": "qa-auto-film", "title": "隔离测试 · 自动协作", "brief": "仅验证交互，使用模拟提供者。与真实项目数据库隔离。", "kind": "film", "members": ["R11", "R03", "R05", "R04", "R06"], "isDemo": False, "createdAt": int(time.time()*1000)}], "tasks": [], "decisions": [], "artifacts": [], "messages": [], "activity": []}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--real", action="store_true")
    parser.add_argument("--port", type=int, default=8876)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    directory = tempfile.mkdtemp(prefix="dream-studio-production-qa-")
    print(json.dumps({"isolatedDirectory": directory, "realModel": args.real}, ensure_ascii=False), flush=True)
    runtime = Runtime(directory, RoleCatalog(), CodexProvider(timeout=240) if args.real else FixtureProvider())
    if not args.real:
        server = StudioServer(("127.0.0.1", args.port), runtime)
        server.workspace.save({"expectedRevision": 0, "state": workspace()})
        print(f"QA URL: http://127.0.0.1:{server.server_port}/", flush=True)
        signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
        try:
            server.serve_forever()
        finally:
            server.server_close()
            runtime.close()
        return
    manager = ProductionManager(runtime)
    report = {"evidence": "real_codex_text_only", "isolatedDirectory": directory, "mediaCalls": 0}
    try:
        plan = manager.start({"requestId": "qa-real-six-stages", "project": {"id": "qa-real-film", "title": "隔离验证 · 六秒纸船", "kind": "film", "brief": "一镜六秒原创动画，纸船在水盆里漂动，无对白。"}, "prompt": "制作一镜六秒原创动画：蓝色纸船在白色水盆里轻轻漂动，固定机位，无人物、无文字、无对白。各阶段正文精简到400字以内；只做本阶段交付。无需补问，未给条件自行做创作假设。本轮是小规模文字链路验证，不生成图片视频。", "reviewMode": "continuous"})
        deadline, last = time.monotonic()+1200, None
        while time.monotonic() < deadline:
            plan = manager.get(plan["id"])
            state = (plan["status"], plan["currentStageId"], plan["revision"])
            if state != last:
                print(json.dumps({"status": state[0], "stage": state[1], "revision": state[2]}, ensure_ascii=False), flush=True)
                last = state
            if plan["status"] != "running":
                break
            time.sleep(.5)
        report.update(status=plan["status"], error=plan.get("error"), stages=[{"id": s["id"], "agentId": s["agentId"], "status": s["status"], "attempt": s["attempt"], "inputs": len(s["inputArtifactIds"]), "outputs": len(s["artifacts"]), "characters": sum(len(a.get("body", "")) for a in s["artifacts"])} for s in plan["stages"]], mediaReadiness=plan["mediaReadiness"])
        passed = plan["status"] == "awaiting_review" and plan["currentStageId"] == "delivery" and all(s["artifacts"] for s in plan["stages"])
        report["passed"] = passed
        print(json.dumps(report, ensure_ascii=False, indent=2), flush=True)
        if args.report:
            args.report.parent.mkdir(parents=True, exist_ok=True)
            args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2)+"\n", encoding="utf-8")
        if not passed:
            sys.exit(1)
    finally:
        manager.close()
        runtime.close()


if __name__ == "__main__":
    main()

"""Persistent, reviewable film collaboration built on the existing role runtime.

The manager schedules text work only. A completed prompt document is never a
claim that an image or video has been generated, checked or accepted.
"""
from __future__ import annotations

import copy
import hashlib
import json
import threading
import uuid

from .runtime import InputError, identifier, now, require_text
from .trash import is_deleted, require_visible
from .project_assets import character_asset_report


VISUAL_ASSET_INSTRUCTIONS = """依据本轮剧本交付角色、世界与视觉设定；人物资产说明是本阶段必交正文，不能只写风格方向或“后续补人物”。
先列“人物资产总表”：| 资产编号 | 角色名 | 身份与年龄 | 依据与性质 | 出场关联 |，每位独立项目角色使用稳定的 CHR-001 等编号。
随后每位角色单独使用 Markdown 标题“### CHR-001｜角色名”，不得把多个人共用一张角色卡；只有确有群像需求时才单列群像资产并说明成员差异。
每张人物卡必须逐项写清以下带标签的字段，写完整制作说明而非仅填字段名：
- 资产类型：人物（工作人员、场景、道具不属于项目人物）。
- 人物介绍：用两三句话说明这个人是谁、性格、与其他人物的关系及剧情作用；与下方定妆提示词分开，不在介绍中堆生成参数或绘图指令。
- 身份与年龄：剧情身份、关系、原稿年龄或年龄观感；原稿未说明的年龄不能伪称原作事实。
- 外貌与身形五官：体态比例、身高观感、脸型、五官和肤色等具体特征。
- 发型：长度、轮廓、分缝、发色及整理方式。
- 服装与配饰：内外层、颜色、剪裁、材质、鞋履和随身配饰，说明叙事功能。
- 辨识特征：区别于其他人物的稳定视觉特征，避免同脸模板。
- 性格与表演：姿态、惯用动作、视线与表情尺度；未知部分标创作建议。
- 定妆视图：需要的正面、侧面、背面全身、头像或表情参考，明确未生成/待审状态。
- 参考图生成提示词：可直接用于无字定妆/角色参考图的完整提示词，包含主体、造型、视图、画幅、风格及需保持的特征；不把镜头剧情动作混入基础定妆。
- 不可改变项：跨镜头必须锁定的身份、脸型、发型、主服装与辨识锚点。
- 换装版本：基础版本及有剧本依据的换装/状态变化，分别说明保留项；没有换装需求就明确“当前仅基础版，无换装要求”。
- 出场镜头关联：已有的场次/剧情段落与镜号；本阶段早于逐镜设计，尚无镜号就写“关联剧本场次……；镜号待 R04 编排”，不得编造已确认镜号。
- 依据与性质：逐项区分用户已提供/剧本设定/创作设计/原作待核实；未知事实写待提供，不能编造原作外貌或把占位造型称为原作角色。
场景、世界规则和道具分别用 SCN-/PROP- 编号及独立章节，写空间、色彩材质、画幅、风格一致性和所需参考素材；不得混入 CHR 人物表。
纯场景项目必须明确“人物资产：无；本项目无需人物资产”，同时说明依据，不得为了凑表虚构角色。员工名单、R01—R16 岗位和制作协作人员只属于团队信息，不得当作品角色。
输出前自检：人物总表与逐人明细一一对应、编号唯一、字段缺失有原因、定妆提示词可执行、场景道具分开。新稿应补齐该结构；已有历史文稿如缺项只提示补充，不能篡改旧交付。文字完成不等于人物图已生成、审阅或确认。"""


STAGES = (
    ("plan", "制作规划", "R11", "把用户需求转成这一次作品的具体制作简报：主题、受众、时长、叙事目标、交付范围、必须保持的约束与需用户判断的事项。给后续编剧可直接使用的创作方向。只做本项目规划，不再设计员工组织架构。"),
    ("script", "剧本创作", "R03", "依据制作简报交付可连续阅读的完整剧本，包含情节、人物、场景、对白或旁白及大致时长。即使需求很短也须给正文；不要只给大纲、建议或分镜提示词。用户未提供的事实不得写成已核实资料。"),
    ("visual", "角色与视觉设定", "R05", VISUAL_ASSET_INSTRUCTIONS),
    ("storyboard", "逐镜设计", "R04", "依据当前剧本和视觉设定交付完整可编辑的逐镜 Markdown 表。每镜使用稳定镜号，列出时长、画面内容、人物动作、景别、运镜、对白旁白和声画意图；核对总时长。保持剧本内容与角色设定；不要把分镜文稿声称为预演视频。"),
    ("prompts", "生图与视频输入", "R06", "按当前逐镜稿逐镜交付生图提示词和视频动作提示词，并列出镜号、引用角色/场景、所需参考图、首帧或首尾帧意图、可调参数与缺失输入。只写本镜有效生成信息，保持人物一致性；模型不支持或尚未验证的能力必须标待验证。没有实际连接工作流，不能填造任务编号或声称图片视频已生成。"),
    ("delivery", "交付整理与检查", "R11", "汇总本轮真实交付的剧本、视觉设定、分镜和逐镜生成输入，检查明显冲突与缺失，列出对应镜号及下一步制作动作。明确这些是文字成果；图片生成、视频生成、播放检查、总策划验收各自独立。不得把自检或模型建议写成独立专业复核通过。"),
)
STAGE_INSTRUCTIONS = {stage[0]: stage[3] for stage in STAGES}
UNFINISHED = {"running", "awaiting_review", "paused", "failed"}
RUN_ACTIVE = {"queued", "running"}


class ProductionManager:
    def __init__(self, runtime, *, poll_interval=0.25, start_worker=True):
        self.runtime = runtime
        self.poll_interval = max(0.01, float(poll_interval))
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._thread = None
        # Runtime has already reconciled interrupted CLI runs. Restore persisted
        # stage evidence before deciding whether any new invocation is permitted.
        with self.runtime.lock:
            for plan in self.runtime.all("production"):
                self._recover(plan)
        if start_worker:
            self._thread = threading.Thread(target=self._loop, name="studio-productions", daemon=True)
            self._thread.start()

    def _loop(self):
        while not self._stop.is_set():
            self.reconcile()
            self._wake.wait(self.poll_interval)
            self._wake.clear()

    @staticmethod
    def _event(plan, kind, text, stage=None):
        events = plan.setdefault("events", [])
        events.append({"seq": (events[-1]["seq"] if events else 0) + 1,
                       "id": uuid.uuid4().hex, "type": kind,
                       "stageId": stage["id"] if stage else None,
                       "agentId": stage["agentId"] if stage else None,
                       "text": str(text)[:1200], "at": now()})

    def _save(self, plan):
        plan["revision"] = plan.get("revision", 0) + 1
        plan["updatedAt"] = now()
        current = self._current(plan)
        plan["currentStageId"] = current["id"] if current else None
        self._readiness(plan)
        self.runtime.save("production", plan)

    def _readiness(self, plan):
        visual = next((stage for stage in plan.get("stages", []) if stage["id"] == "visual"), None)
        if visual is not None:
            visible = [artifact for artifact in visual.get("artifacts", [])
                       if not is_deleted(self.runtime, "artifact", artifact.get("id"), plan.get("projectId"))]
            visual["characterAssetReport"] = character_asset_report(visible)
        prompts = next((stage for stage in plan.get("stages", []) if stage["id"] == "prompts"), {})
        prepared = prompts.get("status") == "completed" and bool(prompts.get("artifacts"))
        plan["mediaReadiness"] = {
            "status": "inputs_prepared" if prepared else "not_started",
            "label": ("文稿已确认，可在创作画布选择镜头生成" if prepared and plan.get("status") == "completed"
                      else "生成输入已准备；文稿确认后可在创作画布选择镜头生成" if prepared
                      else "正在准备剧本、画面设计与生成输入"),
            "imagesGenerated": False, "videosGenerated": False,
        }
        return plan

    @staticmethod
    def _current(plan):
        return next((stage for stage in plan["stages"] if stage["status"] != "completed"), None)

    @staticmethod
    def _needs_review(plan, stage):
        return stage["id"] == "delivery" or (plan["reviewMode"] == "stepwise" and stage["id"] in ("script", "visual"))

    def _check_open(self):
        if self._stop.is_set() or self.runtime.closed:
            raise InputError("执行服务正在停止，请重新连接后继续。", 503)

    def _check_revision(self, plan, data):
        if not isinstance(data, dict) or type(data.get("expectedRevision")) is not int:
            raise InputError("缺少有效的制作计划版本。")
        if data["expectedRevision"] != plan["revision"]:
            raise InputError("制作进度已更新，请查看最新状态后重试；未重复执行操作。", 409)

    def _check_project_available(self, project_id, except_id=None):
        require_visible(self.runtime, "project", project_id, project_id)
        if any(plan["id"] != except_id and plan.get("status") in UNFINISHED
               and not is_deleted(self.runtime, "production", plan["id"], project_id)
               for plan in self.runtime.all("production", "project:" + project_id)):
            raise InputError("此项目已有未完成的自动协作，请先继续或审阅现有计划。", 409)

    def _validate_start(self, data):
        if not isinstance(data, dict) or not identifier(data.get("requestId")):
            raise InputError("缺少有效的请求编号。")
        prompt = require_text(data.get("prompt"), "制作要求", 16000)
        project = data.get("project")
        if not isinstance(project, dict) or not identifier(project.get("id")):
            raise InputError("请选择有效的影视项目。")
        if project.get("kind") == "game":
            raise InputError("当前自动制作流程用于影视项目；游戏项目请继续使用游戏团队工位。")
        if not isinstance(project.get("title", ""), str) or len(project.get("title", "")) > 300:
            raise InputError("项目名称格式无效。")
        if not isinstance(project.get("brief", ""), str) or len(project.get("brief", "")) > 20000:
            raise InputError("项目简报格式无效或过长。")
        members = project.get("members", [])
        if not isinstance(members, list) or len(members) > 100 or any(not isinstance(item, str) for item in members):
            raise InputError("项目成员格式无效。")
        review_mode = data.get("reviewMode", "stepwise")
        if review_mode not in ("stepwise", "continuous"):
            raise InputError("请选择逐步审阅或连续执行。")
        for agent in {stage[2] for stage in STAGES}:
            try:
                role = self.runtime.catalog.get_role(agent)
            except KeyError:
                raise InputError("缺少自动协作所需岗位：" + agent)
            if not role.get("available"):
                raise InputError("岗位原文缺失，无法开始自动协作：" + agent)
        try:
            digest = hashlib.sha256(json.dumps(data, sort_keys=True, ensure_ascii=False, allow_nan=False).encode()).hexdigest()
        except (TypeError, ValueError):
            raise InputError("制作要求包含无效值。")
        snapshot = {"id": project["id"], "title": project.get("title", ""),
                    "kind": project.get("kind", "film"), "brief": project.get("brief", ""),
                    "members": sorted(set(members) | {stage[2] for stage in STAGES})}
        return prompt, snapshot, review_mode, digest

    def start(self, data):
        prompt, project, review_mode, digest = self._validate_start(data)
        with self.runtime.lock:
            self._check_open()
            require_visible(self.runtime, "project", project["id"], project["id"])
            prior = self.runtime.by_request("production", data["requestId"])
            if prior:
                if prior.get("requestHash") != digest:
                    raise InputError("同一个请求编号不可修改内容后重用。", 409)
                return prior
            self._check_project_available(project["id"])
            stages = []
            for stage_id, title, agent, _ in STAGES:
                stages.append({"id": stage_id, "title": title, "agentId": agent,
                               "dependsOn": [stages[-1]["id"]] if stages else [],
                               "status": "pending", "runId": None, "requestId": None,
                               "attempt": 0, "inputArtifactIds": [], "outputArtifactIds": [],
                               "artifacts": [], "history": [], "error": None, "review": None,
                               "revisionNote": ""})
            plan = {"id": uuid.uuid4().hex, "requestId": data["requestId"], "requestHash": digest,
                    "projectId": project["id"], "project": project, "prompt": prompt,
                    "reviewMode": review_mode, "status": "running", "revision": 0,
                    "createdAt": now(), "updatedAt": now(), "stages": stages, "events": [],
                    "error": None, "evidenceLevel": "text_production"}
            self._event(plan, "created", "已保存制作需求，团队将按职责真实执行并交接文字成果。")
            self._save(plan)
            self._wake.set()
            return plan

    def list(self, project_id):
        if not identifier(project_id):
            raise InputError("请指定有效项目。")
        with self.runtime.lock:
            return [self._readiness(plan) for plan in self.runtime.all("production", "project:" + project_id)]

    def get(self, plan_id):
        if not identifier(plan_id):
            raise InputError("制作计划编号无效。")
        return self._readiness(self.runtime.get("production", plan_id))

    def _run(self, plan, stage):
        run = None
        if stage.get("runId"):
            run = self.runtime.get("run", stage["runId"])
        elif stage.get("requestId"):
            run = self.runtime.by_request("run", stage["requestId"])
        if run:
            if run.get("projectId") != plan["projectId"] or run.get("peerId") or run.get("agentIds") != [stage["agentId"]]:
                raise InputError("运行归属与制作阶段不一致，已停止交接。", 409)
            stage["runId"] = run["id"]
        return run

    def _consume(self, plan, stage, run):
        if run.get("status") != "succeeded":
            return False
        artifacts = run.get("artifacts", [])
        if not artifacts or any(not isinstance(a.get("body"), str) or not a["body"].strip() for a in artifacts):
            raise InputError("员工运行没有有效的完整文字成果，暂不能交接。", 409)
        stage["artifacts"] = copy.deepcopy(artifacts)
        stage["outputArtifactIds"] = [artifact["id"] for artifact in artifacts]
        stage["error"] = None
        stage["status"] = "awaiting_review" if self._needs_review(plan, stage) else "completed"
        plan["error"] = None
        self._event(plan, "delivered", stage["title"] + "已保存完整文字成果。", stage)
        if stage["status"] == "awaiting_review":
            if plan["status"] != "paused":
                plan["status"] = "awaiting_review"
            self._event(plan, "review_required", "等待总策划审阅当前版本，确认后才会继续。", stage)
        elif not self._current(plan):
            plan["status"] = "completed"
        return True

    def _archive(self, stage):
        if stage.get("runId") or stage.get("requestId") or stage.get("artifacts"):
            stage["history"].append({key: copy.deepcopy(stage.get(key)) for key in
                                     ("attempt", "runId", "requestId", "status", "inputArtifactIds",
                                      "outputArtifactIds", "artifacts", "error", "review")})
            stage["history"][-1]["archivedAt"] = now()
        stage.update(runId=None, requestId=None, inputArtifactIds=[], outputArtifactIds=[],
                     artifacts=[], error=None, review=None)

    def _inputs(self, plan, stage):
        output = []
        for source in plan["stages"]:
            if source["id"] == stage["id"]:
                break
            if source["status"] != "completed":
                raise InputError("上游正式文字成果尚未完成审阅，暂不能交接。", 409)
            output.extend(source["artifacts"])
        if stage.get("revisionNote") and stage["history"]:
            # The previous full version is material for an actual rewrite, not
            # a browser-authored claim about what another role previously said.
            # Failed and cancelled attempts also enter history with no output;
            # they must not hide the last delivered version during a retry.
            prior_version = next((item["artifacts"] for item in reversed(stage["history"])
                                  if item.get("artifacts")), [])
            output.extend(prior_version)
        verified = []
        seen = set()
        for artifact in output:
            if artifact["id"] in seen:
                continue
            source_run = self.runtime.get("run", artifact["runId"])
            require_visible(self.runtime, "run", source_run["id"], plan["projectId"])
            require_visible(self.runtime, "artifact", artifact["id"], plan["projectId"])
            if source_run.get("projectId") != plan["projectId"] or source_run.get("peerId"):
                raise InputError("不能将其他项目的成果自动带入制作流程。", 409)
            canonical = next((item for item in source_run["artifacts"] if item["id"] == artifact["id"]), None)
            if canonical is None:
                raise InputError("引用的真实成果不存在，请检查上游版本。", 409)
            verified.append(copy.deepcopy(canonical))
            seen.add(artifact["id"])
        return verified

    def _dispatch(self, plan, stage):
        require_visible(self.runtime, "production", plan["id"], plan["projectId"])
        # All callers hold the same runtime RLock. Reserve the stage before
        # starting a run; an interrupted save can recover by deterministic ID.
        if any(run.get("status") in RUN_ACTIVE for run in self.runtime.all("run", "project:" + plan["projectId"])):
            return
        inputs = self._inputs(plan, stage)
        if not stage.get("requestId"):
            stage["attempt"] += 1
            stage["requestId"] = f"production-{plan['id']}-{stage['id']}-{stage['attempt']}"
        stage["inputArtifactIds"] = [artifact["id"] for artifact in inputs]
        stage["status"] = "running"
        self._save(plan)
        project_title = " ".join(plan["project"].get("title", "").split()) or "影视项目"
        title = (stage["title"] + f" · 第{stage['attempt']}版 · " + project_title)[:50]
        prompt = (title + "\n用户的本项目制作要求：\n" + plan["prompt"] + "\n\n本阶段职责：\n" +
                  STAGE_INSTRUCTIONS[stage["id"]] + "\n\n以下输入成果是本项目已实际生成的当前版本，请据此继续。"
                  "必须交付完整中文 Markdown 正文。缺失素材请列为待提供；不要编造研究、媒体生成、播放或验收记录。")
        if stage.get("revisionNote"):
            prompt += "\n\n总策划本次返修要求（同时提供了上一版全文）：\n" + stage["revisionNote"]
        data = {"requestId": stage["requestId"], "project": plan["project"],
                "agentIds": [stage["agentId"]], "mode": "produce", "prompt": prompt,
                "inputArtifacts": inputs, "history": [], "tasks": [], "decisions": [],
                "productionId": plan["id"], "productionStageId": stage["id"]}
        try:
            run = self.runtime.start(data, production_id=plan["id"])
        except InputError as error:
            if error.status == 429 or (error.status == 409 and any(
                    run.get("status") in RUN_ACTIVE for run in self.runtime.all("run", "project:" + plan["projectId"]))):
                stage["status"] = "pending"
                self._save(plan)
                return
            raise
        stage["runId"] = run["id"]
        self._event(plan, "dispatched", stage["agentId"] + " 已收到本阶段要求及前序真实成果。", stage)
        self._save(plan)

    def _recover(self, plan):
        if is_deleted(self.runtime, "production", plan["id"], plan.get("projectId")):
            return
        if plan.get("status") not in ("running", "paused"):
            return
        stage = self._current(plan)
        if stage is None:
            return
        try:
            run = self._run(plan, stage)
            if run and run.get("status") == "succeeded":
                self._consume(plan, stage, run)
            elif run and run.get("status") in RUN_ACTIVE:
                # A manager can be replaced while its Runtime remains alive.
                # Keep the existing invocation, never start another one.
                self._save(plan)
                return
            elif stage["status"] != "awaiting_review":
                stage["status"] = "paused"
                stage["error"] = (run or {}).get("error") or "执行服务重启，本阶段尚未完成；已保存成果保留。"
            if plan["status"] == "running":
                plan["status"] = "paused"
            if plan["status"] == "paused":
                self._event(plan, "recovered", "已恢复制作记录和已保存成果；请继续未完成阶段。", stage)
            self._save(plan)
        except Exception:
            plan["status"] = "paused"
            plan["error"] = "恢复阶段关联时发现记录不完整，已保留原成果，请检查后再继续。"
            self._event(plan, "recovery_error", plan["error"], stage)
            self._save(plan)

    def reconcile(self):
        with self.runtime.lock:
            if self._stop.is_set() or self.runtime.closed:
                return
            for plan in self.runtime.all("production"):
                if plan.get("status") != "running" or is_deleted(self.runtime, "production", plan["id"], plan.get("projectId")):
                    continue
                stage = self._current(plan)
                if stage is None:
                    continue
                try:
                    run = self._run(plan, stage)
                    if run and run.get("status") in RUN_ACTIVE:
                        continue
                    if run and self._consume(plan, stage, run):
                        self._save(plan)
                        continue
                    if run:
                        interrupted = any(step.get("status") == "interrupted" for step in run.get("steps", []))
                        stage["status"] = "paused" if interrupted else "failed"
                        stage["error"] = run.get("error") or "本阶段执行已停止；已保存成果保留，可继续重试。"
                        plan["status"] = "paused" if interrupted else "failed"
                        plan["error"] = stage["error"]
                        self._event(plan, "interrupted" if interrupted else "failed", stage["error"], stage)
                        self._save(plan)
                    elif stage["status"] == "awaiting_review":
                        plan["status"] = "awaiting_review"
                        self._save(plan)
                    else:
                        self._dispatch(plan, stage)
                except Exception as error:
                    # Only curated validation/provider errors are public. An
                    # internal traceback must never become an employee message.
                    message = str(error)[:800] if isinstance(error, InputError) else "本阶段调度失败；已保存成果保留，可继续重试。"
                    stage["status"], stage["error"] = "failed", message
                    plan["status"], plan["error"] = "failed", message
                    self._event(plan, "failed", message, stage)
                    self._save(plan)

    def pause(self, plan_id, data):
        with self.runtime.lock:
            self._check_open()
            plan = self.get(plan_id)
            self._check_revision(plan, data)
            if plan["status"] == "completed":
                raise InputError("此计划已完成，无需暂停。", 409)
            if plan["status"] == "paused":
                return plan
            plan["status"] = "paused"
            stage = self._current(plan)
            if stage:
                run = self._run(plan, stage)
                if run and run.get("status") == "succeeded":
                    self._consume(plan, stage, run)
                elif run and run.get("status") in RUN_ACTIVE:
                    self.runtime.cancel(run["id"])
                    stage["status"] = "paused"
                elif stage["status"] != "awaiting_review":
                    stage["status"] = "paused"
            self._event(plan, "paused", "自动协作已暂停，已有成果保留；继续时只处理未完成阶段。", stage)
            self._save(plan)
            return plan

    def resume(self, plan_id, data):
        with self.runtime.lock:
            self._check_open()
            plan = self.get(plan_id)
            require_visible(self.runtime, "production", plan_id, plan["projectId"])
            self._check_revision(plan, data)
            if plan["status"] not in ("paused", "failed"):
                raise InputError("请从暂停或失败的制作计划继续；待审阅阶段请先审阅。", 409)
            self._check_project_available(plan["projectId"], plan["id"])
            stage = self._current(plan)
            if stage:
                run = self._run(plan, stage)
                if run and run.get("status") == "succeeded":
                    self._consume(plan, stage, run)
                    stage = self._current(plan)
                if stage and stage["status"] == "awaiting_review":
                    plan["status"] = "awaiting_review"
                else:
                    if stage:
                        run = self._run(plan, stage)
                        if not run or run.get("status") not in RUN_ACTIVE:
                            self._archive(stage)
                            stage["status"] = "pending"
                    plan["status"] = "running" if stage else "completed"
            else:
                plan["status"] = "completed"
            plan["error"] = None
            self._event(plan, "resumed", "已继续制作；完成阶段保留，待审阅版本仍需确认。", stage)
            self._save(plan)
            self._wake.set()
            return plan

    def review(self, plan_id, data):
        with self.runtime.lock:
            self._check_open()
            plan = self.get(plan_id)
            require_visible(self.runtime, "production", plan_id, plan["projectId"])
            self._check_revision(plan, data)
            action = data.get("action")
            if action not in ("approve", "revise"):
                raise InputError("请选择确认或返修。")
            stage = next((item for item in plan["stages"] if item["id"] == data.get("stageId")), None)
            if stage is None:
                raise InputError("制作阶段不存在。", 404)
            for artifact in stage.get("artifacts", []):
                require_visible(self.runtime, "artifact", artifact.get("id"), plan["projectId"])
            note = data.get("note", "")
            if not isinstance(note, str) or len(note) > 2000:
                raise InputError("审阅意见必须是文字且不超过 2000 字。")
            if action == "approve":
                if stage["status"] != "awaiting_review" or not stage["artifacts"]:
                    raise InputError("仅可确认当前等待审阅的真实交付版本。", 409)
                stage["review"] = {"action": "approve", "note": note.strip(), "at": now(),
                                   "artifactIds": list(stage["outputArtifactIds"]), "reviewer": "user"}
                stage["status"] = "completed"
                if not self._current(plan):
                    plan["status"] = "completed"
                elif plan["status"] != "paused":
                    plan["status"] = "running"
                self._event(plan, "approved", "总策划已确认此文字成果版本。", stage)
            else:
                note = require_text(note, "返修要求", 2000)
                if not stage["artifacts"]:
                    raise InputError("请先取得本阶段交付，再发起定点返修。", 409)
                self._check_project_available(plan["projectId"], plan["id"])
                index = plan["stages"].index(stage)
                for downstream in plan["stages"][index:]:
                    run = self._run(plan, downstream)
                    if run and run.get("status") in RUN_ACTIVE:
                        self.runtime.cancel(run["id"])
                    # Capture an already-finished run before replacing its
                    # lineage, even if the scheduler has not yet consumed it.
                    if run and run.get("status") == "succeeded" and not downstream["artifacts"]:
                        downstream["artifacts"] = copy.deepcopy(run.get("artifacts", []))
                        downstream["outputArtifactIds"] = [a["id"] for a in downstream["artifacts"]]
                    self._archive(downstream)
                    downstream["status"] = "pending" if downstream is stage else "stale"
                    downstream["revisionNote"] = note if downstream is stage else ""
                stage["review"] = {"action": "revise", "note": note, "at": now(), "reviewer": "user"}
                plan["status"], plan["error"] = "running", None
                self._event(plan, "revision_requested", "已记录返修要求；本阶段将产出新版本，后续阶段按新版本重做，旧成果保留。", stage)
            self._save(plan)
            self._wake.set()
            return plan

    def close(self):
        self._stop.set()
        self._wake.set()
        with self.runtime.lock:
            for plan in self.runtime.all("production"):
                if plan.get("status") != "running":
                    continue
                stage = self._current(plan)
                plan["status"] = "paused"
                if stage:
                    run = self._run(plan, stage)
                    if run and run.get("status") == "succeeded":
                        self._consume(plan, stage, run)
                    elif run and run.get("status") in RUN_ACTIVE:
                        self.runtime.cancel(run["id"])
                        stage["status"] = "paused"
                    elif stage["status"] != "awaiting_review":
                        stage["status"] = "paused"
                self._event(plan, "service_stopped", "执行服务已停止；制作进度已保存，重开后可继续。", stage)
                self._save(plan)
        if self._thread and self._thread is not threading.current_thread():
            self._thread.join(timeout=2)

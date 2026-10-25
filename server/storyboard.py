"""Read project-owned storyboard/prompt documents without inventing shots."""

from copy import deepcopy
import re

from .runtime import InputError, identifier
from .trash import is_deleted, require_visible


LINK_FIELDS = ("projectId", "taskId", "shotId", "sourceArtifactId", "promptArtifactId", "name", "mediaKind")
IMPORT_VERSION = 2
_SHOT_ID = r"S\d{1,4}(?:[-－]\d{1,4})*"
_SHOT = re.compile(r"^(" + _SHOT_ID + r")(?=$|[\s／/｜|:：·.、-])", re.IGNORECASE)
_HEADING = re.compile(r"^#{1,6}\s+(" + _SHOT_ID + r")(?=$|[\s／/｜|:：·.、-])(.*)$", re.IGNORECASE)


def _duration(timing):
    """Read a written shot duration; never confuse a timecode with an aspect ratio."""
    seconds = re.findall(r"(\d+(?:\.\d+)?)\s*(?:秒|seconds?\b|s\b)", timing, re.IGNORECASE)
    if seconds:
        value = float(seconds[-1])
        return value if 0 < value <= 3600 else None
    clocks = re.findall(r"(?<!\d)(\d{1,2}):(\d{2}(?:\.\d+)?)(?!\d)", timing)
    if len(clocks) == 2:
        value = (float(clocks[1][0]) * 60 + float(clocks[1][1])
                 - float(clocks[0][0]) * 60 - float(clocks[0][1]))
        return round(value, 3) if 0 < value <= 3600 else None
    return None


def _plain(value):
    return re.sub(r"[*`_]", "", re.sub(r"<br\s*/?>", "\n", value, flags=re.IGNORECASE)).strip()


def _cells(line):
    return [_plain(value.replace(r"\|", "|")) for value in re.split(r"(?<!\\)\|", line.strip().strip("|"))]


def _timestamp(item):
    value = item.get("createdAt", 0)
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else 0


def _project(workspace, project_id):
    if not identifier(project_id):
        raise InputError("请选择有效项目。")
    if getattr(workspace, "runtime", None):
        require_visible(workspace.runtime, "project", project_id, project_id)
    snapshot = workspace.read() if workspace else None
    state = snapshot.get("state", {}) if snapshot else {}
    project = next((item for item in state.get("projects", [])
                    if isinstance(item, dict) and item.get("id") == project_id), None)
    if project is None:
        raise InputError("项目不存在或尚未同步到本机，请先保存项目后重试。", 404)
    return project, state


def _documents(runtime, project_id, *, include_deleted=False):
    documents = {}
    for run in runtime.all("run"):
        if run.get("projectId") != project_id or run.get("peerId") or run.get("isExample"):
            continue
        for artifact in run.get("artifacts", []):
            if (not isinstance(artifact, dict) or not identifier(artifact.get("id"))
                    or artifact.get("source") == "example" or artifact.get("isExample")):
                continue
            if not include_deleted and is_deleted(runtime, "artifact", artifact["id"], project_id):
                continue
            documents[artifact["id"]] = {**deepcopy(artifact), "projectId": project_id,
                                         "productionId": run.get("productionId"), "runId": run.get("id")}
    return documents


def _source(artifact):
    return {"id": artifact["id"], "title": str(artifact.get("title") or artifact.get("filename") or "原始文稿")[:300],
            "url": "/api/artifacts/" + artifact["id"]}


def _choose_documents(runtime, project_id, documents):
    plans = sorted((plan for plan in runtime.all("production") if plan.get("projectId") == project_id),
                   key=_timestamp, reverse=True)
    current = plans[0] if plans else None
    if current and is_deleted(runtime, "production", current["id"], project_id):
        return {"storyboard": None, "prompts": None}
    selected = {}
    for phase, role in (("storyboard", "R04"), ("prompts", "R06")):
        candidates = []
        if current:
            for stage in current.get("stages", []):
                if stage.get("id") != phase and stage.get("agentId") != role:
                    continue
                for item in stage.get("artifacts", []):
                    if (isinstance(item, dict) and item.get("id") in documents
                            and documents[item["id"]].get("authorId") == role):
                        candidates.append(documents[item["id"]])
        if not candidates:
            # Standalone project runs may supply a newer user-requested draft.
            # Never revive a retired production stage from its historical run.
            candidates = [item for item in documents.values()
                          if item.get("authorId") == role and not item.get("productionId")]
        chosen = max(candidates, key=_timestamp) if candidates else None
        # Pick the authoritative version first, then apply deletion. Selecting
        # from a filtered list would silently revive a superseded old draft.
        selected[phase] = chosen if chosen and not is_deleted(runtime, "artifact", chosen["id"], project_id) else None
    return selected


def _parse_table(body):
    if not isinstance(body, str):
        return [], []
    lines = body.splitlines()
    shots, warnings, seen = [], [], set()
    fenced = False
    index = 0
    while index + 1 < len(lines):
        if re.match(r"^\s*(```|~~~)", lines[index]):
            fenced = not fenced
            index += 1
            continue
        if fenced or "|" not in lines[index] or "|" not in lines[index + 1]:
            index += 1
            continue
        headers, separators = _cells(lines[index]), _cells(lines[index + 1])
        if len(headers) != len(separators) or not all(re.fullmatch(r":?-{3,}:?", value.replace(" ", "")) for value in separators):
            index += 1
            continue
        id_col = next((i for i, value in enumerate(headers) if re.search(r"镜号|镜头编号|shot\s*(?:id|no)", value, re.IGNORECASE)), None)
        description_col = next((i for i, value in enumerate(headers) if re.search(r"画面内容|画面描述|内容与人物|视觉内容|^画面$", value)), None)
        if id_col is None or description_col is None:
            index += 1
            continue
        timing_col = next((i for i, value in enumerate(headers) if re.search(r"时间|时长|duration|timing", value, re.IGNORECASE)), None)
        title_col = next((i for i, value in enumerate(headers) if re.search(r"^标题$|镜头名称|镜头名", value)), None)
        index += 2
        while index < len(lines) and "|" in lines[index] and lines[index].strip():
            values = _cells(lines[index])
            index += 1
            if len(values) != len(headers):
                warnings.append("分镜表有列数不一致的行，已保留原稿并跳过该行。")
                continue
            match = _SHOT.match(values[id_col])
            if not match:
                continue
            shot_id = match.group(1).upper().replace("－", "-")
            if shot_id in seen:
                warnings.append("分镜表出现重复镜号" + shot_id + "，未自动合并。")
                continue
            seen.add(shot_id)
            title = values[title_col] if title_col is not None else values[id_col][match.end():].strip(" ／/｜|:：·.、-")
            shots.append({"id": shot_id, "title": title or shot_id, "description": values[description_col],
                          "sourceTitle": title or shot_id,
                          "timing": values[timing_col] if timing_col is not None else "",
                          "imagePrompt": "", "videoPrompt": ""})
            if len(shots) >= 500:
                warnings.append("镜头数量超过读取上限，请查看原稿。")
                return shots, warnings
    return shots, warnings


def _code_under_heading(section, label):
    """Read only the named prompt subsection, including quote/paragraph drafts.

    Prefer an explicit code or quotation block over surrounding editorial text.
    A following heading always ends the subsection, so review and execution
    instructions cannot leak into model input.
    """
    lines = section.splitlines()
    fenced = False
    for index, line in enumerate(lines):
        if re.match(r"^\s*(```|~~~)", line):
            fenced = not fenced
            continue
        if fenced:
            continue
        if not re.match(r"^#{1,6}\s+", line) or not re.search(label, line):
            continue
        end = next((end for end in range(index + 1, len(lines))
                    if re.match(r"^#{1,6}\s+", lines[end])), len(lines))
        content = lines[index + 1:end]
        for start, content_line in enumerate(content):
            match = re.match(r"^\s*(`{3,}|~{3,})[^`~]*$", content_line)
            if match:
                fence = match.group(1)
                for finish in range(start + 1, len(content)):
                    if re.fullmatch(r"\s*" + re.escape(fence) + r"\s*", content[finish]):
                        return "\n".join(content[start + 1:finish]).strip()
                return ""
        quotes = [re.sub(r"^\s*>\s?", "", item) for item in content if re.match(r"^\s*>", item)]
        if quotes:
            return "\n".join(quotes).strip()
        paragraphs = []
        for item in content:
            if re.match(r"^\s*(?:[-*+]\s|\d+[.)、]\s|\||---|(?:\*\*)?(?:执行说明|可调参数|使用说明|注意事项|参考图)[：:])", item):
                break
            if re.match(r"^\s*(?:以下|下列|请将|实际使用时|提示词如下)", item):
                continue
            paragraphs.append(item)
        return "\n".join(paragraphs).strip()
    return ""


def _parse_prompts(body):
    if not isinstance(body, str):
        return {}, []
    lines, sections, fenced = body.splitlines(), [], False
    for index, line in enumerate(lines):
        if re.match(r"^\s*(```|~~~)", line):
            fenced = not fenced
        match = None if fenced else _HEADING.match(_plain(line))
        if match:
            sections.append((index, match.group(1).upper().replace("－", "-"), match.group(2).strip(" ／/｜|:：·.、-")))
    result, warnings = {}, []
    preamble = "\n".join(lines[:sections[0][0]]) if sections else ""
    prefix = _code_under_heading(preamble, r"统一视觉(?:提示)?前缀|通用视觉(?:提示)?前缀")
    ratio_lines = [line for line in preamble.splitlines() if re.search(r"画幅|宽高比|画面比例", line)]
    ratios = set(re.findall(r"(?<!\d)([1-9]\d?:[1-9]\d?)(?!\d)", "\n".join([prefix, *ratio_lines])))
    common_ratio = next(iter(ratios)) if len(ratios) == 1 else None
    for position, (start, shot_id, title) in enumerate(sections):
        if shot_id in result:
            warnings.append("提示词文稿出现重复镜号" + shot_id + "，未自动合并。")
            continue
        end = sections[position + 1][0] if position + 1 < len(sections) else len(lines)
        section = "\n".join(lines[start + 1:end])
        info = {}
        for line in lines[start + 1:end]:
            if line.strip().startswith("|"):
                values = _cells(line)
                if len(values) == 2:
                    info[values[0]] = values[1]
        heading_parts = re.split(r"[｜|]", title)
        heading_time = next((part for part in heading_parts if re.search(r"\d{1,2}:\d{2}", part)), "")
        title = " · ".join(part.strip() for part in heading_parts if part != heading_time and part.strip())
        image_prompt = _code_under_heading(section, r"生图提示词|图像提示词|图片提示词")
        if prefix and image_prompt and not image_prompt.startswith(prefix):
            image_prompt = prefix + "\n\n" + image_prompt
        result[shot_id] = {"id": shot_id, "title": title or shot_id,
                           "description": info.get("唯一信息", ""), "timing": info.get("时间", heading_time),
                           "imagePrompt": image_prompt, "aspectRatio": common_ratio,
                           "videoPrompt": _code_under_heading(section, r"视频动作提示词|视频提示词"),
                           "characterReferences": next((re.split(r"[：:]", _plain(line), maxsplit=1)[-1].strip()
                               for line in section.splitlines() if re.search(r"引用角色|出场人物|角色引用", line)), ""),
                           "referenceRequirements": next((re.split(r"[：:]", _plain(line), maxsplit=1)[-1].strip()
                               for line in section.splitlines() if "所需参考图" in line), "")}
    return result, warnings


def project_storyboard(runtime, workspace, project_id):
    with runtime.lock:
        require_visible(runtime, "project", project_id, project_id)
        project, _ = _project(workspace, project_id)
        result = {"projectId": project_id, "shots": [], "sources": [], "warnings": []}
        if project.get("isDemo"):
            result["warnings"].append("这是示例项目，没有读取真实分镜或生成提示词。")
            return result
        documents = _documents(runtime, project_id, include_deleted=True)
        selected = _choose_documents(runtime, project_id, documents)
        storyboard, prompts = selected["storyboard"], selected["prompts"]
        for artifact in (storyboard, prompts):
            if artifact and not any(source["id"] == artifact["id"] for source in result["sources"]):
                result["sources"].append(_source(artifact))
        if not result["sources"]:
            result["warnings"].append("本项目暂未产出可读取的分镜或逐镜提示词文稿。")
            return result
        if storyboard:
            result["shots"], warnings = _parse_table(storyboard.get("body", ""))
            result["warnings"].extend(warnings)
            if not result["shots"]:
                result["warnings"].append("分镜原稿格式暂无法解析为镜头，请打开原稿查看；未自动编造镜号。")
        prompt_rows = {}
        if prompts:
            if storyboard and _timestamp(prompts) < _timestamp(storyboard):
                result["warnings"].append("逐镜提示词早于当前分镜版本，未自动套用；请按当前分镜更新提示词。")
            else:
                prompt_rows, warnings = _parse_prompts(prompts.get("body", ""))
                result["warnings"].extend(warnings)
                if not prompt_rows:
                    result["warnings"].append("提示词原稿格式暂无法解析，请打开原稿查看。")
        if not storyboard and prompt_rows:
            result["shots"] = list(prompt_rows.values())
            result["warnings"].append("尚无分镜表；当前镜号与镜头内容来自真实逐镜提示词原稿。")
        for shot in result["shots"]:
            prompt = prompt_rows.get(shot["id"])
            shot["sourceArtifactId"] = (storyboard or prompts)["id"]
            shot["promptArtifactId"] = prompts["id"] if prompt else None
            if prompt:
                shot["imagePrompt"], shot["videoPrompt"] = prompt["imagePrompt"], prompt["videoPrompt"]
                shot["aspectRatio"] = prompt.get("aspectRatio")
                shot["characterReferences"] = prompt.get("characterReferences", "")
                shot["referenceRequirements"] = prompt.get("referenceRequirements", "")
                if "-" in shot["id"] or shot["title"] == shot["id"]:
                    shot["title"] = prompt["title"]
                if not shot.get("timing"):
                    shot["timing"] = prompt.get("timing", "")
            shot["targetDuration"] = _duration(shot.get("timing", ""))
            if not shot["imagePrompt"] or not shot["videoPrompt"]:
                result["warnings"].append(shot["id"] + "的生图或视频提示词尚不完整，可核对原稿后手动补充。")
        result["warnings"] = list(dict.fromkeys(result["warnings"]))
        return result


def media_project_metadata(runtime, workspace, data, *, allow_deleted_sources=False):
    """Validate association independently of the provider's generation payload."""
    context = {field: data[field] for field in LINK_FIELDS if field in data and data[field] is not None}
    for field in ("projectId", "taskId", "shotId", "sourceArtifactId", "promptArtifactId"):
        if field in context and not identifier(context[field]):
            raise InputError("媒体关联编号格式无效。")
    if "name" in context and (not isinstance(context["name"], str) or not context["name"].strip() or len(context["name"]) > 160):
        raise InputError("媒体名称须为1至160字。")
    if "mediaKind" in context and context["mediaKind"] not in ("image", "video"):
        raise InputError("媒体类型只支持图片或视频。")
    project_id = context.get("projectId")
    if not project_id:
        if any(field in context for field in ("taskId", "shotId", "sourceArtifactId", "promptArtifactId")):
            raise InputError("关联任务、镜头或原稿时必须指定项目。")
        return context
    with runtime.lock:
        require_visible(runtime, "project", project_id, project_id)
        project, state = _project(workspace, project_id)
        if project.get("isDemo"):
            raise InputError("请先创建真实项目，再关联媒体生成。")
        if context.get("taskId") and not allow_deleted_sources:
            require_visible(runtime, "task", context["taskId"], project_id)
        for field in ("sourceArtifactId", "promptArtifactId"):
            if context.get(field) and not allow_deleted_sources:
                require_visible(runtime, "artifact", context[field], project_id)
        if "taskId" in context and not any(isinstance(task, dict) and task.get("id") == context["taskId"]
                                          and task.get("projectId") == project_id for task in state.get("tasks", [])):
            raise InputError("关联任务必须属于当前项目。")
        documents = _documents(runtime, project_id, include_deleted=allow_deleted_sources)
        for field in ("sourceArtifactId", "promptArtifactId"):
            if field in context and context[field] not in documents:
                raise InputError("关联原稿必须属于当前项目。")
        if "shotId" in context:
            board = project_storyboard(runtime, workspace, project_id)
            shot = next((item for item in board["shots"] if item["id"] == context["shotId"]), None)
            if not shot or context.get("sourceArtifactId") != shot["sourceArtifactId"]:
                raise InputError("镜头或分镜原稿已变化，请刷新本项目分镜后重新选择。", 409)
            if "promptArtifactId" in context and context["promptArtifactId"] != shot["promptArtifactId"]:
                raise InputError("该镜头的提示词原稿已变化，请刷新后重新选择。", 409)
        return context

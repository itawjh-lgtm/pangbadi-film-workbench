"""Extract project character drafts; text is never evidence of an approved image."""
from __future__ import annotations

from copy import deepcopy
import hashlib
import json
import re
from urllib.parse import parse_qs, urlsplit
from datetime import datetime, timedelta, timezone

from .runtime import InputError, identifier
from .storyboard import _documents, _plain
from .trash import is_deleted


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def _asset_plain(value):
    # Markdown emphasis is removable, but underscores inside stable asset IDs
    # are data rather than markup.
    return re.sub(r"<br\s*/?>", "\n", value, flags=re.IGNORECASE).replace("*", "").replace("`", "").strip().strip("_")


def _asset_cells(line):
    return [_asset_plain(value.replace(r"\|", "|")) for value in re.split(r"(?<!\\)\|", line.strip().strip("|"))]


def _sections(body):
    lines = body.splitlines()
    headings = []
    for index, line in enumerate(lines):
        match = re.match(r"^(#{1,6})\s+(.+)$", line)
        if match:
            headings.append((index, len(match[1]), _asset_plain(match[2])))
    result = []
    for position, (start, level, title) in enumerate(headings):
        end = next((at for at, depth, _ in headings[position + 1:] if depth <= level), len(lines))
        result.append((title, "\n".join(lines[start + 1:end]).strip(), start + 1, end))
    return result


CHARACTER_FIELDS = {
    "identityAge": ("身份与年龄", "身份年龄", "身份/年龄", "身份及年龄", "年龄观感"),
    "appearance": ("外貌与身形五官", "外貌身形五官", "外貌", "身形与五官"),
    "hair": ("发型", "发型与发色"),
    "costume": ("服装与配饰", "服装配饰", "服装"),
    "distinctiveFeatures": ("辨识特征", "识别特征", "独特特征", "固定辨识点"),
    "performance": ("性格与表演", "性格表演", "姿态与表演", "姿态与表情表"),
    "views": ("定妆视图", "所需视图", "参考图视图"),
    "referencePrompt": ("参考图生成提示词", "定妆生成提示词", "定妆提示词"),
    "immutableTraits": ("不可改变项", "固定项", "禁止项"),
    "variants": ("换装版本", "服装版本", "造型版本"),
    "shotLinks": ("出场镜头关联", "出场关联", "镜头关联"),
    "sourceBasis": ("依据与性质", "来源与性质", "设定依据", "来源依据"),
}
_CHAR_CODE = r"CHR[-_][A-Za-z0-9_-]+"
_CHAR_AREA = re.compile(r"角色视觉设定|人物资产(?:说明|清单|总表|卡)?|人物设定|角色设定|角色设计|角色明细")
_OTHER_AREA = re.compile(r"场景(?:设定|设计|资产)|道具(?:设定|设计|资产)|制作团队|工作人员|岗位分工|协作成员|员工(?:名单|职责)|交付记录")
_GENERIC_NAMES = {"人物", "角色", "主角", "配角", "员工", "工作人员", "暂无", "待定", "未提供", "无", "不适用",
                  "参考图", "角色视觉设定", "人物资产", "外貌", "服装", "发型", "场景", "道具", "美术指导", "项目主控"}


def _character_fields(description):
    """Read explicit labels only; missing information stays missing."""
    fields = {}
    labels = {label: key for key, aliases in CHARACTER_FIELDS.items() for label in aliases}
    boundary = re.compile(r"^(?:" + "|".join(re.escape(label) for label in (*labels, "资产类型", "类别")) + r")\s*[：:]")
    # Descriptions are already scoped to one character card. Exclude any
    # explicitly nested non-character asset or another CHR card as well.
    excluded = {index for title, _, start, end in _sections(description)
                if _OTHER_AREA.search(title) or re.search(_CHAR_CODE, title)
                for index in range(start - 1, end)}
    lines = [line if index not in excluded else "" for index, line in enumerate(description.splitlines())]
    description = "\n".join(lines)
    for index, line in enumerate(lines):
        plain = _asset_plain(re.sub(r"^\s*(?:[-+*]\s+|>\s*)", "", line))
        match = re.match(r"^([^：:]{1,32})\s*[：:]\s*(.*)$", plain)
        if match and match[1].strip() in labels:
            continuation = []
            for following in lines[index + 1:]:
                following_plain = _asset_plain(re.sub(r"^\s*(?:[-+*]\s+|>\s*)", "", following))
                if re.match(r"^#{1,6}\s", following) or boundary.match(following_plain):
                    break
                continuation.append(following)
            content = "\n".join([match[2], *continuation]).strip()
            if content:
                fields[labels[match[1].strip()]] = content
    for title, content, _, _ in _sections(description):
        title = re.sub(r"^\d+(?:\.\d+)*[、.\s]*", "", title).strip()
        if title in labels and content and labels[title] not in fields:
            fields[labels[title]] = content
    table_values = {}
    table_labels = {**labels, **{label: "appearance" for label in ("面部轮廓", "脸型", "眉眼", "鼻口", "肤色", "身形", "体态", "妆容")}}
    for line in lines:
        if not line.lstrip().startswith("|"):
            continue
        cells = _asset_cells(line)
        if len(cells) == 2 and cells[0] in table_labels and cells[1].strip():
            table_values.setdefault(table_labels[cells[0]], []).append(cells[0] + "：" + cells[1])
    for key, values in table_values.items():
        # A complete titled section is already stronger evidence and includes
        # its table. Otherwise retain every explicitly labeled row verbatim.
        if key not in fields:
            fields[key] = "\n".join(dict.fromkeys(values))
    return fields


def parse_character_descriptions(body, anchors=None):
    """Parse explicit CHR cards/tables plus the established numbered R05 format."""
    anchors = anchors or {}
    sections, rows, warnings = _sections(body), [], []
    scope, scope_level = "", 0
    scopes = {}
    lines = body.splitlines()
    for title, content, start, end in sections:
        level = len(re.match(r"^#+", lines[start - 1])[0])
        if scope == "other" and level > scope_level:
            # A nested '角色设计' in a prop/staff section cannot override its
            # parent asset type. Legacy R05 numbered siblings remain supported.
            pass
        elif _OTHER_AREA.search(title) and not re.search(_CHAR_CODE, title):
            scope, scope_level = "other", level
        elif _CHAR_AREA.search(title) and not re.search(_CHAR_CODE, title):
            scope, scope_level = "character", level
        elif re.match(r"^[一二三四五六七八九十]+[、.，]\s*", title) and not _CHAR_AREA.search(title):
            scope, scope_level = "", 0
        scopes[start] = scope
    for index, line in enumerate(body.splitlines(), 1):
        if "|" not in line:
            continue
        cells = _asset_cells(line)
        if cells and re.fullmatch(_CHAR_CODE, cells[0]):
            previous = [start for start in scopes if start <= index]
            if previous and scopes[max(previous)] == "other":
                continue
            rows.append((cells[0], cells[1] if len(cells) > 1 else "人物"))
    for title, content, start, end in sections:
        match = re.search(r"\b(" + _CHAR_CODE + r")\b", title)
        if match and scopes.get(start) != "other":
            name = (title[:match.start()] + title[match.end():]).strip(" ｜|:：·-")
            name = re.sub(r"^\d+(?:\.\d+)*\s*", "", name).strip()
            if not any(code == match[1] for code, _ in rows):
                rows.append((match[1], name))
    numbered = [s for s in sections if re.match(r"\d+\.\d+\s+", s[0]) and scopes.get(s[2]) == "character"
                and re.search(r"角色|主角|群像|少女|少年|人物", s[0])]
    if not rows:
        rows = [("CHAR-" + digest(section[0])[:16], section[0].split("｜")[0].split(" ", 1)[-1]) for section in numbered]
    entries, seen = [], set()
    for code, role in rows[:50]:
        if code in seen:
            continue
        anchor = anchors.get(code, {})
        exact = [s for s in sections if re.search(r"\b" + re.escape(code) + r"\b", s[0]) and scopes.get(s[2]) != "other"]
        candidates = exact or [s for s in sections if re.match(r"\d+\.\d+\s+", s[0]) and scopes.get(s[2]) != "other"
            and (role in s[0] or anchor.get("name") and (anchor["name"] in s[0] or
                s[0].split("｜")[0].split(" ", 1)[-1] in anchor["name"]))]
        if len(candidates) > 1:
            warnings.append(code + " 对应多个角色明细，暂不自动建立人物，请保留唯一资产编号。")
            continue
        section = candidates[0] if candidates else None
        if exact and section:
            name = re.sub(r"\b" + re.escape(code) + r"\b", "", section[0]).strip(" ｜|:：·-")
            name = re.sub(r"^\d+(?:\.\d+)*\s*", "", name).strip().split("｜")[0].split("|")[0].strip() or role
        else:
            name = re.sub(r"^\d+(?:\.\d+)*\s*", "", section[0]).split("｜")[0].strip() if section else anchor.get("name", role)
        description = section[1] if section else anchor.get("content", "")
        if name in _GENERIC_NAMES or re.fullmatch(r"[RG]\d{2}", name or "") or not description.strip():
            warnings.append(code + " 缺少可识别的项目人物名称或明细，未自动导入。")
            continue
        declared_type = re.search(r"(?:资产类型|类别)\s*[：:]\s*([^\n]+)", _plain(description))
        if declared_type and re.search(r"场景|道具|工作人员|员工|制作团队", declared_type[1]):
            warnings.append(code + " 声明为非项目人物资产，未自动导入。")
            continue
        seen.add(code)
        fields = _character_fields(description)
        entries.append({"sourceAssetId": code, "name": name[:120], "description": description[:15000],
                        "sourceRange": {"start": section[2], "end": section[3]} if section else None,
                        "aliases": list(dict.fromkeys(value for value in (name, role, anchor.get("name", ""))
                                                      if value and value not in _GENERIC_NAMES)),
                        "fields": fields, "missingFields": [CHARACTER_FIELDS[key][0] for key in CHARACTER_FIELDS if key not in fields],
                        "sourceNature": "placeholder" if "占位" in description or "占位" in body[:1500] else "design"})
    no_characters = bool(re.search(r"(?:^|\n)\s*(?:[-*>]\s*)?(?:人物资产\s*[：:]\s*(?:无(?:[；;。，,\s]|$)|不适用)|"
        r"(?:本项目|本片|本次作品)(?:为纯场景|是纯场景|为纯场景项目)?[，,；;：:\s]*(?:无需|不需要)人物资产)", _asset_plain(body)))
    return {"characters": entries, "warnings": warnings, "noCharactersDeclared": no_characters and not entries}


def _character_sources(artifacts, anchors=None):
    sources = [(artifact, parse_character_descriptions(artifact.get("body", ""), anchors)) for artifact in artifacts or []]
    counts = {}
    for _, parsed in sources:
        for item in parsed["characters"]:
            counts[item["sourceAssetId"]] = counts.get(item["sourceAssetId"], 0) + 1
    duplicates = {code for code, count in counts.items() if count > 1}
    warnings = [code + " 在多份当前角色原稿中重复，暂不自动建立人物，请明确唯一资产编号与来源。" for code in sorted(duplicates)]
    return sources, duplicates, warnings


def character_asset_report(artifacts):
    """Non-blocking text completeness report, also usable before user approval."""
    sources, duplicates, warnings = _character_sources(artifacts)
    characters, no_characters = [], False
    for artifact, parsed in sources:
        no_characters = no_characters or parsed["noCharactersDeclared"]
        warnings.extend(parsed["warnings"])
        for item in parsed["characters"]:
            if item["sourceAssetId"] in duplicates:
                continue
            characters.append({**item, "sourceArtifactId": artifact.get("id")})
            if item["missingFields"]:
                warnings.append(item["name"] + " 未识别独立字段，请核对/补充：" + "、".join(item["missingFields"]) + "。已有原稿与人物草稿保留。")
    if not characters and not no_characters and artifacts:
        warnings.append("尚未识别到人物资产明细；请补充 CHR 编号人物卡，纯场景项目请明确写“无需人物资产”。")
    return {"contractVersion": 1, "characters": characters, "warnings": list(dict.fromkeys(warnings)),
            "noCharactersDeclared": no_characters and not characters,
            "status": "needs_details" if warnings else "ready" if characters else "not_applicable" if no_characters else "not_started",
            "evidenceLevel": "text_only", "imageApprovalIncluded": False}


def character_drafts(runtime, project_id):
    """Only the current reviewed R05 version can create automatic character drafts."""
    plans = sorted((p for p in runtime.all("production") if p.get("projectId") == project_id),
                   key=lambda p: p.get("createdAt", 0), reverse=True)
    if not plans:
        return {"assets": [], "sourceVersion": "", "warnings": []}
    plan = plans[0]
    if is_deleted(runtime, "production", plan["id"], project_id):
        return {"assets": [], "sourceVersion": "", "warnings": []}
    stages = {stage.get("id"): stage for stage in plan.get("stages", [])}
    visual, delivery = stages.get("visual", {}), stages.get("delivery", {})
    review, final = visual.get("review") or {}, delivery.get("review") or {}
    def accepted(stage, decision):
        return (decision.get("action") == "approve" and decision.get("reviewer") == "user"
                and bool(stage.get("outputArtifactIds"))
                and set(decision.get("artifactIds", [])) == set(stage["outputArtifactIds"]))
    if visual.get("status") != "completed" or not (accepted(visual, review) or
            plan.get("status") == "completed" and accepted(delivery, final)):
        return {"assets": [], "sourceVersion": "", "warnings": []}
    documents = _documents(runtime, project_id, include_deleted=True)
    visual_ids = visual.get("outputArtifactIds", [])
    if (not visual_ids or set(visual_ids) != {a.get("id") for a in visual.get("artifacts", [])}
            or any(a not in documents or documents[a].get("authorId") != "R05"
                   or is_deleted(runtime, "artifact", a, project_id) for a in visual_ids)):
        return {"assets": [], "sourceVersion": "", "warnings": ["当前角色设定原稿不可用，请恢复或重新确认。"]}
    sources = [documents[a] for a in visual_ids]
    source_version = digest([plan["id"], [(a["id"], digest(a.get("body", ""))) for a in sources]])
    prompt_stage = stages.get("prompts", {})
    prompt_sources = [documents[a] for a in prompt_stage.get("outputArtifactIds", [])
                      if a in documents and documents[a].get("authorId") == "R06"
                      and not is_deleted(runtime, "artifact", a, project_id)]
    anchors = {}
    for artifact in prompt_sources:
        for title, content, _, _ in _sections(artifact.get("body", "")):
            match = re.search(r"\b(CHR[-_][A-Za-z0-9_-]+)\b", title)
            if match:
                name = title[:match.start()].strip(" ｜|:：·-")
                anchors[match[1]] = {"name": name, "content": content, "artifactId": artifact["id"]}
    parsed_sources, duplicates, warnings = _character_sources(sources, anchors)
    assets, seen_codes = [], set()
    for artifact, parsed in parsed_sources:
        body = artifact.get("body", "")
        sections = _sections(body)
        warnings.extend(parsed["warnings"])
        for entry in parsed["characters"]:
            code, name, description = entry["sourceAssetId"], entry["name"], entry["description"]
            if code in seen_codes or code in duplicates:
                continue
            seen_codes.add(code)
            aliases = entry["aliases"]
            reference_ids = []
            for prompt_source in prompt_sources:
                for line in prompt_source.get("body", "").splitlines():
                    cells = _asset_cells(line) if line.strip().startswith("|") else []
                    if len(cells) >= 2 and re.fullmatch(r"CH[-_][A-Za-z0-9_-]+", cells[0]) and any(a in cells[1] for a in aliases):
                        reference_ids.append(cells[0])
            style = next((content for title, content, _, _ in sections if "整体风格规则" in title), "")
            ensemble = bool(re.search(r"群像|同学组|围观同学", name + " " + " ".join(aliases)))
            views = ("群像按来源分别呈现各人物的全身与头像，区分脸型、发型轮廓、身高肩形和服装细节，禁止复制同一张脸。" if ensemble else
                     "单角色正面、侧面、背面全身与头像特写组成无文字定妆设定图，各视图保持同一脸型、发型和服装。")
            prompt = ("人物定妆生成要求（尚未生成或审图）：" + name + "。保留下方 R05 的身份、年龄观感、姓名和服装特征；"
                      "精修有辨识度的五官与发型轮廓，保持协调人体比例；强化服装剪裁与层次，采用来源规定的低饱和配色；"
                      "主次线条清楚干净，材质表现克制且一致，避免僵硬表情与模板化同脸。" + views +
                      "中性简洁背景，完整显示发顶与鞋底，不加入镜头剧情动作、文字标注或未经确认的新装饰。\n\n" +
                      ("视觉规则：\n" + style[:4000] + "\n\n" if style else "") + description[:12000])
            assets.append({"id": "character-" + digest([project_id, code, source_version])[:24],
                "sourceAssetId": code, "name": name[:120], "description": description[:15000], "prompt": prompt[:20000],
                "sourceArtifactId": artifact["id"], "sourceVersion": source_version,
                "sourceRange": entry["sourceRange"], "fields": entry["fields"], "missingFields": entry["missingFields"],
                "aliases": aliases, "referenceIds": list(dict.fromkeys(reference_ids)), "version": 1,
                "sourceNature": entry["sourceNature"]})
    return {"assets": assets, "sourceVersion": source_version, "warnings": list(dict.fromkeys(warnings))}


def required_character_ids(shot, assets):
    text = shot.get("characterReferences", "")
    refs = shot.get("referenceRequirements", "")
    # Explicit per-shot references win. Never apply every cast member to every shot.
    if not text and not refs:
        text = shot.get("description", "") + "\n" + shot.get("imagePrompt", "")
    return [asset["id"] for asset in assets if
            any(alias and alias in text for alias in asset.get("aliases", [])) or
            any(ref in refs for ref in asset.get("referenceIds", []))]


def image_output(job, index):
    if job.get("status") != "succeeded" or job.get("mediaKind") != "image":
        raise InputError("请先生成人物图片，再选择已成功返回的图片确认。", 409)
    outputs = job.get("outputs", [])
    if type(index) is not int or index < 0 or index >= len(outputs):
        raise InputError("请选择有效的图片输出。")
    output = outputs[index]
    if not isinstance(output, dict):
        raise InputError("图片输出格式无效，请选择有效图片。")
    url = output.get("url", "")
    try:
        parsed = urlsplit(url) if isinstance(url, str) else None
    except ValueError:
        parsed = None
    if (not parsed or parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
            or re.search(r"[\s<>\"'\\\x00-\x1f]", url)):
        raise InputError("参考图必须是有效的 HTTPS 图片地址。")
    extension = parsed.path.lower().rsplit(".", 1)[-1]
    mime = str(output.get("outputType", "")).lower()
    if extension not in {"png", "jpg", "jpeg"} and mime not in {"image/png", "image/jpeg", "png", "jpg", "jpeg"}:
        raise InputError("人物参考目前支持 PNG / JPEG 图片，请选择兼容的输出。")
    query = parse_qs(parsed.query)
    lower_query = {key.lower(): value for key, value in query.items()}
    if "x-amz-date" in lower_query and "x-amz-expires" in lower_query:
        try:
            signed_at = datetime.strptime(lower_query["x-amz-date"][0], "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)
            expires_at = signed_at + timedelta(seconds=float(lower_query["x-amz-expires"][0]))
        except (ValueError, OverflowError):
            raise InputError("参考图片签名有效期无效，请重新取得图片链接。", 409)
        if expires_at <= datetime.now(timezone.utc):
            raise InputError("参考图片链接已过期，请重新取得可用图片后确认。", 409)
    for key, values in query.items():
        if key.lower() in {"expires", "expiry", "expiration"}:
            try:
                expiration = float(values[0])
            except ValueError:
                continue
            if expiration > 1e12:
                expiration /= 1000
            if expiration < datetime.now(timezone.utc).timestamp():
                raise InputError("参考图片链接已过期，请重新取得可用图片后确认。", 409)
    return url

"""R05 text contracts are inspectable without regeneration or media requests."""
from copy import deepcopy
import unittest

from server.production import VISUAL_ASSET_INSTRUCTIONS
from server.project_assets import CHARACTER_FIELDS, character_asset_report, character_drafts, parse_character_descriptions
from server.trash import entry_id
import test_production as production_fixtures
import test_project_assets as asset_fixtures


CARD = """### CHR-001｜林遥
- 资产类型：人物
- 身份与年龄：实习修复师，约 22 岁观感；年龄为创作建议。
- 外貌与身形五官：清瘦中等身高、长椭圆脸、平直眉、浅棕肤色。
- 发型：黑色齐肩直发，左侧分缝，右侧收耳后。
- 服装与配饰：雾蓝工作衬衣、米白长裤、白鞋、左胸布袋。
- 辨识特征：左眉尾浅疤，圆形铜扣，左右不对称发型。
- 性格与表演：谨慎专注，观察时微前倾，笑容克制。
- 定妆视图：正侧背全身及头像特写，未生成、待审。
- 参考图生成提示词：
> 林遥单角色无字定妆图，3:4，正侧背全身与头像，保持同一脸型。
> 风格：二维漫画，低饱和配色，中性背景，服装层次完整。
> 保留角色编号 CHR_MAIN_01 对应造型，不绘制编号文字。
- 不可改变项：左眉尾浅疤、分缝方向、铜扣及基础服装。
- 换装版本：当前仅基础版，无换装要求。
- 出场镜头关联：关联剧本场次 S01 修复室；镜号待 R04 编排。
- 依据与性质：职业来自用户简报；年龄、外貌为原创设计，非已核实原作事实。
"""
COMPLETE = """# 项目人物与视觉设定
## 人物资产总表
| 资产编号 | 角色名 | 身份与年龄 | 依据与性质 | 出场关联 |
|---|---|---|---|---|
| CHR-001 | 林遥 | 修复师 | 创作设计 | S01 |
## 人物资产明细
""" + CARD


class CharacterContractTests(unittest.TestCase):
    def report(self, body):
        return character_asset_report([{"id": "r05-current", "body": body}])

    def test_complete_table_and_card_read_twelve_fields_without_mutating_source(self):
        source = {"id": "r05-current", "body": COMPLETE}
        original = deepcopy(source)
        report = character_asset_report([source])
        self.assertEqual(source, original)
        self.assertEqual(report["status"], "ready")
        self.assertEqual(len(report["characters"]), 1)
        person = report["characters"][0]
        self.assertEqual(person["name"], "林遥")
        self.assertEqual(person["sourceAssetId"], "CHR-001")
        self.assertEqual(set(person["fields"]), set(CHARACTER_FIELDS))
        self.assertEqual(person["missingFields"], [])
        self.assertEqual(person["sourceArtifactId"], source["id"])
        self.assertIn("待 R04 编排", person["fields"]["shotLinks"])
        self.assertEqual(COMPLETE.splitlines()[person["sourceRange"]["start"] - 1], "### CHR-001｜林遥")
        self.assertEqual(report["evidenceLevel"], "text_only")
        self.assertFalse(report["imageApprovalIncluded"])

    def test_card_without_table_and_underscore_id_preserves_multiline_prompt(self):
        report = self.report(CARD.replace("CHR-001", "CHR_MAIN_01"))
        self.assertEqual(report["status"], "ready")
        person = report["characters"][0]
        self.assertEqual(person["sourceAssetId"], "CHR_MAIN_01")
        prompt = person["fields"]["referencePrompt"]
        self.assertIn("风格：二维漫画", prompt)
        self.assertIn("CHR_MAIN_01", prompt)
        self.assertNotIn("不可改变项", prompt)

    def test_legacy_numbered_roles_retain_names_ids_and_placeholder_nature(self):
        report = self.report(asset_fixtures.VISUAL)
        self.assertEqual([c["name"] for c in report["characters"]], ["少女", "女生甲", "围观同学"])
        self.assertEqual([c["sourceAssetId"] for c in report["characters"]],
                         ["CHR-MAIN-PLACEHOLDER", "CHR-ANT-PLACEHOLDER", "CHR-CROWD-01"])
        self.assertEqual({c["sourceNature"] for c in report["characters"]}, {"placeholder"})
        self.assertEqual(report["status"], "needs_details")
        self.assertTrue(all(c["missingFields"] for c in report["characters"]))

    def test_nested_staff_and_other_asset_sections_cannot_become_project_characters(self):
        body = """# R05
## 制作团队
### 角色设计
#### CHR-STAFF｜顾文熙
外貌：员工形象。
## 场景设计
### 人物设定
#### CHR-ROOM｜教室
外貌：场景示意。
## 道具资产
### PROP-001｜书包
外貌：红色。
## 人物资产
### CHR-GENERIC｜主角
外貌：待定。
### CHR-ROLE｜R05
外貌：美术岗位。
### CHR-SCENE｜花园
资产类型：场景
外貌：绿色。
### CHR-PROP｜课本
资产类型：道具
外貌：蓝色。
""" + CARD
        report = self.report(body)
        self.assertEqual([c["name"] for c in report["characters"]], ["林遥"])
        self.assertTrue(any("非项目人物" in message for message in report["warnings"]))

    def test_story_character_may_have_staff_job_when_explicitly_a_character(self):
        report = self.report(CARD.replace("林遥", "工作人员甲"))
        self.assertEqual([c["name"] for c in report["characters"]], ["工作人员甲"])

    def test_pure_scene_declaration_is_explicit_and_does_not_invent_people(self):
        for body in ("人物资产：无；本项目无需人物资产\n依据：用户仅要求空镜。",
                     "本项目为纯场景，无需人物资产。"):
            with self.subTest(body=body):
                report = self.report(body)
                self.assertEqual(report["status"], "not_applicable")
                self.assertEqual(report["characters"], [])
                self.assertTrue(report["noCharactersDeclared"])
        for body in ("请填写‘无需人物资产’或补齐人物卡。", "请注明本项目无需人物资产。",
                     "例如“人物资产：无”；这只是示例，请补充实际结论。"):
            with self.subTest(body=body):
                report = self.report(body)
                self.assertEqual(report["status"], "needs_details")
                self.assertFalse(report["noCharactersDeclared"])

    def test_partial_card_is_retained_and_missing_fields_are_specific(self):
        report = self.report("### CHR-001｜林遥\n**外貌：** 清瘦，长椭圆脸。\n")
        self.assertEqual(report["status"], "needs_details")
        self.assertEqual(report["characters"][0]["fields"], {"appearance": "清瘦，长椭圆脸。"})
        self.assertNotIn("外貌与身形五官", report["characters"][0]["missingFields"])
        self.assertIn("参考图生成提示词", report["characters"][0]["missingFields"])
        self.assertTrue(any("未识别独立字段，请核对/补充" in warning for warning in report["warnings"]))

    def test_two_column_legacy_fields_preserve_uncertainty_and_stay_in_own_card(self):
        body = """## 人物资产
### CHR-001｜少女
#### 外貌
| 项目 | 设计要求 |
|---|---|
| 年龄观感 | 暂按高中阶段约 16—18 岁处理，待原作核实 |
| 面部轮廓 | 偏短的椭圆脸 |
| 眉眼 | 平直细眉 |
| 鼻口 | 鼻尖清楚 |
| 发型 | 深棕黑及肩发 |
| 固定辨识点 | 左侧额发不规则缺口 |
### CHR-002｜女生甲
| 项目 | 设计要求 |
|---|---|
| 年龄观感 | 与少女同龄或略大半级，待核实 |
| 面部轮廓 | 较窄长的脸型 |
| 眉眼 | 眉峰明确 |
| 鼻口 | 鼻梁平直 |
| 发型 | 深栗色长发 |
| 固定辨识点 | 右侧鬓发收于耳后 |
#### 场景设计
| 项目 | 设计要求 |
|---|---|
| 参考图生成提示词 | 不应导入人物的场景提示词 |
## 场景资产
### SCN-001｜教室
| 发型 | 场景内不能借给角色的值 |
"""
        report = self.report(body)
        first, second = report["characters"]
        self.assertIn("待原作核实", first["fields"]["identityAge"])
        self.assertIn("16—18", first["fields"]["identityAge"])
        self.assertIn("深棕黑及肩发", first["fields"]["hair"])
        self.assertIn("左侧额发不规则缺口", first["fields"]["distinctiveFeatures"])
        self.assertIn("同龄或略大半级，待核实", second["fields"]["identityAge"])
        self.assertIn("深栗色长发", second["fields"]["hair"])
        self.assertIn("眉眼：眉峰明确", second["fields"]["appearance"])
        self.assertIn("鼻口：鼻梁平直", second["fields"]["appearance"])
        self.assertNotIn("林遥", second["fields"]["appearance"])
        self.assertNotIn("深棕黑", second["fields"]["hair"])
        for person in (first, second):
            for label in ("身份与年龄", "发型", "辨识特征"):
                self.assertNotIn(label, person["missingFields"])
            self.assertNotIn("referencePrompt", person["fields"])

    def test_duplicate_cards_or_current_artifacts_do_not_arbitrarily_select_one(self):
        report = self.report(CARD + CARD.replace("林遥", "林舟"))
        self.assertEqual(report["characters"], [])
        self.assertTrue(any("多个角色明细" in warning for warning in report["warnings"]))
        report = character_asset_report([{"id": "a", "body": CARD}, {"id": "b", "body": CARD}])
        self.assertEqual(report["characters"], [])
        self.assertTrue(any("多份当前角色原稿" in warning for warning in report["warnings"]))


class ProductionCharacterReportTests(unittest.TestCase):
    setUp = production_fixtures.ProductionTests.setUp
    tearDown = production_fixtures.ProductionTests.tearDown
    payload = production_fixtures.ProductionTests.payload
    wait_for = production_fixtures.ProductionTests.wait_for
    approve = production_fixtures.ProductionTests.approve

    def completed_plan(self):
        plan = self.manager.start(self.payload())
        plan.update(status="completed", currentStageId=None)
        for stage in plan["stages"]:
            stage["status"] = "completed"
        visual = next(s for s in plan["stages"] if s["id"] == "visual")
        visual.update(artifacts=[{"id": "legacy-artifact", "authorId": "R05", "body": asset_fixtures.VISUAL}],
                      outputArtifactIds=["legacy-artifact"], attempt=1,
                      review={"action": "approve", "reviewer": "user", "artifactIds": ["legacy-artifact"]})
        visual.pop("characterAssetReport", None)
        self.runtime.save("production", plan)
        return plan

    def test_get_and_list_derive_report_without_rewriting_completed_plan_or_running_agents(self):
        original = self.completed_plan()
        before = self.runtime.get("production", original["id"])
        for result in (self.manager.get(original["id"]), self.manager.list("project-a")[0]):
            report = next(s for s in result["stages"] if s["id"] == "visual")["characterAssetReport"]
            self.assertEqual(len(report["characters"]), 3)
            self.assertEqual(report["status"], "needs_details")
            self.assertEqual(result["revision"], original["revision"])
        self.assertEqual(self.runtime.get("production", original["id"]), before)
        self.assertEqual(self.provider.calls, [])
        self.assertEqual(self.runtime.all("media"), [])

    def test_deleted_artifact_is_excluded_from_current_report(self):
        plan = self.completed_plan()
        self.runtime.save("trash", {"id": entry_id("artifact", "legacy-artifact", "project-a"),
            "kind": "artifact", "targetId": "legacy-artifact", "projectId": "project-a"})
        result = self.manager.get(plan["id"])
        visual = next(s for s in result["stages"] if s["id"] == "visual")
        self.assertEqual(visual["characterAssetReport"]["characters"], [])
        self.assertEqual(visual["artifacts"][0]["body"], asset_fixtures.VISUAL)
        self.assertEqual(self.provider.calls, [])

    def test_r05_dispatch_gets_contract_and_missing_fields_do_not_block_approval(self):
        plan = self.manager.start(self.payload())
        plan = self.wait_for(plan["id"], lambda p: p["status"] == "awaiting_review")
        plan = self.approve(plan, "script")
        plan = self.wait_for(plan["id"], lambda p: p["status"] == "awaiting_review")
        r05 = next(call for call in self.provider.calls if call["agent"] == "R05")
        self.assertIn(VISUAL_ASSET_INSTRUCTIONS, r05["prompt"])
        visual = next(s for s in plan["stages"] if s["id"] == "visual")
        self.assertEqual(visual["characterAssetReport"]["status"], "needs_details")
        approved = self.approve(plan, "visual")
        self.assertEqual(next(s for s in approved["stages"] if s["id"] == "visual")["review"]["action"], "approve")
        self.assertEqual(self.runtime.all("media"), [])


class CharacterDraftConflictTests(unittest.TestCase):
    setUp = asset_fixtures.ProjectAssetTests.setUp
    transport = asset_fixtures.ProjectAssetTests.transport
    add_confirmed_sources = asset_fixtures.ProjectAssetTests.add_confirmed_sources
    sources = asset_fixtures.ProjectAssetTests.sources

    def test_conflicting_current_sources_warn_without_deleting_existing_assets(self):
        self.sources()
        before = deepcopy(self.manager._stored("p")["characterAssets"])
        plan = self.runtime.get("production", "production-p")
        visual = next(s for s in plan["stages"] if s["id"] == "visual")
        duplicate = {"id": "visual-duplicate", "authorId": "R05", "body": asset_fixtures.VISUAL}
        self.runtime.save("run", {"id": "duplicate-run", "projectId": "p", "status": "succeeded", "artifacts": [duplicate]})
        visual["artifacts"].append(duplicate)
        visual["outputArtifactIds"].append(duplicate["id"])
        self.runtime.save("production", plan)
        result = character_drafts(self.runtime, "p")
        self.assertEqual(result["assets"], [])
        self.assertTrue(any("多份当前角色原稿" in warning for warning in result["warnings"]))
        self.assertEqual(self.manager._stored("p")["characterAssets"], before)
        self.assertEqual(self.calls, [])

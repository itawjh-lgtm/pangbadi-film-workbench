"""Role loading integrity, ambiguity and read-only behavior tests."""

import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest


PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

from server.roles import (  # noqa: E402
    BODY_END, BODY_START, DEFAULT_FILM_DIR, DEFAULT_GAME_DIR,
    EXECUTION_BOUNDARY, ROLE_IDS, RoleCatalog, RoleUnavailableError,
)


def prompt(role_id, unique="完整正文，不可缩写。"):
    return (
        f'---\nrole_id: "{role_id}"\nsource_version: "v1.0"\n---\n'
        f"导航与来源\n\n{BODY_START}\n"
        f"# {role_id}｜角色 v2.0\n\n"
        "## Role｜角色定位\n\n源文职责说明。\n\n"
        "## Profile｜专业能力\n\n### 1. 完整专业能力\n\n能力细节。\n\n"
        "## Output Format｜交付格式\n\nA. 完整成果包\n\n"
        f"{unique}\n  保留缩进与空行。  \n\n{BODY_END}\n"
    )


class RoleCatalogTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.film = self.root / "film"
        self.game = self.root / "game"
        self.film.mkdir()
        self.game.mkdir()
        self.employees = self.root / "employees.js"
        self.employees.write_text(
            "window.TEAM_EMPLOYEES = " + json.dumps([
                {"id": rid, "name": f"演员{rid}", "title": f"岗位{rid}"}
                for rid in ROLE_IDS
            ], ensure_ascii=False) + ";\n", encoding="utf-8"
        )
        (self.film / "01_共享指令.md").write_text("影视共享完整规则\n", encoding="utf-8")
        (self.game / "01_游戏团队共享指令.md").write_text("游戏共享完整规则\n", encoding="utf-8")
        for rid in ROLE_IDS:
            self.role_file(rid).write_text(prompt(rid, f"最后一句 {rid}。"), encoding="utf-8")

    def tearDown(self):
        self.temp.cleanup()

    def role_file(self, rid):
        return (self.film if rid.startswith("R") else self.game) / f"{rid}_角色.md"

    def catalog(self):
        return RoleCatalog(self.film, self.game, self.employees)

    def test_maps_21_identities_and_real_body_version(self):
        roles = self.catalog().list_roles()
        self.assertEqual([r["id"] for r in roles], list(ROLE_IDS))
        self.assertTrue(all(r["available"] for r in roles))
        self.assertEqual(roles[0]["name"], "演员R01")
        self.assertEqual(roles[0]["title"], "岗位R01")
        self.assertEqual(roles[0]["version"], "v2.0")
        self.assertEqual(roles[0]["coordinator"], "R11")
        self.assertEqual(roles[16]["coordinator"], "G01")

    def test_full_prompt_instructions_and_provenance(self):
        catalog = self.catalog()
        original = self.role_file("R03").read_text(encoding="utf-8")
        raw_body = original.split(BODY_START)[1].split(BODY_END)[0]
        role = catalog.get_role("R03")
        self.assertEqual(role["prompt"], raw_body)
        self.assertEqual(role["source_text"], original)
        self.assertEqual(role["hash"], hashlib.sha256(original.encode()).hexdigest())
        self.assertEqual(role["bytes"], len(original.encode()))
        instructions = catalog.build_instructions("R03")
        self.assertIn(raw_body, instructions)
        self.assertIn("影视共享完整规则\n", instructions)
        self.assertIn("最后一句 R03。", instructions)
        self.assertIn(EXECUTION_BOUNDARY, instructions)
        self.assertNotIn("游戏共享完整规则", instructions)
        self.assertEqual(role["summary"], "源文职责说明。")
        self.assertEqual(role["capabilities"], ["完整专业能力"])
        self.assertEqual(role["outputs"], ["完整成果包"])

    def test_list_is_metadata_only_and_cannot_mutate_catalog(self):
        catalog = self.catalog()
        role = catalog.list_roles()[0]
        self.assertNotIn("prompt", role)
        self.assertNotIn("source_text", role)
        role["permissions"]["default"].append("publish")
        role["capabilities"].clear()
        self.assertNotIn("publish", catalog.get_role("R01")["permissions"]["default"])
        self.assertTrue(catalog.get_role("R01")["capabilities"])

    def test_missing_role_visible_but_not_runnable(self):
        self.role_file("R04").unlink()
        catalog = self.catalog()
        self.assertEqual(len(catalog.list_roles()), 21)
        self.assertFalse(catalog.get_role("R04")["available"])
        with self.assertRaisesRegex(RoleUnavailableError, "缺少"):
            catalog.build_instructions("R04")
        self.assertTrue(catalog.get_role("G01")["available"])

    def test_missing_shared_only_blocks_its_team(self):
        (self.film / "01_共享指令.md").unlink()
        catalog = self.catalog()
        self.assertFalse(catalog.get_role("R03")["available"])
        self.assertTrue(catalog.get_role("R03")["prompt"])
        self.assertTrue(catalog.get_role("G03")["available"])
        with self.assertRaisesRegex(RoleUnavailableError, "共享"):
            catalog.build_instructions("R03")

    def test_duplicate_versions_report_ambiguity_instead_of_guessing(self):
        (self.film / "R05_角色_v9.0.md").write_text(prompt("R05"), encoding="utf-8")
        catalog = self.catalog()
        role = catalog.get_role("R05")
        self.assertFalse(role["available"])
        self.assertEqual(len(role["source_candidates"]), 2)
        with self.assertRaisesRegex(RoleUnavailableError, "多个候选"):
            catalog.build_instructions("R05")
        self.assertTrue(catalog.get_role("R06")["available"])

    def test_duplicate_shared_blocks_instead_of_mixing_versions(self):
        (self.game / "01_共享指令_v3.md").write_text("另一版", encoding="utf-8")
        catalog = self.catalog()
        self.assertFalse(catalog.get_role("G01")["available"])
        self.assertTrue(catalog.get_role("R11")["available"])

    def test_mismatched_identity_or_broken_body_is_unavailable(self):
        self.role_file("R03").write_text(prompt("R04"), encoding="utf-8")
        self.role_file("R06").write_text(prompt("R06").replace(BODY_END, ""), encoding="utf-8")
        catalog = self.catalog()
        self.assertIn("编号", catalog.get_role("R03")["error"])
        self.assertIn("标记", catalog.get_role("R06")["error"])

    def test_reload_updates_snapshot_without_editing_source(self):
        catalog = self.catalog()
        before = catalog.get_role("R01")
        changed = prompt("R01", "新修订最后一段。")
        self.role_file("R01").write_text(changed, encoding="utf-8")
        self.assertEqual(catalog.get_role("R01")["hash"], before["hash"])
        catalog.reload()
        self.assertNotEqual(catalog.get_role("R01")["hash"], before["hash"])
        self.assertIn("新修订最后一段。", catalog.build_instructions("R01"))
        self.assertEqual(self.role_file("R01").read_text(encoding="utf-8"), changed)

    def test_source_commands_are_preserved_as_data_never_executed(self):
        sentinel = self.root / "must_not_exist"
        text = prompt("R12", f"$(touch '{sentinel}')\n__import__('os').system('touch {sentinel}')")
        self.role_file("R12").write_text(text, encoding="utf-8")
        instructions = self.catalog().build_instructions("R12")
        self.assertIn("__import__", instructions)
        self.assertFalse(sentinel.exists())

    def test_unknown_or_path_like_id_never_reads_arbitrary_path(self):
        catalog = self.catalog()
        for rid in ("R99", "../secrets", "r03", "/etc/passwd"):
            with self.assertRaises(KeyError):
                catalog.get_role(rid)

    def test_import_hash_mismatch_is_visible_but_current_text_is_used(self):
        text = prompt("R01").replace('role_id: "R01"', 'role_id: "R01"\nprompt_sha256: "old"')
        self.role_file("R01").write_text(text, encoding="utf-8")
        role = self.catalog().get_role("R01")
        self.assertTrue(role["available"])
        self.assertTrue(any("校验" in warning for warning in role["warnings"]))

    def test_missing_source_directories_do_not_crash_catalog(self):
        catalog = RoleCatalog(self.root / "missing-film", self.root / "missing-game", self.employees)
        self.assertEqual(len(catalog.list_roles()), 21)
        self.assertTrue(all(not role["available"] for role in catalog.list_roles()))

    def test_plain_markdown_preserved_without_body_markers(self):
        plain = "# R01\n\n普通 Markdown 全文。\n末尾有重要规则。\n"
        self.role_file("R01").write_text(plain, encoding="utf-8")
        self.assertEqual(self.catalog().get_role("R01")["prompt"], plain)


@unittest.skipUnless(DEFAULT_FILM_DIR.is_dir() and DEFAULT_GAME_DIR.is_dir(), "用户正本目录不在本机")
class CanonicalRolesIntegrationTests(unittest.TestCase):
    def test_all_canonical_sources_are_loaded_in_full(self):
        catalog = RoleCatalog()
        roles = catalog.list_roles()
        self.assertEqual(len(roles), 21)
        for metadata in roles:
            with self.subTest(role=metadata["id"]):
                self.assertTrue(metadata["available"], metadata.get("error"))
                self.assertTrue(metadata["capabilities"])
                self.assertTrue(metadata["outputs"])
                self.assertNotEqual(metadata["id"], metadata["name"])
                raw = Path(metadata["source"]).read_bytes()
                self.assertEqual(metadata["hash"], hashlib.sha256(raw).hexdigest())
                self.assertEqual(metadata["bytes"], len(raw))
                role = catalog.get_role(metadata["id"])
                source_body = raw.decode("utf-8").split(BODY_START)[1].split(BODY_END)[0]
                self.assertEqual(role["prompt"], source_body)
                self.assertIn(source_body, catalog.build_instructions(metadata["id"]))
                self.assertIn(role["shared_prompt"], catalog.build_instructions(metadata["id"]))
        self.assertEqual(catalog.get_role("G01")["version"], "v2.0")
        self.assertEqual(catalog.get_role("R03")["version"], "原文未标注")


if __name__ == "__main__":
    unittest.main()

import os
from pathlib import Path
import shutil
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from tui.manager import Manager, create_link, points_to


class ManagerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="harness test ")
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name).resolve()
        self.root = self.base / "repo"
        self.root.mkdir()
        (self.root / "content").mkdir()
        (self.root / "content/AGENTS.md").write_text("shared rules", encoding="utf-8")
        (self.root / "AGENTS.md").write_text("project development rules", encoding="utf-8")
        self.add_skill("one")
        self.add_skill("two")
        environment = patch.dict(os.environ, {}, clear=True)
        environment.start()
        self.addCleanup(environment.stop)
        self.manager = Manager(self.root, self.base / "home")

    def add_skill(self, name):
        folder = self.root / "content" / name
        folder.mkdir()
        (folder / "SKILL.md").write_text(f"---\nname: {name}\n---\n", encoding="utf-8")
        return folder

    def rows(self):
        connection = sqlite3.connect(self.root / "skills.db")
        try:
            return connection.execute("SELECT skill, agent, enabled FROM skill_agents ORDER BY skill, agent").fetchall()
        finally:
            connection.close()

    def require_symlinks(self):
        probe = self.base / "symlink-probe"
        try:
            probe.symlink_to(self.root, target_is_directory=True)
        except OSError as error:
            if getattr(error, "winerror", None) == 1314:
                self.skipTest("Windows requires Developer Mode or administrator privileges for symlinks")
            raise
        probe.unlink()

    def test_install_is_repeatable_and_backs_up_only_instructions(self):
        self.require_symlinks()
        for agent in self.manager.agents.values():
            agent.instructions.parent.mkdir(parents=True)
            agent.instructions.write_text("original", encoding="utf-8")
        self.manager.install(list(self.manager.agents), ["one", "two"])
        self.assertEqual(self.manager.install(list(self.manager.agents), ["one", "two"]), [])
        for agent in self.manager.agents.values():
            self.assertTrue(points_to(agent.instructions, self.root / "content/AGENTS.md"))
            backups = list(agent.instructions.parent.glob("*.bak-*"))
            self.assertEqual(len(backups), 1)
            self.assertEqual(backups[0].read_text(), "original")
            self.assertTrue(points_to(agent.skills / "one", self.root / "content/one"))
            self.assertFalse((agent.skills.parent / "skill-backups").exists())
        self.assertEqual(len(self.rows()), 6)
        self.assertTrue(all(row[2] == 1 for row in self.rows()))

    def test_agents_and_skills_can_be_selected_independently(self):
        self.require_symlinks()
        self.manager.install(["claude", "codex"], ["one", "two"])
        self.manager.install(["claude"], ["one"])
        states = self.manager.sync()
        self.assertFalse(states["two"]["claude"])
        self.assertTrue(states["two"]["codex"])
        self.assertFalse(states["one"]["copilot"])
        self.manager.set_enabled("copilot", "one", True)
        self.manager.set_enabled("copilot", "one", False)
        self.assertFalse(self.manager.sync()["one"]["copilot"])
        self.assertTrue((self.root / "content/one/SKILL.md").exists())

    def test_update_tracks_new_removed_and_manually_changed_links(self):
        self.require_symlinks()
        self.manager.install(["codex"], ["one", "two"])
        self.add_skill("new")
        (self.manager.agents["codex"].skills / "one").unlink()
        shutil.rmtree(self.root / "content/two")
        states = self.manager.sync()
        self.assertEqual(set(states), {"one", "new"})
        self.assertFalse(any(states["new"].values()))
        self.assertFalse(states["one"]["codex"])
        self.assertFalse(os.path.lexists(self.manager.agents["codex"].skills / "two"))
        self.assertEqual(len(self.rows()), 6)

    def test_update_removes_link_when_skill_md_disappears(self):
        self.require_symlinks()
        self.manager.set_enabled("codex", "one", True)
        (self.root / "content/one/SKILL.md").unlink()
        self.assertNotIn("one", self.manager.sync())
        self.assertFalse(os.path.lexists(self.manager.agents["codex"].skills / "one"))

    def test_update_discovers_existing_link_without_database(self):
        self.require_symlinks()
        target = self.manager.agents["codex"].skills / "one"
        target.parent.mkdir(parents=True)
        target.symlink_to(self.root / "content/one", target_is_directory=True)
        self.assertTrue(self.manager.sync()["one"]["codex"])

    def test_skill_directory_conflict_is_not_backed_up_or_deleted(self):
        target = self.manager.agents["codex"].skills / "one"
        target.mkdir(parents=True)
        (target / "local.txt").write_text("local")
        with self.assertRaises(FileExistsError):
            create_link(self.root / "content/one", target)
        self.assertEqual((target / "local.txt").read_text(), "local")
        self.assertFalse(list(self.base.rglob("*.bak-*")))
        self.assertFalse(self.manager.sync()["one"]["codex"])

    def test_skill_symlink_can_be_replaced_without_backup(self):
        self.require_symlinks()
        target = self.manager.agents["codex"].skills / "one"
        target.parent.mkdir(parents=True)
        original = self.base / "external"
        original.mkdir()
        (original / "keep.txt").write_text("keep")
        target.symlink_to(original, target_is_directory=True)
        self.manager.set_enabled("codex", "one", True)
        self.assertTrue(points_to(target, self.root / "content/one"))
        self.assertEqual((original / "keep.txt").read_text(), "keep")
        self.assertFalse(list(self.base.rglob("*.bak-*")))

    def test_disable_and_update_leave_unmanaged_content_alone(self):
        self.require_symlinks()
        target = self.manager.agents["claude"].skills / "one"
        target.mkdir(parents=True)
        unmanaged = target.parent / "unmanaged"
        unmanaged.symlink_to(self.base / "missing", target_is_directory=True)
        self.manager.set_enabled("claude", "one", False)
        self.assertTrue(target.is_dir())
        self.assertTrue(unmanaged.is_symlink())

    def test_rule_backup_preserves_original_symlink(self):
        self.require_symlinks()
        target = self.manager.agents["claude"].instructions
        target.parent.mkdir(parents=True)
        target.symlink_to(self.base / "missing.md")
        self.manager.install(["claude"], [])
        backup, = target.parent.glob("*.bak-*")
        self.assertTrue(backup.is_symlink())
        self.assertTrue(points_to(backup, self.base / "missing.md"))

    def test_failed_link_creation_leaves_original_rules_untouched(self):
        target = self.manager.agents["claude"].instructions
        target.parent.mkdir(parents=True)
        target.write_text("original")
        with patch.object(Path, "symlink_to", side_effect=PermissionError("denied")):
            with self.assertRaises(PermissionError):
                self.manager.install(["claude"], [])
        self.assertEqual(target.read_text(), "original")
        self.assertFalse(list(target.parent.glob("*.bak-*")))

    def test_failed_replacement_restores_rule_backup(self):
        self.require_symlinks()
        target = self.manager.agents["claude"].instructions
        target.parent.mkdir(parents=True)
        target.write_text("original")
        with patch.object(Path, "replace", side_effect=PermissionError("denied")):
            with self.assertRaises(PermissionError):
                create_link(self.root / "content/AGENTS.md", target, backup_existing=True)
        self.assertEqual(target.read_text(), "original")
        self.assertFalse(list(target.parent.glob("*.bak-*")))
        self.assertFalse(list(target.parent.glob("*.tmp")))

    def test_invalid_input_does_not_create_database(self):
        for agent, skill in [("unknown", "one"), ("codex", "../AGENTS.md")]:
            with self.assertRaises(ValueError):
                self.manager.set_enabled(agent, skill, True)
        self.assertFalse((self.root / "skills.db").exists())

    def test_empty_catalog_still_installs_rules(self):
        self.require_symlinks()
        shutil.rmtree(self.root / "content")
        (self.root / "content").mkdir()
        (self.root / "content/AGENTS.md").write_text("shared rules", encoding="utf-8")
        self.manager.install(["claude"], [])
        self.assertEqual(self.rows(), [])
        self.assertTrue(points_to(self.manager.agents["claude"].instructions, self.root / "content/AGENTS.md"))

    def test_project_rules_are_not_used_when_shared_rules_are_missing(self):
        (self.root / "content/AGENTS.md").unlink()
        with self.assertRaises(ValueError):
            self.manager.install(["claude"], [])
        self.assertFalse(self.manager.agents["claude"].instructions.exists())

    def test_common_rules_are_not_listed_as_a_skill(self):
        self.assertEqual(self.manager.discover(), ["one", "two"])

    def test_update_catalog_and_database_without_links(self):
        self.manager.sync()
        self.add_skill("new")
        shutil.rmtree(self.root / "content/one")
        self.assertEqual(set(self.manager.sync()), {"new", "two"})
        rows = self.rows()
        self.assertEqual(len(rows), 6)
        self.assertTrue(all(row[2] == 0 for row in rows))

    def test_database_flags_are_reconciled_to_actual_filesystem(self):
        self.manager.sync()
        connection = sqlite3.connect(self.root / "skills.db")
        with connection:
            connection.execute("UPDATE skill_agents SET enabled = 1")
        connection.close()
        self.manager.sync()
        self.assertTrue(all(row[2] == 0 for row in self.rows()))

    def test_failed_partial_install_still_synchronizes_database(self):
        self.manager.sync()
        with patch.object(self.manager, "_instructions", side_effect=PermissionError("denied")):
            with self.assertRaises(PermissionError):
                self.manager.install(["claude"], ["one"])
        self.assertTrue(all(row[2] == 0 for row in self.rows()))

    def test_source_cannot_be_replaced_with_link_to_itself(self):
        source = self.root / "content/AGENTS.md"
        with self.assertRaises(ValueError):
            create_link(source, source, backup_existing=True)
        self.assertEqual(source.read_text(), "shared rules")


if __name__ == "__main__":
    unittest.main()

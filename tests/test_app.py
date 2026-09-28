import asyncio
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

from textual import events
from textual.widgets import Static

from tui.app import CheckList, Installer
from tui.manager import Manager


class AppTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        skill = self.root / "content" / "example"
        skill.mkdir(parents=True)
        (skill / "SKILL.md").write_text("example")
        with patch.dict(os.environ, {}, clear=True):
            self.manager = Manager(self.root, self.root / "home")

    async def test_keyboard_defaults_navigation_and_install(self):
        app = Installer(self.manager)
        with patch.object(self.manager, "install", return_value=["installed"]) as install:
            async with app.run_test(size=(80, 24)) as pilot:
                agents = app.query_one("#agents", CheckList)
                self.assertEqual(agents.selected, [])
                self.assertEqual(agents.get_option_at_index(0).prompt.plain, "[ ] Claude Code")
                await pilot.press("enter")
                self.assertEqual(app.step, 1)
                await pilot.press("down", "space")
                self.assertEqual(agents.selected, ["codex"])
                self.assertEqual(agents.get_option_at_index(1).prompt.plain, "[✓] Codex")
                await pilot.press("enter")
                skills = app.query_one("#skills", CheckList)
                self.assertEqual(app.step, 2)
                self.assertEqual(skills.selected, ["example"])
                await pilot.press("space", "escape")
                self.assertEqual(app.step, 1)
                await pilot.press("enter")
                self.assertEqual(skills.selected, [])
                await pilot.press("enter")
                await app.workers.wait_for_complete()
        self.assertEqual(app.return_value, ["installed"])
        install.assert_called_once_with(["codex"], [])

    async def test_permission_failure_is_visible_and_can_be_retried(self):
        app = Installer(self.manager)
        with patch.object(self.manager, "install", side_effect=[OSError("开发者模式或管理员权限"), []]) as install:
            async with app.run_test() as pilot:
                await pilot.press("space", "enter", "enter")
                await app.workers.wait_for_complete()
                self.assertEqual(app.step, 2)
                self.assertFalse(app.busy)
                self.assertIn("开发者模式或管理员权限", str(app.query_one("#status", Static).render()))
                self.assertEqual(app.install_error, "开发者模式或管理员权限")
                await pilot.press("enter")
                await app.workers.wait_for_complete()
        self.assertEqual(install.call_count, 2)
        self.assertEqual(app.return_value, [])
        self.assertIsNone(app.install_error)

    async def test_fast_navigation_and_selection_are_applied_before_enter(self):
        app = Installer(self.manager)
        async with app.run_test() as pilot:
            # One terminal read can contain several keys with no pause between them.
            for key, character in [("down", None), ("space", " "), ("enter", "\r")]:
                app.post_message(events.Key(key, character))
            await pilot.pause()
            self.assertEqual(app.query_one("#agents", CheckList).selected, ["codex"])
            self.assertEqual(app.step, 2)

    async def test_install_does_not_block_ui_or_run_twice(self):
        started, release = threading.Event(), threading.Event()

        def slow_install(*args):
            started.set()
            release.wait(timeout=5)
            return []

        app = Installer(self.manager)
        with patch.object(self.manager, "install", side_effect=slow_install) as install:
            async with app.run_test() as pilot:
                try:
                    await pilot.press("space", "enter", "enter")
                    self.assertTrue(await asyncio.to_thread(started.wait, 2))
                    self.assertTrue(app.busy)
                    self.assertIn("正在安装", str(app.query_one("#status", Static).render()))
                    await pilot.press("enter")
                    self.assertEqual(install.call_count, 1)
                finally:
                    release.set()
                await app.workers.wait_for_complete()

    async def test_cancel_has_no_filesystem_side_effects(self):
        app = Installer(self.manager)
        async with app.run_test() as pilot:
            await pilot.press("escape")
        self.assertIsNone(app.return_value)
        self.assertFalse((self.root / "skills.db").exists())

    async def test_empty_skill_list_can_still_install_rules(self):
        (self.root / "content/example/SKILL.md").unlink()
        app = Installer(self.manager)
        with patch.object(self.manager, "install", return_value=[]) as install:
            async with app.run_test(size=(60, 12)) as pilot:
                await pilot.press("space", "enter", "enter")
                await app.workers.wait_for_complete()
        install.assert_called_once_with(["claude"], [])
        self.assertEqual(app.return_value, [])


if __name__ == "__main__":
    unittest.main()

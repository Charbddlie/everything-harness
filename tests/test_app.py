from pathlib import Path
import tempfile
import unittest

from textual.widgets import SelectionList

from tui.app import Installer
from tui.manager import Manager


class AppTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        skill = self.root / "content" / "example"
        skill.mkdir(parents=True)
        (skill / "SKILL.md").write_text("example")
        self.manager = Manager(self.root, self.root / "home")

    async def test_checkboxes_defaults_and_back_navigation(self):
        app = Installer(self.manager)
        async with app.run_test(size=(80, 24)) as pilot:
            agents = app.query_one("#agents", SelectionList)
            agents.deselect_all()
            await pilot.click("#next")
            self.assertTrue(app.query_one("#agents-page").display)
            agents.select("codex")
            await pilot.pause(0.6)
            await pilot.click("#next")
            await pilot.pause()
            self.assertTrue(app.query_one("#skills-page").display)
            skills = app.query_one("#skills", SelectionList)
            self.assertEqual(skills.selected, ["example"])
            skills.deselect_all()
            await pilot.click("#back")
            await pilot.pause(0.6)
            await pilot.click("#next")
            await pilot.pause(0.6)
            self.assertEqual(skills.selected, [])
            await pilot.click("#install")
            await pilot.pause()
        self.assertEqual(app.return_value, (["codex"], []))
        self.assertFalse((self.root / "skills.db").exists())

    async def test_cancel_has_no_filesystem_side_effects(self):
        app = Installer(self.manager)
        async with app.run_test() as pilot:
            await pilot.press("escape")
        self.assertIsNone(app.return_value)
        self.assertFalse((self.root / "skills.db").exists())


if __name__ == "__main__":
    unittest.main()

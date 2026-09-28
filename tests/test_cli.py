from contextlib import closing, redirect_stderr, redirect_stdout
from io import StringIO
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from tui.__main__ import main
from tui.manager import Manager


class CliTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        for name in ("one", "two"):
            folder = self.root / "content" / name
            folder.mkdir(parents=True)
            (folder / "SKILL.md").write_text(name)
        (self.root / "content/AGENTS.md").write_text("shared rules")
        with patch.dict(os.environ, {}, clear=True):
            self.manager = Manager(self.root, self.root / "home")
        self.stdout = StringIO()
        self.stderr = StringIO()

    def run_cli(self, *args, interactive=False):
        with (
            patch("sys.argv", ["install", *args]),
            patch("tui.__main__.Manager", return_value=self.manager),
            patch("sys.stdin.isatty", return_value=interactive),
            patch.object(self.stdout, "isatty", return_value=interactive),
            redirect_stdout(self.stdout),
            redirect_stderr(self.stderr),
        ):
            return main()

    def test_non_interactive_defaults_to_all_skills_for_explicit_agents(self):
        with patch.object(self.manager, "install", return_value=[]) as install:
            self.assertEqual(self.run_cli("--non-interactive", "--agents", "codex"), 0)
        install.assert_called_once_with(["codex"], ["one", "two"])

    def test_non_interactive_accepts_multiple_agents_and_selected_skills(self):
        with patch.object(self.manager, "install", return_value=[]) as install:
            self.assertEqual(self.run_cli("--non-interactive", "--agents", "claude", "copilot", "--skills", "two"), 0)
        install.assert_called_once_with(["claude", "copilot"], ["two"])

    def test_invalid_combinations_fail_without_changing_files(self):
        cases = [
            (),
            ("--non-interactive",),
            ("--agents", "codex"),
            ("--non-interactive", "--agents", "unknown"),
            ("--non-interactive", "--agents", "codex", "--update"),
            ("--update", "--skills", "one"),
        ]
        for args in cases:
            with self.subTest(args=args), self.assertRaises(SystemExit) as error:
                self.run_cli(*args)
            self.assertEqual(error.exception.code, 2)
        self.assertFalse((self.root / "skills.db").exists())
        self.assertFalse((self.root / "home").exists())

    def test_unknown_skill_fails_before_creating_database_or_links(self):
        self.assertEqual(self.run_cli("--non-interactive", "--agents", "codex", "--skills", "missing"), 1)
        self.assertFalse((self.root / "skills.db").exists())
        self.assertFalse((self.root / "home").exists())

    def test_update_and_disable_synchronize_database_without_a_terminal(self):
        self.assertEqual(self.run_cli("--update"), 0)
        self.assertEqual(self.run_cli("--disable", "codex", "one"), 0)
        with closing(sqlite3.connect(self.root / "skills.db")) as connection:
            rows = connection.execute("SELECT enabled FROM skill_agents").fetchall()
        self.assertEqual(rows, [(0,)] * 6)

    def test_install_failure_returns_nonzero_without_starting_tui(self):
        with patch.object(self.manager, "install", side_effect=OSError("permission denied")):
            self.assertEqual(self.run_cli("--non-interactive", "--agents", "codex"), 1)
        self.assertIn("permission denied", self.stderr.getvalue())

    def test_interactive_install_is_not_repeated_after_ui_exits(self):
        with patch("tui.app.Installer") as installer, patch.object(self.manager, "install") as install:
            installer.return_value.run.return_value = ["installed in UI"]
            self.assertEqual(self.run_cli(interactive=True), 0)
        install.assert_not_called()
        self.assertIn("installed in UI", self.stdout.getvalue())

    def test_exiting_ui_after_install_failure_returns_nonzero(self):
        with patch("tui.app.Installer") as installer:
            installer.return_value.run.return_value = None
            installer.return_value.install_error = "permission denied"
            self.assertEqual(self.run_cli(interactive=True), 1)
        self.assertIn("permission denied", self.stderr.getvalue())


if __name__ == "__main__":
    unittest.main()

"""Filesystem operations are the source of truth; SQLite records the result."""

from dataclasses import dataclass
from datetime import datetime
import os
from pathlib import Path
import sqlite3
from uuid import uuid4


@dataclass(frozen=True)
class Agent:
    label: str
    skills: Path
    instructions: Path


def agent_paths(home: Path) -> dict[str, Agent]:
    codex = Path(os.environ.get("CODEX_HOME") or home / ".codex").expanduser().absolute()
    claude = Path(os.environ.get("CLAUDE_CONFIG_DIR") or home / ".claude").expanduser().absolute()
    copilot = Path(os.environ.get("COPILOT_HOME") or home / ".copilot").expanduser().absolute()
    return {
        "claude": Agent("Claude Code", claude / "skills", claude / "CLAUDE.md"),
        "codex": Agent("Codex", codex / "skills", codex / "AGENTS.md"),
        "copilot": Agent("Copilot CLI", copilot / "skills", copilot / "copilot-instructions.md"),
    }


def points_to(link: Path, source: Path) -> bool:
    """Compare link targets even when the source has been deleted."""
    if not link.is_symlink():
        return False
    target = link.parent / link.readlink()
    try:
        return os.path.normcase(target.resolve()) == os.path.normcase(source.resolve())
    except (OSError, RuntimeError):
        return False


def create_link(source: Path, target: Path, *, backup_existing: bool = False) -> str | None:
    source = source.absolute()
    if source == target.absolute():
        raise ValueError(f"源文件和目标位置不能相同：{source}")
    if points_to(target, source):
        return None
    if os.path.lexists(target) and not backup_existing and not target.is_symlink():
        raise FileExistsError(f"Skill 目标已存在且不是符号链接，请先移走：{target}")
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(f".{target.name}.{uuid4().hex}.tmp")
    backup = None
    try:
        # Check symlink permissions before touching an existing file/directory.
        temporary.symlink_to(source, target_is_directory=source.is_dir())
        if os.path.lexists(target) and backup_existing:
            stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
            backup = target.with_name(f"{target.name}.bak-{stamp}-{uuid4().hex[:8]}")
            target.rename(backup)
        elif target.is_symlink():
            # Windows cannot replace a directory symlink with os.replace().
            target.unlink()
        try:
            temporary.replace(target)
        except OSError:
            if backup is not None:
                backup.rename(target)
            raise
    except OSError as error:
        if getattr(error, "winerror", None) == 1314:
            raise OSError("Windows 创建符号链接需要开启开发者模式，或以管理员身份运行安装脚本。") from error
        raise
    finally:
        if temporary.is_symlink():
            temporary.unlink()
    message = f"链接 {target} -> {source}"
    if backup is not None:
        message += f"（原内容备份至 {backup}）"
    return message


class Manager:
    def __init__(self, root: Path, home: Path | None = None):
        self.root = root.resolve()
        self.sources = self.root / "content"
        self.agents = agent_paths(home or Path.home())

    def discover(self) -> list[str]:
        if not self.sources.is_dir():
            raise ValueError(f"Skill 源目录不存在：{self.sources}")
        return sorted(
            path.name for path in self.sources.iterdir()
            if not path.name.startswith(".") and (path / "SKILL.md").is_file()
        )

    def sync(self) -> dict[str, dict[str, bool]]:
        names = self.discover()
        states = {}
        # Remove only this project's obsolete links, including dangling links.
        for agent in self.agents.values():
            if agent.skills.is_dir():
                for target in agent.skills.iterdir():
                    if target.name not in names and points_to(target, self.sources / target.name):
                        target.unlink()
        for name in names:
            states[name] = {
                key: points_to(agent.skills / name, self.sources / name)
                for key, agent in self.agents.items()
            }

        connection = sqlite3.connect(self.root / "skills.db")
        try:
            connection.execute("PRAGMA foreign_keys = ON")
            with connection:
                connection.execute("CREATE TABLE IF NOT EXISTS skills (name TEXT PRIMARY KEY)")
                connection.execute("""
                    CREATE TABLE IF NOT EXISTS skill_agents (
                        skill TEXT NOT NULL REFERENCES skills(name) ON DELETE CASCADE,
                        agent TEXT NOT NULL,
                        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
                        PRIMARY KEY (skill, agent)
                    )
                """)
                known = {row[0] for row in connection.execute("SELECT name FROM skills")}
                connection.executemany("DELETE FROM skills WHERE name = ?", [(name,) for name in known - set(names)])
                connection.executemany("INSERT OR IGNORE INTO skills VALUES (?)", [(name,) for name in names])
                connection.executemany(
                    "INSERT OR REPLACE INTO skill_agents (skill, agent, enabled) VALUES (?, ?, ?)",
                    [(name, agent, int(enabled)) for name, agents in states.items() for agent, enabled in agents.items()],
                )
        finally:
            connection.close()
        return states

    def installed_agents(self) -> list[str]:
        return [key for key, agent in self.agents.items()
                if points_to(agent.instructions, self.sources / "AGENTS.md")]

    def _validate(self, agents: list[str], skills: list[str]) -> None:
        unknown_agents = set(agents) - self.agents.keys()
        unknown_skills = set(skills) - set(self.discover())
        if unknown_agents:
            raise ValueError(f"未知 agent：{', '.join(sorted(unknown_agents))}")
        if unknown_skills:
            raise ValueError(f"未知 skill：{', '.join(sorted(unknown_skills))}")

    def _instructions(self, agent: str) -> str | None:
        source = self.sources / "AGENTS.md"
        if not source.is_file():
            raise ValueError(f"公共规则文件不存在：{source}")
        return create_link(source, self.agents[agent].instructions, backup_existing=True)

    def _skill(self, agent: str, skill: str, enabled: bool) -> str | None:
        source = self.sources / skill
        target = self.agents[agent].skills / skill
        if enabled:
            return create_link(source, target)
        if points_to(target, source):
            target.unlink()
            return f"移除链接 {target}"
        return None

    def set_enabled(self, agent: str, skill: str, enabled: bool) -> list[str]:
        self._validate([agent], [skill])
        self.sync()
        messages = []
        try:
            if enabled:
                messages.append(self._instructions(agent))
            messages.append(self._skill(agent, skill, enabled))
        finally:
            self.sync()
        return [message for message in messages if message]

    def install(self, agents: list[str], skills: list[str]) -> list[str]:
        self._validate(agents, skills)
        self.sync()
        messages = []
        try:
            for agent in agents:
                messages.append(self._instructions(agent))
                for skill in self.discover():
                    messages.append(self._skill(agent, skill, skill in skills))
        finally:
            # A failed operation must still leave the DB describing actual links.
            self.sync()
        return [message for message in messages if message]

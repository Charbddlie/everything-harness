"""Filesystem operations are the source of truth; SQLite records the result."""

from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime
import os
from pathlib import Path
import shutil
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


def destination_path(target: Path, sources: Path) -> Path:
    """Resolve parent aliases without following or overwriting a source link."""
    destination = target.parent.resolve() / target.name
    sources = sources.resolve()
    if destination == sources or destination in sources.parents or sources in destination.parents:
        raise ValueError(f"安装目标不能与源目录重叠：{target}")
    return destination


def remove_target(target: Path, sources: Path) -> None:
    destination = destination_path(target, sources)
    if target.is_symlink():
        target.unlink()
    elif target.is_dir():
        # rmtree removes Windows junctions without traversing their contents.
        shutil.rmtree(destination)
    else:
        target.unlink(missing_ok=True)


class Manager:
    def __init__(self, root: Path, home: Path | None = None):
        self.root = root.resolve()
        self.sources = self.root / "content"
        self.agents = agent_paths(home or Path.home())
        self.copy_mode = os.name == "nt"

    @contextmanager
    def database(self):
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
                connection.execute("CREATE TABLE IF NOT EXISTS copies (path TEXT PRIMARY KEY)")
                yield connection
        finally:
            connection.close()

    def copied_paths(self) -> set[Path]:
        with self.database() as connection:
            return {Path(row[0]) for row in connection.execute("SELECT path FROM copies")}

    def copy(self, source: Path, target: Path) -> str:
        destination_path(target, self.sources)
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_name(f".{target.name}.{uuid4().hex}.tmp")
        try:
            # Finish reading the source before replacing the installed copy.
            if source.is_dir():
                shutil.copytree(source, temporary)
            else:
                shutil.copy2(source, temporary)
            remove_target(target, self.sources)
            temporary.replace(target)
            with self.database() as connection:
                connection.execute("INSERT OR IGNORE INTO copies VALUES (?)", (str(target),))
        finally:
            remove_target(temporary, self.sources)
        return f"复制 {source} -> {target}"

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
        with self.database() as connection:
            copies = {Path(row[0]) for row in connection.execute("SELECT path FROM copies")}
            for target in list(copies):
                if not target.exists() or target.is_symlink():
                    copies.remove(target)
                    connection.execute("DELETE FROM copies WHERE path = ?", (str(target),))
            # Remove only this project's obsolete installations.
            for agent in self.agents.values():
                if agent.skills.is_dir():
                    for target in agent.skills.iterdir():
                        owned = points_to(target, self.sources / target.name) or (self.copy_mode and target in copies)
                        if target.name not in names and owned:
                            remove_target(target, self.sources)
                            copies.discard(target)
                            connection.execute("DELETE FROM copies WHERE path = ?", (str(target),))
            for name in names:
                states[name] = {
                    key: points_to(agent.skills / name, self.sources / name) or (
                        self.copy_mode and agent.skills / name in copies and (agent.skills / name / "SKILL.md").is_file()
                    )
                    for key, agent in self.agents.items()
                }
            known = {row[0] for row in connection.execute("SELECT name FROM skills")}
            connection.executemany("DELETE FROM skills WHERE name = ?", [(name,) for name in known - set(names)])
            connection.executemany("INSERT OR IGNORE INTO skills VALUES (?)", [(name,) for name in names])
            connection.executemany(
                "INSERT OR REPLACE INTO skill_agents (skill, agent, enabled) VALUES (?, ?, ?)",
                [(name, agent, int(enabled)) for name, agents in states.items() for agent, enabled in agents.items()],
            )
        return states

    def installed_agents(self) -> list[str]:
        copies = self.copied_paths() if self.copy_mode else set()
        return [key for key, agent in self.agents.items()
                if points_to(agent.instructions, self.sources / "AGENTS.md") or (
                    agent.instructions in copies and agent.instructions.is_file()
                )]

    def update(self) -> dict[str, dict[str, bool]]:
        states = self.sync()
        if self.copy_mode:
            try:
                for agent in self.installed_agents():
                    self._instructions(agent)
                for name, agents in states.items():
                    for agent, enabled in agents.items():
                        if enabled:
                            self._skill(agent, name, True)
            finally:
                states = self.sync()
        return states

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
        if self.copy_mode:
            return self.copy(source, self.agents[agent].instructions)
        return create_link(source, self.agents[agent].instructions, backup_existing=True)

    def _skill(self, agent: str, skill: str, enabled: bool) -> str | None:
        source = self.sources / skill
        target = self.agents[agent].skills / skill
        if enabled:
            if self.copy_mode:
                return self.copy(source, target)
            return create_link(source, target)
        if points_to(target, source) or (self.copy_mode and target in self.copied_paths()):
            remove_target(target, self.sources)
            return f"移除 {target}"
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
            # A failed operation must still leave the DB describing actual files.
            self.sync()
        return [message for message in messages if message]

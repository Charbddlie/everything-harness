import argparse
from pathlib import Path
import sqlite3
import sys

from .manager import Manager


def main() -> int:
    parser = argparse.ArgumentParser(description="用符号链接管理 Claude Code、Codex、Copilot CLI 的 skills 和公共规则。")
    commands = parser.add_mutually_exclusive_group()
    commands.add_argument("--update", action="store_true", help="扫描源目录和实际链接，同步 skills.db")
    commands.add_argument("--enable", nargs=2, metavar=("AGENT", "SKILL"), help="启用 skill；agent 为 claude、codex、copilot")
    commands.add_argument("--disable", nargs=2, metavar=("AGENT", "SKILL"), help="移除本项目的 skill 链接")
    args = parser.parse_args()
    manager = Manager(Path(__file__).resolve().parent.parent)
    try:
        if args.update:
            states = manager.sync()
            print(f"已同步 {len(states)} 个 skills，{sum(sum(row.values()) for row in states.values())} 个启用链接。")
            return 0
        if args.enable or args.disable:
            agent, skill = args.enable or args.disable
            messages = manager.set_enabled(agent, skill, enabled=bool(args.enable))
        else:
            if not sys.stdin.isatty() or not sys.stdout.isatty():
                parser.error("交互安装需要终端。自动化使用 --update、--enable 或 --disable。")
            from .app import Installer
            selection = Installer(manager).run()
            if selection is None:
                print("已取消。")
                return 0
            messages = manager.install(*selection)
        for message in messages:
            print(message)
        print("完成，skills.db 已同步。")
        return 0
    except (OSError, ValueError, sqlite3.Error) as error:
        print(f"安装失败：{error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

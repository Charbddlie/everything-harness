# 开发约定

- 保持轻量、简单、易读；优先使用 Python 标准库，TUI 使用 Textual，避免不必要的抽象和依赖。
- `content/` 只存放需要同步的内容：`content/AGENTS.md` 是公共规则，每个 skill 直接位于 `content/<skill_name>/`，包含 `SKILL.md`。根目录的本文件仅用于本项目开发，不安装到 agent。
- Skill 由 agent 动态加载；其规则只写在各自的 `SKILL.md`，不生成 `AGENTS.append.md`，不追加到任何 `AGENTS.md`。
- 根据当前系统选择入口：Windows 使用 `install.cmd`，Linux / macOS 使用 `sh install.sh`。Windows 入口保持 GBK 与 CRLF；Python、Markdown、Shell 文件使用 UTF-8，Shell 使用 LF。
- 项目 `.venv` 只用于本项目程序（安装器、TUI、SQLite 维护脚本及项目测试）：Windows 为 `.venv\Scripts\python.exe`，Linux / macOS 为 `.venv/bin/python`。环境不存在时先运行对应系统的安装脚本，创建 venv 时使用系统 Python。
- `content/` 中 skill 的 Python 脚本使用系统 Python，不指定或依赖本项目及其他项目的 venv：Windows 选择 `py -3` 或系统 `python`，Linux / macOS 选择系统 `python3`。
- 本项目程序的依赖通过项目 venv 的 `python -m pip` 安装，维护在 `requirements.txt`；skill 的运行环境独立于本项目环境。
- 安装使用符号链接，重复运行应安全。只备份公共规则目标文件，不备份 skill，不删除 skill 源内容；SQLite 状态以实际链接为准。
- 验证改动时使用隔离临时目录，避免修改个人 agent 配置。测试命令为项目 venv 的 `python -m unittest discover -s tests -v`；权限导致的跳过必须如实说明。
- `.venv/`、`skills.db` 及其附属文件、`key.env`、Python 缓存只保存在本机，不提交。发布前检查暂存文件，保留各平台 SQLite 二进制及校验信息。

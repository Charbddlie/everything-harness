# 开发约定

- 保持轻量、简单、易读；优先使用 Python 标准库，TUI 使用 Textual，避免不必要的抽象和依赖。
- `content/` 只存放需要同步的内容：`content/AGENTS.md` 是公共规则，每个 skill 直接位于 `content/<skill_name>/`，包含 `SKILL.md`。根目录的本文件仅用于本项目开发，不安装到 agent。
- Skill 由 agent 动态加载；其规则只写在各自的 `SKILL.md`，不生成 `AGENTS.append.md`，不追加到任何 `AGENTS.md`。
- 根据当前系统选择入口：Windows 使用 `install.cmd`，Linux / macOS 使用 `sh install.sh`。Windows 入口保持 GBK 与 CRLF；Python、Markdown、Shell 文件使用 UTF-8，Shell 使用 LF。
- 项目 `.venv` 只用于本项目程序（安装器、TUI、SQLite 维护脚本及项目测试）：Windows 为 `.venv\Scripts\python.exe`，Linux / macOS 为 `.venv/bin/python`。环境不存在时先运行对应系统的安装脚本，创建 venv 时使用系统 Python。
- `content/` 中 skill 的 Python 脚本使用系统 Python，不指定或依赖本项目及其他项目的 venv：Windows 选择 `py -3` 或系统 `python`，Linux / macOS 选择系统 `python3`。
- 本项目程序的依赖通过项目 venv 的 `python -m pip` 安装，维护在 `requirements.txt`；skill 的运行环境独立于本项目环境。
- Windows 安装直接复制并覆盖，不创建任何备份，不需要管理员权限；Linux / macOS 使用符号链接，仅备份原公共规则文件。重复运行应安全，不删除 skill 源内容；SQLite 状态以实际安装内容为准，`copies` 表记录本工具复制的目标路径。
- 验证改动时使用隔离临时目录，避免修改个人 agent 配置。测试命令为项目 venv 的 `python -m unittest discover -s tests -v`；权限导致的跳过必须如实说明。
- `.venv/`、`skills.db` 及其附属文件、`key.env`、Python 缓存只保存在本机，不提交。发布前检查暂存文件，保留各平台 SQLite 二进制及校验信息。

## install 脚本用法

根据系统选择入口：Windows 在项目目录执行 `.\install.cmd`，Linux / macOS 执行 `sh install.sh`。两个入口接受相同参数，先检查或创建项目 `.venv`，再运行安装器。

直接运行、不带参数时是供用户操作的交互模式：先勾选 harness（三个默认均不选），再勾选 skills（默认全选），公共规则自动安装。列表显示 `[ ]` / `[✓]`，↑↓移动、空格勾选、Enter 下一步或安装、Esc 返回、Ctrl+C 取消。安装过程和失败原因在界面内显示。Agent 自动执行时使用下面的非交互命令，不启动 TUI 或等待用户勾选。

Windows 示例（Linux / macOS 把 `.\install.cmd` 替换为 `sh install.sh`）：

```bat
:: 非交互安装到指定 agent，省略 --skills 时安装全部 skills
.\install.cmd --non-interactive --agents codex

:: 多个 agent、指定 skills；也可在 --skills 后列出多个 skill 名
.\install.cmd --non-interactive --agents claude codex --skills pdf-analyze

:: 同步 skill 状态；Windows 同时更新已安装的 skill 和公共规则副本
.\install.cmd --update

:: 为某个 agent 启用或禁用单个 skill
.\install.cmd --enable codex pdf-analyze
.\install.cmd --disable codex pdf-analyze
```

- Agent 参数使用 `claude`、`codex`、`copilot`；skill 参数使用 `content/` 下的目录名。
- 非交互安装必须显式给出 `--agents`。它与交互安装效果一致：安装 `content/AGENTS.md`，启用所选 skills，并移除所选 agent 中未选中的本项目 skill 副本或链接。只调整一个 skill 时使用 `--enable` / `--disable`。
- 安装、enable、disable 完成后都会依据实际文件同步 `skills.db`。`--update` 添加新 skill、清理源已删除的本项目安装及数据库记录、记录手动删除后的状态；新 skill 不会自动启用。Windows 还会刷新已启用的 skill 和已安装的公共规则副本，包括清理副本中过时的文件；编辑 `content/` 后需运行它才会生效。
- `--enable AGENT SKILL` 复制 skill（Windows）或创建链接（Linux / macOS），并确保公共规则已安装；`--disable AGENT SKILL` 只移除对应的本项目安装，保留源内容和公共规则。Windows 副本所有权记录在本机数据库中，数据库丢失后重新运行安装以恢复记录。
- `--non-interactive`、`--update`、`--enable`、`--disable` 互斥；查看全部参数使用 `--help`。成功退出码为 0，操作失败为 1，参数错误为 2。

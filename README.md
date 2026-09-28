# Everything Harness

管理 Claude Code、Codex、Copilot CLI 的个人 skills 和公共规则：Windows 直接复制，Linux / macOS 使用符号链接。
只依赖 Python 3.10+ 与 Textual；数据库操作使用 Python 自带的 `sqlite3`。

## 开始使用

把每个 skill 直接放在 `content/<skill_name>/SKILL.md`，脚本和资源也放在对应目录内。
需要同步的公共规则编辑 `content/AGENTS.md`；根目录 `AGENTS.md` 仅用于本项目开发约定。
已包含 `content/pdf-analyze/`。MinerU 密钥使用环境变量 `MINERU_API_KEY` 或该 skill 内本机的 `key.env`，密钥文件已忽略提交。
Skill 由 agent 动态加载，规则只保存在各自的 `SKILL.md`，不追加到 `AGENTS.md`。
Skill 的脚本使用系统 Python：Windows 使用 `py -3` 或系统 `python`，Linux / macOS 使用系统 `python3`；不使用本项目或其他项目的 venv。

Windows 只提供一个入口，`install.cmd` 使用 GBK / 代码页 936：

```bat
install.cmd
install.cmd --update
install.cmd --enable codex my-skill
install.cmd --disable claude my-skill
```

Linux / macOS：

```sh
sh install.sh
sh install.sh --update
sh install.sh --enable copilot my-skill
sh install.sh --disable codex my-skill
```

无参数运行时，先勾选 harness（三个默认均不选），再勾选 skills（默认全选）。
列表使用 `[ ]` / `[✓]` 显示状态：↑↓移动、空格勾选、Enter 进入下一步或安装、Esc 返回、Ctrl+C 取消。
公共规则自动安装，不出现在选择列表中。安装时显示进度；失败原因保留在界面上，可以重试或退出。
未勾选的 skills 会从所选 agent 移除；未选择的 agent 不受交互安装影响。
没有 skills 时也能单独安装公共规则。

Agent 或自动化脚本使用非交互模式，必须明确目标 agent：

```bat
install.cmd --non-interactive --agents codex
install.cmd --non-interactive --agents claude codex --skills pdf-analyze
```

Linux / macOS 使用 `sh install.sh` 加相同参数。省略 `--skills` 时安装全部 skills，公共规则自动安装。
指定 `--skills` 时，所选 agent 中未选中的本项目 skill 副本或链接会被移除；只调整单个 skill 使用 `--enable AGENT SKILL` 或 `--disable AGENT SKILL`。
安装、启用和禁用都会同步 `skills.db`；`--update` 按实际文件刷新状态，Windows 还会更新已安装的副本。
`--non-interactive`、`--update`、`--enable`、`--disable` 不能组合使用。

脚本先检查项目 `.venv`，不存在就自动创建；首次运行或 `requirements.txt` 改动后安装依赖。
后续运行复用环境，不重复联网安装。Linux 若缺少 venv 支持，需先安装系统的 `python3-venv`。

Windows **直接复制到当前用户的 agent 目录，不需要管理员权限或开发者模式，不创建备份**。
修改 `content/` 后运行 `install.cmd --update`，即可更新已安装的 skill 和公共规则副本。
Python 源码和 Markdown 保持 UTF-8；Windows 入口及其重定向输出默认使用 GBK。

## 安装位置

以下 `~` 表示当前用户主目录，Windows 对应 `%USERPROFILE%`。

| agent 参数 | skill 安装位置 | 公共规则安装位置 |
| --- | --- | --- |
| `claude` | `~/.claude/skills/<skill_name>` | `~/.claude/CLAUDE.md` |
| `codex` | `~/.codex/skills/<skill_name>` | `~/.codex/AGENTS.md` |
| `copilot` | `~/.copilot/skills/<skill_name>` | `~/.copilot/copilot-instructions.md` |

支持 `CLAUDE_CONFIG_DIR`、`CODEX_HOME`、`COPILOT_HOME` 覆盖相应配置目录。
规则来源为本项目的 `content/AGENTS.md`，skill 来源为 `content/` 下对应的整个目录。
Windows 复制这些内容；Linux / macOS 创建链接，修改源文件立即生效。agent 可能需要开启新会话才能重新加载。

Codex 使用仍受支持的 `$CODEX_HOME/skills` 兼容路径，让它与 Copilot 分别管理。
官方推荐的 `~/.agents/skills` 是共享目录，Copilot 同样会读取。
本工具的启用状态只描述自己管理的安装；agent 的其他发现目录、原有禁用设置仍会影响实际加载。
已有 `AGENTS.override.md` 时，Codex 会优先读取该覆盖文件。
这里的 Copilot 指 Copilot CLI 的个人配置，不修改 VS Code 工作区设置。

## 备份与重复运行

- Windows 直接覆盖公共规则及所选 skill 的同名目标，不创建备份；skill 副本保持与源目录一致，旧文件也会清理。请在 `content/` 中维护内容，目标副本中的改动会被覆盖。
- Linux / macOS 只备份公共规则目标（`AGENTS.md`、`CLAUDE.md` 或 `copilot-instructions.md`），备份名为原文件名加 `.bak-时间戳-标识`。已正确链接时不重建、不重复备份。
- Linux / macOS 的 skill 不备份。已有符号链接直接替换；若同名位置是普通文件或目录，报错并提示先移走。
- 禁用 skill 只删除本工具记录的副本或指向本项目的链接，不删除源 skill，不影响公共规则。
- Linux / macOS 恢复原规则时，删除对应规则链接，再把需要的 `.bak-*` 文件改回原名。

项目路径请保持稳定。移动项目后，重新运行交互安装以更新到新路径。

## 状态同步

`skills.db` 在第一次安装、启用/禁用或 `--update` 时自动创建，已加入 `.gitignore`。
不提交机器状态或 `.venv`。取消交互界面不会创建数据库或安装文件。

`--update` 以文件系统为准：

1. 扫描 `content/` 下含 `SKILL.md` 的直接子目录，为新 skill 创建三个 agent 的状态记录。`content/AGENTS.md` 不作为 skill 显示。
2. 从本工具记录的副本及实际链接读取启用状态；新 skill 默认未启用，除非已有对应链接。
3. 源 skill 被删除或不再包含 `SKILL.md` 时，清理其本项目副本或链接及数据库记录。
4. 手动删除已安装的 skill 后，状态同步为未启用，不会按数据库中的旧值重新安装。
5. Windows 更新仍启用的 skill 和已安装的公共规则副本；旧版指向本项目的符号链接也会替换为副本。

数据库有三张表：`skills(name)`、`skill_agents(skill, agent, enabled)`、`copies(path)`。
`copies` 记录本工具复制的目标，避免禁用或更新时处理其他来源的 skill。旧数据库自动补充该表；若删除数据库，重新运行安装以恢复副本记录。
安装中途失败时，也会把已经完成的操作同步到数据库；修复问题后可直接重跑。

## SQLite 可执行文件

`sqlite/` 已包含官方 SQLite 3.53.4：Windows x64 / ARM64、Linux x64、macOS Intel / Apple Silicon。
安装器无需调用外部 SQLite，随附程序用于直接检查本机数据库：

```bat
sqlite\windows-x64\sqlite3.exe skills.db "SELECT * FROM skill_agents;"
```

```sh
chmod +x sqlite/linux-x64/sqlite3
sqlite/linux-x64/sqlite3 skills.db 'SELECT * FROM skill_agents;'
# macOS 替换为 sqlite/macos-arm64/sqlite3 或 sqlite/macos-x64/sqlite3
```

下载来源、归档 SHA3-256 与二进制 SHA-256 见 `sqlite/checksums.json`。
维护者使用项目 venv 的 Python 执行 `sqlite/fetch.py` 重新获取固定版本；它会验证官方归档校验值。
SQLite 属于 [public domain](https://www.sqlite.org/copyright.html)。
官方 Linux 二进制的系统库需求取决于其构建环境；其他 Linux 架构仍可使用 Python 安装器。

联网需要代理时，可在当前终端设置，例如 Windows CMD：

```bat
set HTTP_PROXY=http://127.0.0.1:7890
set HTTPS_PROXY=http://127.0.0.1:7890
install.cmd
```

Linux / macOS 对应使用 `export HTTP_PROXY=http://127.0.0.1:7890` 与 `export HTTPS_PROXY=$HTTP_PROXY`。

## 目录与验证

```text
AGENTS.md           本项目开发约定，不同步
content/
  AGENTS.md         需要同步的公共规则
  pdf-analyze/      skill 目录，包含 SKILL.md 与 scripts/
tui/                Python 界面、安装、状态管理
sqlite/             各平台二进制及下载校验信息
install.cmd         Windows 入口，GBK
install.sh          Linux / macOS 入口
requirements.txt    Textual 依赖
tests/              数据库、复制、链接与界面测试
.venv/              首次运行自动创建，忽略提交
skills.db           本机状态，忽略提交
```

测试使用隔离临时目录，不修改个人 agent 配置：

安装器、TUI、SQLite 维护脚本和项目测试使用项目 `.venv` 中的 Python；这些程序的依赖通过该解释器的 `-m pip` 安装。`content/` 内的 skill 脚本独立使用系统 Python。
首次准备环境按当前系统选择 `install.cmd`（Windows）或 `sh install.sh`（Linux / macOS）。

```bat
.venv\Scripts\python -m unittest discover -s tests -v
```

Linux / macOS 使用 `.venv/bin/python -m unittest discover -s tests -v`。
Windows 复制安装的测试不需要特殊权限；涉及 Linux / macOS 链接行为及旧链接迁移的测试，在 Windows 缺少符号链接权限时会明确跳过。

路径依据：[Claude skills](https://code.claude.com/docs/en/skills)、[Claude memory](https://code.claude.com/docs/en/memory)、[Codex skills](https://developers.openai.com/codex/skills/)、[Codex 兼容路径源码](https://github.com/openai/codex/blob/main/codex-rs/ext/skills/src/host_roots.rs)、[Codex AGENTS.md](https://developers.openai.com/codex/guides/agents-md/)、[Copilot skills](https://docs.github.com/en/copilot/concepts/agents/about-agent-skills)、[Copilot instructions](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-custom-instructions)。

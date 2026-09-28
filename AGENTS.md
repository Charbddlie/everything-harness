# 开发约定

- 保持轻量、简单、易读。仓库维护个人 skill 内容和使用清单；安装、覆盖更新交给 `npx skills`，不实现 TUI、安装数据库或链接管理。
- 自有 skill 放在 `skills/<skill-name>/SKILL.md`，脚本和资源保留在对应目录内。Skill 规则仅写在各自的 `SKILL.md`，不追加到任何 `AGENTS.md`；根目录本文件仅用于仓库开发，不对外安装。
- `skills.json` 顶层 `agents` 统一设置所有 skill 的目标，默认包含 `claude-code`、`codex`、`github-copilot`，手动配置，不自动探测选择。每个 skill 一条记录，仅包含 `name`、GitHub `owner/repo` 来源和布尔字段 `auto_sync`，不设置 skill 级 agents。名称全局唯一；不增加来源分类、通配符或版本管理系统。
- `sync.mjs` 使用 Node.js 内置模块，通过系统的 `npx skills` 运行 CLI。所有入口读取远程 main 清单，安装和删除使用生效的全局 agents。面向用户仅说明远程入口，不要求克隆仓库或手动操作 Git。
- 清单完整校验后才执行安装，子进程使用结构化参数。不直接编辑 harness 配置、链接或 `skills` 锁文件；不自动卸载清单外的 skill。
- `~/.everything-harness/skills.json` 使用相同结构，仅保存本机明确选择的条目；其 `auto_sync` 优先于远程默认，来源始终取远程清单。可选的顶层 `agents` 完整覆盖远程列表，缺省跟随远程，空数组表示没有目标。首次同步创建空 skill 清单，不复制默认值；后续同步不覆盖本机选择。读取旧本机配置时忽略 skill 级 agents 字段，保留原开关。
- 普通运行只补齐生效 `auto_sync=true` 的 skill / agent 组合；`--update` 只重装这些 skill，`--dryrun` 只检查这些 skill，不执行无范围限制的全局更新。关闭开关本身不卸载内容。
- `--add SOURCE SKILL...` / `--del SKILL...` 自动在临时目录获取远程 main，再执行本机安装或删除；安装还须通过 dryrun。成功后只 commit `skills.json` 并 push，完成后清理临时副本。失败保留已完成的本机操作及未推送的清单改动，提示重新运行同一条命令；不操作用户工作区、不强推。
- `--auto_sync true|false SKILL...` 只改远程开关并自动 commit / push。`--local --add SKILL...` / `--local --del SKILL...` 使用远程清单的来源和生效 agents，成功后只保存本机 `auto_sync=true/false`；`--local --auto_sync true|false SKILL...` 只改本机开关。这些本机操作不调用 Git；失败不改本机配置。开关按整个 skill 生效。
- `--add_agents AGENT...` / `--del_agents AGENT...` 只改远程全局列表并自动 commit / push；带 `--local` 时从当前生效列表增删后保存完整本机覆盖，不操作 Git。这两个选项不立即安装或卸载，下次同步生效。空目标时同步、更新和 dryrun 跳过，skill add/del 在操作前报错。
- `--list` 始终显示远程、本机和生效 agents，以及每个 skill 的远程开关、本机覆盖（无覆盖时显示跟随远程）和生效状态。唯一入口为 `sync.mjs`，不下载或维护第二个同步脚本。
- 自有 skill 包含可执行脚本时，必须在该 skill 根目录提供独立的 `dryrun.mjs`，无脚本的 skill 不需要。Dryrun 检查运行环境和必要配置，不上传用户文件、不发起业务操作、不调用计费 API；汇总可操作的错误并以非零状态退出。
- 安装及更新后自动运行本次清单内所有 skill 的 `dryrun.mjs`，包括已安装而跳过的 skill；第三方存在此入口时同样执行。逐个检查并汇总报错，不能因首个失败漏掉后续 skill。维护 skill 时同步维护 dryrun 和 `SKILL.md`，环境细节由各 skill 自己定义。
- Node.js ≥22.20.0；源文件使用 UTF-8 / LF。自有脚本优先使用 JavaScript 和 Node.js 内置模块，不依赖项目 venv。
- 验证使用 `node --test`；真实 CLI 安装测试使用隔离临时目录，避免修改个人 harness 配置。联网测试的失败或跳过应如实说明。

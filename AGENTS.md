# 开发约定

## 目录与名称约定

- `eh` 是 `everything-harness` 的简称，用户指令中的 `eh` 均指本项目。
- 自有 skill 放在 `skills/<skill-name>/SKILL.md`，常驻规则放在 `agents-md/<name>.md`；根目录 `AGENTS.md` 用于仓库开发。
- `harness.json` 统一管理 `skills` 和 `agents-md`，名称在各自数组内唯一。Skill 记录包含 `name`、GitHub `owner/repo` 来源 `source`、布尔字段 `auto_sync` 和可选 `deleted`；片段记录包含 `name`、`auto_sync` 和可选 `deleted`。
- 顶层 `agents` 统一设置所有 skill 和片段的目标，支持 `codex`、`github-copilot`，默认包含两者。
- 本机配置位于 `~/.everything-harness/harness.json`，保存同步开关和可选的顶层 `agents`。Skill 共用 `~/.agents/skills` 中的一份实体文件；片段写入 `${CODEX_HOME:-~/.codex}/AGENTS.md` 或 `${COPILOT_HOME:-~/.copilot}/copilot-instructions.md`。
- 片段标记统一使用 `<!-- eh:<name>:start -->` / `<!-- eh:<name>:end -->`。

## sync 脚本的使用方式

使用 sync 前，参考 [skills/skill-manage/SKILL.md](skills/skill-manage/SKILL.md)。远程入口、增删内容、同步开关、目标设置、状态查看和环境检查的操作说明统一维护在该文档中。

## 项目的开发原则

- 保持轻量、简单、易读。仓库维护个人 skill 内容和清单；目录选择、安装、覆盖更新和锁文件交给 `npx skills` 管理。功能范围保持在内容维护与同步，不扩展 TUI、安装数据库、链接管理、来源分类、通配符或版本管理系统。
- 内容发布流程为：修改本地仓库 → commit / push 到远程 → 运行 sync → 单向覆盖本机安装内容。选中内容无条件以远程正文覆盖，本机 JSON 仅保存开关和目标选择。
- `sync.mjs` 是唯一同步入口，使用 Node.js 内置模块，通过系统的 `npx skills` 运行 CLI。所有入口读取远程 main 清单，安装和删除使用生效的全局 agents；面向用户提供远程入口。
- 完整校验清单后执行安装，按来源分组覆盖安装开启同步的 skill，子进程使用结构化参数。保留清单外的 skill，以及其他 harness 配置、链接和锁文件的原有管理方式。
- 片段写入前读取并校验所有选中正文和目标标记，格式错误时先报错。原位替换已有块，新块按清单顺序追加；保留标记外内容、关闭同步和清单外的块，以及目标文件已有软链接。
- 删除自有 skill 时移除整个 `skills/<name>/`，删除片段时移除 `agents-md/<name>.md`，仅在 `harness.json` 保留旧 entry，设置 `deleted=true`、`auto_sync=false`；改名另建新 entry 并移动正文。删除标记优先于本机开关，清理后长期保留，已删除名称保持禁用。关闭同步时保留安装内容。
- 本机开关和顶层 agents 覆盖远程默认，正文来源和删除状态始终取远程。首次同步创建 `{"skills":[],"agents-md":[]}`；新文件缺失时迁入旧 `skills.json`、`agents-md.json` 的开关与全局 agents，保留旧文件备份，忽略旧 skill 级 agents。新文件存在后以新文件为准；列表和预检保持只读。
- 本机旧 `harness.json` 中的 `fragments` 迁入 `agents-md`，保留开关；同步或本机设置操作保存新字段，列表和预检保持只读。两个字段同时存在时先报错，要求合并。
- 远程清单修改在临时副本中完成，成功后提交 `harness.json`；删除操作同时提交对应自有 skill 目录或片段文件的删除，随后正常 push，保持用户工作区原状。第三方来源仓库保持不变。失败时保留已完成的本机操作和未推送改动，并提示重试。本机操作成功后才保存本机配置，Git 操作仅用于远程修改。
- 自有 skill 包含可执行脚本时，在 skill 根目录提供独立的 `dryrun.mjs`。Dryrun 仅检查运行环境和必要配置，汇总可操作的错误并以非零状态退出；用户文件上传、业务操作和计费 API 调用均排除在检查范围外。
- 安装后逐个运行本次清单内所有 skill 的 `dryrun.mjs`，第三方存在此入口时同样执行，完成全部检查后汇总错误。维护 skill 时同步维护 dryrun 和 `SKILL.md`，环境细节由各 skill 定义。
- Node.js ≥22.20.0；源文件使用 UTF-8 / LF。自有脚本优先使用 JavaScript 和 Node.js 内置模块，运行环境独立于项目 venv。
- 验证使用 `node --test`；真实 CLI 安装测试使用隔离临时目录，保持个人 harness 配置不变。联网测试的失败或跳过应如实说明。

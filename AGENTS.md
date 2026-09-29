# 开发约定

## 目录与名称约定

- `eh` 是 `everything-harness` 的简称，用户指令中的 `eh` 均指本项目。
- 自有 skill 放在 `skills/<skill-name>/SKILL.md`，常驻规则放在 `agents-md/<name>.md`；根目录 `AGENTS.md` 用于仓库开发。
- `harness.json` 管理 `skill`、`agents-md`、`sync-rules` 和 `deleted`。活动 Skill 记录包含 `name`、GitHub `owner/repo` 来源 `source`；片段记录包含 `name`。同步成员关系集中在 `sync-rules`，每个键为规则名，值为 `[{"type_name":"skill:NAME"}]` 或片段类型名称的数组。删除记录使用 `type_name`，skill 必须保留 `source`，片段来源固定为 eh。同一条目不能同时存在于活动数组和 `deleted`，规则只能引用活动内容。
- `--add` 接收一个或两个参数：单参数为 `type:name`，其中自有 skill 默认来源为 `Charbddlie/everything-harness`；双参数为 `owner/repo skill:name`。`agents-md:name` 和 `rule:name` 使用单参数。`--del` 可接收多个类型名称。`--add_agents`、`--del_agents` 沿用 agent 名称。
- 每个同步规则在 `sync.mjs` 注册回调。`auto` 无额外条件，`win` 检测 Windows，`learn` 检测 Windows 和显式调用。检测函数集中复用，规则成员禁止嵌套规则。普通 sync 按清单顺序走同一个 `--add rule:name` 规划与执行入口，调用上下文标记为非显式。
- 顶层 `agents` 统一设置所有 skill 和片段的目标，支持 `codex`、`github-copilot`，默认包含两者。
- 本机配置位于 `~/.everything-harness/harness.json`，保存 `sync-rules` 成员覆盖和可选的顶层 `agents`；每个本机规则整份覆盖同名远程规则。Skill 共用 `~/.agents/skills` 中的一份实体文件；片段写入 `${CODEX_HOME:-~/.codex}/AGENTS.md` 或 `${COPILOT_HOME:-~/.copilot}/copilot-instructions.md`。
- 片段标记统一使用 `<!-- eh:<name>:start -->` / `<!-- eh:<name>:end -->`。

## sync 脚本的使用方式

使用 sync 前，参考 [skills/skill-manage/SKILL.md](skills/skill-manage/SKILL.md)。远程入口、增删内容、同步开关、目标设置、状态查看和环境检查的操作说明统一维护在该文档中。

## 项目的开发原则

- 保持轻量、简单、易读。仓库维护个人 skill 内容和清单；目录选择、安装、覆盖更新和锁文件交给 `npx skills` 管理。功能范围保持在内容维护与同步，不扩展 TUI、安装数据库、链接管理、来源分类、通配符或版本管理系统。
- 内容发布流程为：修改本地仓库 → commit / push 到远程 → 运行 sync → 单向覆盖本机安装内容。检测通过的内容以远程正文覆盖，本机 JSON 保存规则成员与目标选择。
- `sync.mjs` 是唯一同步入口，使用 Node.js 内置模块，通过系统的 `npx skills` 运行 CLI。所有入口读取远程 main 清单，安装和删除使用生效的全局 agents；面向用户提供远程入口。
- 完整校验清单后执行规则。调用顺序为规则回调 → 检测函数 → 所有相关 skill 的 dryrun → 批量安装。规则条件未满足时跳过该规则；测试失败时保留该批正式安装，汇总错误并继续检查后续规则。添加单条内容复用相同测试与安装执行器。按来源分组安装，子进程使用结构化参数，保留清单外内容。
- 片段写入前读取并校验所有选中正文和目标标记，格式错误时先报错。原位替换已有块，新块按清单顺序追加；保留标记外内容、关闭同步和清单外的块，以及目标文件已有软链接。
- 删除自有 skill 时移除整个 `skills/<name>/`，删除片段时移除 `agents-md/<name>.md`，将活动记录移入顶层 `deleted`，保留类型名称及 skill 来源；改名另建新 entry 并移动正文。删除记录优先于本机开关，清理后长期保留，已删除名称保持禁用。清理 skill 前通过 `skills list` 校验来源，来源冲突时先报错。关闭同步时保留安装内容。
- 本机规则成员和顶层 agents 覆盖远程默认，正文来源和删除状态始终取远程。首次同步创建 `{"sync-rules":{}}`；新文件缺失时迁入旧 `skills.json`、`agents-md.json` 的开关与全局 agents，保留旧文件备份，忽略旧 skill 级 agents。新文件存在后以新文件为准。
- 旧本机 `skills` / `skill`、`fragments` / `agents-md` 中的 `auto_sync` 迁为规则成员覆盖。旧 true 优先沿用远程所属规则，未分组内容进入 auto；旧 false 从生效规则移除。同步或本机操作成功后保存新配置，列表和预检保持个人文件只读。新旧设置有歧义时先报错。本机残留的删除项或清单外引用在执行时忽略。
- 远程清单修改在临时副本中完成，成功后提交 `harness.json`；删除操作同时提交对应自有 skill 目录或片段文件的删除，随后正常 push，保持用户工作区原状。第三方来源仓库保持不变。失败时保留已完成的本机操作和未推送改动，并提示重试。本机操作成功后才保存本机配置，Git 操作仅用于远程修改。
- 自有 skill 包含可执行脚本时，在 skill 根目录提供独立的 `dryrun.mjs`。Dryrun 仅检查运行环境和必要配置，汇总可操作的错误并以非零状态退出；用户文件上传、业务操作和计费 API 调用均排除在检查范围外。
- 添加前通过 `npx skills` 在隔离临时项目准备源码，逐个运行本批所有 skill 的 `dryrun.mjs`，第三方存在此入口时同样执行，完成全部检查后汇总错误。全部通过才覆盖正式安装并写片段；临时项目始终清理。规则删除跳过回调和 skill 测试，保留来源与目标标记校验。维护 skill 时同步维护 dryrun 和 `SKILL.md`。
- Node.js ≥22.20.0；源文件使用 UTF-8 / LF。自有脚本优先使用 JavaScript 和 Node.js 内置模块，运行环境独立于项目 venv。
- 验证使用 `node --test`；真实 CLI 安装测试使用隔离临时目录，保持个人 harness 配置不变。联网测试的失败或跳过应如实说明。

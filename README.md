# Everything Harness

Everything Harness 简称 `eh`，使用 `harness.json` 统一管理个人 skill 和常驻指令片段。Skill 放在 `skills/`，交给 `npx skills` 安装；片段放在 `agents-md/`，由 sync 写入全局指令文件。

## 安装与检查

需要 **Node.js ≥22.20.0、npm/npx、Git 和 curl**。远程安装不需要克隆仓库或发布 npm 包；以下地址在文件推送到公开可访问的 GitHub `main` 后可用。

```powershell
$env:HTTP_PROXY = 'http://127.0.0.1:7890'
$env:HTTPS_PROXY = 'http://127.0.0.1:7890'
$env:ALL_PROXY = 'http://127.0.0.1:7890'
cmd /d /c "curl.exe -fsSL https://raw.githubusercontent.com/Charbddlie/everything-harness/main/sync.mjs | node --input-type=module -"
```

Linux / macOS：

```sh
export http_proxy=http://127.0.0.1:7890
export https_proxy=http://127.0.0.1:7890
export all_proxy=http://127.0.0.1:7890
curl -fsSL https://raw.githubusercontent.com/Charbddlie/everything-harness/main/sync.mjs | node --input-type=module -
```

每次运行都会覆盖安装开启自动同步的 skill，并覆盖更新开启的指令片段。内容单向发布：修改本地仓库 → commit / push → 运行 sync → 覆盖本机安装内容。本机正文修改会被远程替换，本机 JSON 仅保存开关和目标选择。

所有命令使用远程 `main` 的清单。顶层 `agents` 统一设置所有 skill 和片段的目标，支持 **Codex 和 GitHub Copilot**，默认包含两者，本机可覆盖。目标由配置明确指定，不根据本机已安装的应用自动选择。

- 普通运行对生效 `auto_sync=true` 的 skill 按来源分组，调用 `skills add`，覆盖安装到全部生效 agents。自有和第三方 skill 使用相同流程。
- `deleted=true` 的条目会先提示再自动清理，删除状态优先于本机开关。Skill 通过 CLI 删除，片段移除完整标记块；删除记录继续保留。
- 覆盖安装会替换安装目录中的本地修改；源码应在源仓库维护，凭据和本机配置应放在安装目录之外。
- 安装后，运行本次选中的所有 skill 的 `dryrun.mjs`。环境错误逐项显示，全部检查后以非零状态退出；已安装内容保留。
- `--dryrun` 检查开启自动同步的 skill 环境，以及片段正文和目标标记；检查期间安装内容保持原样。
- 无 dryrun 的纯说明 skill 会跳过检查。自有 skill 包含脚本却缺少 dryrun 会报错；第三方若提供 `dryrun.mjs`，同样执行。
- 来源冲突会在安装前报错；旧安装器留下的无来源记录允许通过显式安装接管。

安装使用 `skills` 的原生共享目录规则。Codex 和 Copilot 共用 `~/.agents/skills` 中的一份实体 skill 文件，内容可能同时对两者可见。目录选择、下载、安装和锁文件均交给 `skills`；同步脚本不比较内容哈希。已有父目录软链接保持原状，迁移目录需单独处理。

## 增加、删除和列出清单

在远程命令中 node 的参数末尾追加 `--add`、`--del` 或 `--list`（Windows 放在外层双引号内）。增加和删除会自动获取仓库、修改清单、commit 并 push，无需手动操作 Git。电脑须已配置 Git 提交身份和该仓库的 GitHub 写入权限。

通过 `skill-manage` 操作时，若要求没有明确仅本机还是远程，必须先询问确认；“本地的 skill”也可能指要发布到远程的源码。

Windows PowerShell（Linux / macOS 去掉外层 `cmd /d /c "…"`，将 `curl.exe` 换成 `curl`）：

```powershell
# 为生效 agents 增加第三方 skill
cmd /d /c "curl.exe -fsSL https://raw.githubusercontent.com/Charbddlie/everything-harness/main/sync.mjs | node --input-type=module - --add owner/repo skill-name"

# 删除生效 agents 中的安装，保留远程删除记录
cmd /d /c "curl.exe -fsSL https://raw.githubusercontent.com/Charbddlie/everything-harness/main/sync.mjs | node --input-type=module - --del skill-name"

# 查看清单
cmd /d /c "curl.exe -fsSL https://raw.githubusercontent.com/Charbddlie/everything-harness/main/sync.mjs | node --input-type=module - --list"
```

`--add owner/repo skill-one skill-two` 可一次增加多个 skill，新条目默认 `auto_sync=true`，已有条目保留原开关。`--del skill-one skill-two` 删除生效 agents 中的安装后，移除 eh 仓库中的对应自有 skill 目录，仅在 `harness.json` 保留名称、来源和删除记录（`deleted=true`、`auto_sync=false`）。第三方来源仓库保持不变。

`--list` 显示远程、本机和生效 agents，以及每个条目的开关、删除状态和 Skill 来源。本机没有覆盖时显示“跟随远程”；删除记录始终显示。`--dryrun` 预告清理，但不执行删除。

脚本在临时目录获取最新 `main`，先尝试 HTTPS，失败后尝试 SSH，沿用已有 GitHub 认证。本机安装和 dryrun 成功后才写入清单；删除后会重新检查 CLI 状态，确认目标已移除。随后提交 `harness.json` 并推送；删除操作同时提交对应自有 skill 目录或片段 Markdown 文件的删除，成功后清理临时副本。

失败后按提示修复并重新运行同一条命令，脚本自动重新获取清单、补齐操作和提交推送。已完成的本机操作保留；commit 或 push 失败时保留操作副本并显示路径。远程发生并发改动时正常拒绝推送，不强推，不修改用户现有工作区。

删除按生效 agents 执行，共享目录是否保留由 CLI 根据本机 agent 检测结果决定。如果 CLI 因其他 agent 仍在使用而保留目标目录，且目标仍可访问它，删除检查会报错，不创建清单 commit。

普通同步不会自动清理清单外的 skill；手动移除但仍开启自动同步的项目会在下次同步时补回。`--add`、`--del`、`--auto_sync`、`--add_agents`、`--del_agents`、`--list`、`--dryrun` 互斥。

## 全局 agents

可设置的名称为 `codex`、`github-copilot`，一次可传多个。所有 skill 和片段使用同一份目标列表，不设置单条记录的 agents。

```powershell
# 修改远程全局 agents：自动 commit / push
cmd /d /c "curl.exe -fsSL https://raw.githubusercontent.com/Charbddlie/everything-harness/main/sync.mjs | node --input-type=module - --add_agents codex github-copilot"

# 本机只使用 Codex（基于默认的两个目标）
cmd /d /c "curl.exe -fsSL https://raw.githubusercontent.com/Charbddlie/everything-harness/main/sync.mjs | node --input-type=module - --local --del_agents github-copilot"

# 将 Copilot 加回本机目标
cmd /d /c "curl.exe -fsSL https://raw.githubusercontent.com/Charbddlie/everything-harness/main/sync.mjs | node --input-type=module - --local --add_agents github-copilot"
```

这两个选项只修改配置，下次同步生效，不立即安装或卸载。带 `--local` 时，从当前生效列表增删后，将完整列表保存到本机 `~/.everything-harness/harness.json` 顶层 `agents`，覆盖远程列表；不带时只改远程列表，本机覆盖保持不变。移除本机 `agents` 字段即可恢复跟随远程。重复添加或删除同一个目标不会重复记录。

`agents: []` 表示没有目标，普通同步和 dryrun 都会跳过。此时 skill 的 add/del 会提示先设置 agent，不修改安装或 skill 清单。

## 自动同步与本机选择

远程 `harness.json` 的 `auto_sync` 是默认值。每次同步读取 `~/.everything-harness/harness.json`：同一数组中同名条目的开关覆盖远程默认，缺省跟随远程。首次创建 `{"skills":[],"agents-md":[]}`，agents 和开关均跟随远程。Skill 来源、片段正文和删除状态始终取远程；删除标记优先于本机开关。

当本机新文件缺失时，自动合并旧 `skills.json` 与 `agents-md.json` 中的开关和全局 agents，保留旧文件作备份。`--list`、`--dryrun` 只读取迁移结果，普通同步或本机设置命令保存到 `harness.json`。新文件存在后只使用新文件。

本机旧 `harness.json` 的 `fragments` 字段自动迁入 `agents-md`，保留已有开关；同步或本机设置操作保存新字段，`--list`、`--dryrun` 保持只读。同时存在两个字段时，需先手动合并到 `agents-md`。命令行片段选项仍为 `--fragments`。

在同一个远程入口后加参数即可操作。以下命令仍使用远程脚本，无需下载其他脚本：

```powershell
# 关闭 paper-read 的远程默认自动同步：自动 commit / push
cmd /d /c "curl.exe -fsSL https://raw.githubusercontent.com/Charbddlie/everything-harness/main/sync.mjs | node --input-type=module - --auto_sync false paper-read"

# 只在本机安装 paper-read，dryrun 成功后保存 auto_sync=true
cmd /d /c "curl.exe -fsSL https://raw.githubusercontent.com/Charbddlie/everything-harness/main/sync.mjs | node --input-type=module - --local --add paper-read"

# 只在本机删除 paper-read，成功后保存 auto_sync=false，后续同步不会装回
cmd /d /c "curl.exe -fsSL https://raw.githubusercontent.com/Charbddlie/everything-harness/main/sync.mjs | node --input-type=module - --local --del paper-read"

# 只修改本机开关，保留当前安装
cmd /d /c "curl.exe -fsSL https://raw.githubusercontent.com/Charbddlie/everything-harness/main/sync.mjs | node --input-type=module - --local --auto_sync false paper-read"
```

将 `false` 换成 `true` 即开启。`--auto_sync` 只修改开关，不安装或删除；设为 true 后，下次同步才补齐。本机操作不需要 GitHub 写入权限，也不提交仓库。`--local` 可放在 node 参数末尾（Windows 外层双引号内）；普通同步始终考虑本机覆盖，`--list` 始终同时展示远程和本机状态。

本机 add/del 只接收远程清单已有的 skill 名称，支持一次多个，使用生效的全局 agents。开关按整个 skill 生效。失败时不修改本机配置，修复后重跑原命令。

## 内容与开发约定

### AGENTS.md 片段

片段及默认同步开关：

| 片段 | 内容 | auto_sync |
| --- | --- | --- |
| [win-dir](agents-md/win-dir.md) | Windows 项目位置、conda 环境和启动入口 | false |
| [formula-display](agents-md/formula-display.md) | CLI Unicode 与文件 LaTeX 格式 | true |
| [simple-dev](agents-md/simple-dev.md) | 直接实现、按实际需求增加复杂度、验证后结束 | true |
| [simple-doc](agents-md/simple-doc.md) | 文档与注释约定 | true |
| [instruction](agents-md/instruction.md) | 指令约束 | true |

`simple-dev` 提炼自 [Stop That Shit](https://github.com/lennney/stop-that-shit) 的决策原则。片段使用纯 Markdown，无需 Skill frontmatter。

统一的远程 `harness.json` 示例：

```json
{
  "agents": ["codex", "github-copilot"],
  "skills": [
    { "name": "dev-directory", "source": "Charbddlie/everything-harness", "auto_sync": false, "deleted": true },
    { "name": "formula-display", "source": "Charbddlie/everything-harness", "auto_sync": false, "deleted": true }
  ],
  "agents-md": [
    { "name": "dev-directory", "auto_sync": false, "deleted": true },
    { "name": "win-dir", "auto_sync": false },
    { "name": "formula-display", "auto_sync": true },
    { "name": "simple-dev", "auto_sync": true }
  ]
}
```

片段记录只有 `name`、`auto_sync` 和可选的 `deleted`，无 `source` 或独立 agents。正文始终读取 eh 远程 `main` 的 `agents-md/<name>.md`；本机开关存放在同一个 `harness.json` 的 `agents-md` 数组。

片段沿用 `harness.json` 的生效全局 agents：

| 目标 | 默认指令文件 | 路径覆盖 |
| --- | --- | --- |
| Codex | `~/.codex/AGENTS.md` | `$CODEX_HOME/AGENTS.md` |
| GitHub Copilot CLI | `~/.copilot/copilot-instructions.md` | `$COPILOT_HOME/copilot-instructions.md` |

每次 sync 原位覆盖同名标记块，新片段按清单顺序追加；块外手写内容保留。标记格式错误时先报错，修复后重试。

```markdown
<!-- eh:simple-dev:start -->
片段正文
<!-- eh:simple-dev:end -->
```

在远程入口后追加以下参数即可修改开关：

- `--fragments --auto_sync false simple-dev`：改远程默认并 commit / push。
- `--local --fragments --auto_sync false simple-dev`：只改本机覆盖。
- `--fragments --del NAME`：删除本机块和仓库中的 `agents-md/<name>.md`，标记远程删除并一并 commit / push。
- `--local --fragments --del NAME`：删除本机块并保存本机开关为 false。
- 将 `false` 改为 `true` 即开启，下次 sync 更新正文。
- `--list` 同时显示 Skill 和片段开关；`--dryrun` 检查选中的片段及已有目标标记。

关闭同步保留已有片段。新增片段时在源码仓库添加 Markdown 和清单记录，发布后运行 sync。

`dev-directory` 片段已改名为 `win-dir`，默认 `auto_sync=false`，需要时显式开启。旧片段及同名 Skill 的删除记录长期保留，sync 会清理旧内容；`formula-display` 片段保持开启。

### 删除与改名

Skill 和片段使用相同规则：

- 删除：移除整个自有 `skills/<name>/` 目录或 `agents-md/<name>.md` 文件，仅在 `harness.json` 保留原 entry，设置 `deleted=true`、`auto_sync=false`。第三方来源仓库保持不变，`--local` 保留仓库源码。
- 已标记删除的条目可再次执行远程删除，以清理残留源码；删除内容可从 Git 历史恢复。
- 改名：将旧 entry 标记删除，再创建新名称的 entry 并移动正文；Skill 同时更新 frontmatter 的 `name`。
- Sync 在生效 agents 内提示并删除旧项，再按新 entry 的开关更新新项。删除标记优先于本机开关，记录长期保留。
- 安装或开关命令不能重新启用已删除名称；清单外内容保持原样。

### Skills

每个 skill 一条记录，无来源类型或版本管理层：

```json
{
  "agents": ["codex", "github-copilot"],
  "skills": [
    {
      "name": "paper-read",
      "source": "Charbddlie/everything-harness",
      "auto_sync": false
    }
  ]
}
```

来源使用 GitHub `owner/repo`；名称全局唯一，使用小写字母、数字和单个连字符，最多 64 字符。自有目录名与 `SKILL.md` 中的 `name` 保持一致。

```text
skills/copilot-api/
  SKILL.md
  dryrun.mjs
  scripts/copilot-api.bat
  scripts/copilot-api.sh
skills/paper-add/
  SKILL.md
  dryrun.mjs
  scripts/zotero_add.py
skills/paper-read/
  SKILL.md
  dryrun.mjs
  scripts/mineru_parse.py
  scripts/zotero_link.py
skills/zotero-init/
  SKILL.md
skills/skill-manage/
  SKILL.md
harness.json
agents-md/
  win-dir.md
  formula-display.md
  simple-dev.md
sync.mjs
tests/
AGENTS.md
```

自有 skill 包含脚本时，须在 skill 根目录提供 `dryrun.mjs`；纯说明 skill 无需添加。Dryrun 只检查环境和必要配置，不执行实际业务操作，错误由各个 skill 自行说明。

`copilot-api` 替代原本的 `claude-init`，远程 `auto_sync=true`，默认安装技能说明及启动脚本模板。支持检查环境、启动和初始化；「启动 copilotapi」也会触发。检查模式报告状态，启动时复用已有环境，缺少网关时执行初始化。初始化后，若本机未配置 Codex，则询问是否配置；若网关有 Claude 模型且本机未安装 Claude Code，则询问是否安装并配置。安装 skill 本身仅检查 Node.js 与 npm。Windows 模板使用兼容 GBK 的 ASCII / CRLF，macOS / Linux 模板使用 LF。

`win-dir` 和 `formula-display` 的常驻规则通过片段同步。

`paper-add`、`paper-read` 和 `zotero-init` 从本机技能迁入。前两者保留 Python 标准库脚本，使用 Windows conda base（`~\miniconda3\python.exe`）；各自的 `dryrun.mjs` 检查 Zotero 路径与凭据，`paper-read` 还检查 MinerU 密钥。`zotero-init` 是初始化说明，不需要检查脚本。`key.env` 不分发，推荐用环境变量提供 `MINERU_API_KEY`；Zotero 凭据支持环境变量或现有 Claude MCP 配置。初始化说明当前针对 Claude Code，跨 agent 安装不自动注册 MCP。

这三个 skill 的远程 `auto_sync` 默认为 `false`；已安装的本机副本仍可用，关闭自动同步不会禁用或卸载它们。`pdf-analyze` 已退出使用清单，历史源码仍保留。

例如检查 `paper-read`：

```sh
node skills/paper-read/dryrun.mjs
```

解析命令和参数见该 skill 的 `SKILL.md`。根目录 `AGENTS.md` 仅用于本仓库开发，不对外分发。Skill 源代码变更通过正常 Git 提交和推送发布，然后运行远程同步入口。

## 验证

离线测试无需安装项目依赖，包括临时 Git 仓库中的 commit / push 流程：

```sh
node --test
```

真实 CLI 测试默认跳过。显式开启后会使用临时用户目录、临时 Git 测试源和仓库 `.tmp/` 下的 npm 缓存，验证真实安装、dryrun、更新和删除。Git 源替换仅作用于测试子进程，不修改个人 harness 或 Git 配置；首次获取 skills CLI 仍需联网：

```powershell
$env:SKILLS_INTEGRATION = '1'
node --test
Remove-Item Env:SKILLS_INTEGRATION
```

```sh
SKILLS_INTEGRATION=1 node --test
```

发布前检查 `git diff --check`、`git status --short` 和暂存内容，确认没有本机环境、缓存或数据库文件。

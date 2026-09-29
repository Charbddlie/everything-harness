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

内容单向发布：修改本地仓库 → commit / push → 运行 sync → 覆盖本机安装内容。选中内容来自远程 main，本机配置保存规则成员覆盖与目标选择。完整操作规范见 [skill-manage](skills/skill-manage/SKILL.md)。

## 添加与删除

`--add` 只接收一个或两个参数：

```text
--add <type>:<name>
--add <owner>/<repo> skill:<name>
```

一个参数时，名称使用 `skill:`、`agents-md:` 或 `rule:` 前缀。自有 skill 默认来源为 `Charbddlie/everything-harness`，只需要一个参数。两个参数时，第一个是 GitHub 来源，第二个是完整 skill 类型名称。片段和规则使用单参数；批量添加由规则成员列表完成。

```text
--add skill:skill-manage
--add owner/repo skill:example
--add agents-md:win-dir
--add rule:learn

--del skill:example
--del agents-md:win-dir
--del rule:learn
--del skill:foo agents-md:bar
```

在远程入口的 node 参数末尾追加操作，Windows 放在外层双引号内。例如在本机安装 learn 组：

```powershell
cmd /d /c "curl.exe -fsSL https://raw.githubusercontent.com/Charbddlie/everything-harness/main/sync.mjs | node --input-type=module - --local --add rule:learn"
```

带 `--local` 时，操作本机安装并保存规则成员覆盖；省略时，修改远程清单并 commit / push。用户未明确范围时，先确认具体范围。远程操作需要 Git 提交身份和仓库写入权限。

新增自有内容前，先将 `skills/<name>/` 或 `agents-md/<name>.md` 发布到 eh main。本机 add 仅接收远程活动清单已有内容。远程新增单项默认加入 auto；已有内容保留当前规则分组。

规则 del 展开全部远程成员，跳过规则条件与 skill 测试，保留来源、共享安装移除确认和片段标记校验。远程删除将活动条目移入 deleted 并移除自有源码；本机删除保留远程内容。

远程管理使用临时 Git 副本，先尝试 HTTPS，再尝试 SSH，沿用已有认证。提交前校验 Git 身份，本机操作成功后才提交清单与自有源码删除。正常 push；并发修改引起的推送拒绝需重试。用户工作区保持原状，commit / push 失败保留操作副本并提示路径。

## 同步规则

自动同步成员关系统一放在顶层 `sync-rules`，每项为规则名及 `[{"type_name":"skill:NAME"}]` 或片段名称的列表。每个规则在 `sync.mjs` 注册对应回调，复用检测函数。

| 规则 | 检测条件 | 当前成员 |
| --- | --- | --- |
| auto | 无额外条件 | copilot-api、skill-manage；formula-display、simple-dev、simple-doc、instruction 片段 |
| win | Windows | win-dir 片段 |
| learn | Windows 且通过 add 显式调用 | paper-add、paper-read、zotero-init |

普通 sync 按清单顺序逐条走 `--add rule:<name>` 的同一规划与执行入口，上下文标记为非显式。Windows 的普通 sync 会执行 auto 和 win；learn 需在 Windows 上显式调用 add。条件未满足时跳过该规则，已有安装保留。

调用顺序为：规则回调 → 检测函数 → 本批全部 skill 的 dryrun → 批量安装。

测试前通过 `npx skills` 在临时项目准备源码，逐个执行所有相关 `dryrun.mjs`；全部通过后才覆盖正式安装并写入片段。临时目录始终清理。测试失败时保留本批正式安装和原配置，普通 sync 继续检查后续规则并汇总错误。正式安装失败时保留已完成操作，修复后重跑。

单条内容 add 复用同一个测试与安装执行器。Skill 按来源分组安装，清单外内容保留。自有 skill 包含脚本时必须有 dryrun，第三方存在此入口时同样检查，纯说明 skill 可跳过。

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

## 本机规则覆盖与迁移

本机 `~/.everything-harness/harness.json` 首次创建为：

```json
{ "sync-rules": {} }
```

本机每条规则整份覆盖同名远程成员列表。空列表暂停该组在普通 sync 中的加载，保留已有安装；删除本机规则键恢复跟随远程。本机可另有顶层 agents，正文、来源和 deleted 始终取远程。

```json
{
  "agents": ["codex"],
  "sync-rules": {
    "auto": [{ "type_name": "skill:skill-manage" }],
    "win": []
  }
}
```

`--local --add rule:NAME` 使用远程完整成员，成功后恢复本机该组；`--local --del rule:NAME` 删除整组安装并从本机生效规则移除成员。普通 sync 始终重新检查条件，learn 保持显式调用要求。本机已删除或清单外成员引用不会触发安装。

旧本机 `skills` / `skill`、`fragments` / `agents-md` 中的 `auto_sync` 迁入规则覆盖：true 沿用远程所属规则，未分组内容进入 auto；false 从生效规则移除。新文件缺失时合并旧 `skills.json`、`agents-md.json` 并保留备份。新旧配置存在歧义时先报错。列表和预检只读取迁移结果，成功同步或本机操作后保存新配置。

`--auto_sync true|false type:name` 保留为兼容入口，通过规则成员调整选择，保留已有安装。活动内容条目中没有 `auto_sync` 字段。

`--list` 展示内容来源、规则成员、目标和删除记录，保持只读。`--dryrun` 以普通 sync 的非显式上下文检测规则，在临时目录运行 skill 测试，保留个人安装和配置。

## 内容与开发约定

### AGENTS.md 片段

片段及所属规则：

| 片段 | 内容 | 规则 |
| --- | --- | --- |
| [win-dir](agents-md/win-dir.md) | Windows 项目位置、conda 环境和启动入口 | win |
| [formula-display](agents-md/formula-display.md) | CLI Unicode 与文件 LaTeX 格式 | auto |
| [simple-dev](agents-md/simple-dev.md) | 直接实现、按实际需求增加复杂度、验证后结束 | auto |
| [simple-doc](agents-md/simple-doc.md) | 文档与注释约定 | auto |
| [instruction](agents-md/instruction.md) | 指令约束 | auto |

`simple-dev` 提炼自 [Stop That Shit](https://github.com/lennney/stop-that-shit) 的决策原则。片段使用纯 Markdown，无需 Skill frontmatter。

统一的远程 `harness.json` 示例：

```json
{
  "agents": ["codex", "github-copilot"],
  "skill": [
    { "name": "skill-manage", "source": "Charbddlie/everything-harness" },
    { "name": "paper-read", "source": "Charbddlie/everything-harness" }
  ],
  "agents-md": [{ "name": "win-dir" }],
  "sync-rules": {
    "auto": [{ "type_name": "skill:skill-manage" }],
    "win": [{ "type_name": "agents-md:win-dir" }],
    "learn": [{ "type_name": "skill:paper-read" }]
  },
  "deleted": [
    { "type_name": "skill:dev-directory", "source": "Charbddlie/everything-harness" },
    { "type_name": "agents-md:dev-directory" }
  ]
}
```

活动 skill 使用 `name` 和 `source`，活动片段使用 `name`。正文固定读取 eh main 的 `agents-md/<name>.md`。规则只能引用活动内容，禁止嵌套规则。同一类型名称在活动数组和 deleted 中互斥。

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

片段使用 `--add agents-md:NAME` 和 `--del agents-md:NAME` 管理，可加 `--local` 操作本机。规则未选中的片段块保持原样。新增片段时先发布正文，再通过 add 加入清单。

`dev-directory` 已改名为 `win-dir`，归入 win 规则。旧片段及同名 skill 的删除记录长期保留，sync 自动清理旧内容。

### 删除与改名

Skill 和片段使用相同规则：

- 删除：移除整个自有 `skills/<name>/` 目录或 `agents-md/<name>.md` 文件，将活动 entry 移入顶层 `deleted`。Skill 删除记录保留 `type_name` 和 `source`，片段删除记录保留 `type_name`。第三方来源仓库保持不变，`--local` 保留仓库源码。
- 已标记删除的条目可再次执行远程删除，以清理残留源码；删除内容可从 Git 历史恢复。
- 改名：将旧 entry 移入 `deleted`，再创建新名称的 entry 并移动正文；Skill 同时更新 frontmatter 的 `name`。
- Sync 在生效 agents 内提示并删除旧项，再按规则检测结果更新新项。删除记录优先于本机规则覆盖，记录长期保留。
- 安装或开关命令不能重新启用已删除名称；清单外内容保持原样。

过时条目由 eh 的 `deleted` 清单识别；`skills list` 提供本机安装及来源信息，`skills remove` 执行卸载。Skill 的 `source` 用于校验，来源冲突时停止清理，保留同名安装。

### Skills

每个 skill 一条记录，无来源类型或版本管理层：

```json
{
  "agents": ["codex", "github-copilot"],
  "skill": [
    {
      "name": "paper-read",
      "source": "Charbddlie/everything-harness"
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

`copilot-api` 默认安装技能说明及启动脚本模板。支持检查环境、启动和初始化；「启动 copilotapi」也会触发。检查模式报告状态，启动时复用已有环境，缺少网关时执行初始化。初始化后，若本机未配置 Codex，则询问是否配置；若网关有 Claude 模型且本机未安装 Claude Code，则询问是否安装并配置。安装 skill 本身仅检查 Node.js 与 npm。Windows 模板使用兼容 GBK 的 ASCII / CRLF，macOS / Linux 模板使用 LF。

`win-dir` 和 `formula-display` 的常驻规则通过片段同步。

`paper-add`、`paper-read` 和 `zotero-init` 从本机技能迁入。前两者保留 Python 标准库脚本，使用 Windows conda base（`~\miniconda3\python.exe`）；各自的 `dryrun.mjs` 检查 Zotero 路径与凭据，`paper-read` 还检查 MinerU 密钥。`zotero-init` 是初始化说明，不需要检查脚本。`key.env` 不分发，推荐用环境变量提供 `MINERU_API_KEY`；Zotero 凭据支持环境变量或现有 Claude MCP 配置。初始化说明当前针对 Claude Code，跨 agent 安装不自动注册 MCP。

这三个 skill 归入 learn 规则，在 Windows 上显式调用 add 后安装。普通 sync 会保留已安装副本。`pdf-analyze` 已退出使用清单，历史源码仍保留。

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

真实 CLI 测试默认跳过。显式开启后会使用临时用户目录、临时 Git 测试源和仓库 `.tmp/` 下的 npm 缓存，验证临时源码检查、正式安装、更新和删除。Git 源替换仅作用于测试子进程，不修改个人 harness 或 Git 配置；首次获取 skills CLI 仍需联网：

```powershell
$env:SKILLS_INTEGRATION = '1'
node --test
Remove-Item Env:SKILLS_INTEGRATION
```

```sh
SKILLS_INTEGRATION=1 node --test
```

发布前检查 `git diff --check`、`git status --short` 和暂存内容，确认没有本机环境、缓存或数据库文件。

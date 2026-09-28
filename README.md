# Everything Harness

个人 skill 托管、使用清单与同步工具。自有内容放在 `skills/`，自有和第三方来源统一记录在 `skills.json`；本机安装、更新和删除交给系统的 `npx skills`。

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

在 node 命令末尾追加 `--update` 可覆盖更新（Windows 放在外层双引号内）：

```powershell
cmd /d /c "curl.exe -fsSL https://raw.githubusercontent.com/Charbddlie/everything-harness/main/sync.mjs | node --input-type=module - --update"
```

所有命令使用远程 `main` 的清单。顶层 `agents` 统一设置所有 skill 的目标，默认包含 **Codex、Claude Code 和 GitHub Copilot**；本机可覆盖。目标由配置明确指定，不根据本机已安装的应用自动选择。

- 普通运行只同步生效 `auto_sync=true` 的 skill，全局补齐缺失的 skill / agent 组合，已安装的跳过。
- `--update` 仅重装开启自动同步且匹配目标的 skill，不运行无范围限制的全局更新。
- 安装或更新后，运行本次选中的所有 skill 的 `dryrun.mjs`，包括已安装而跳过的 skill。环境错误逐项显示，全部检查后以非零状态退出；已安装内容保留。
- `--dryrun` 只检查开启自动同步的 skill，不安装、不更新；修复环境后可反复运行。
- 无 dryrun 的纯说明 skill 会跳过检查。自有 skill 包含脚本却缺少 dryrun 会报错；第三方若提供 `dryrun.mjs`，同样执行。
- 来源冲突会在安装前报错；旧安装器留下的无来源记录允许通过显式安装接管。

安装方式采用 `skills` 的默认行为，脚本不直接编辑 harness 配置、链接或 skills 锁文件。Codex 和 Copilot 共用 `~/.agents/skills`，所以内容可能同时对两者可见。脚本根据 CLI 返回的路径识别共享安装，避免应用配置目录尚不存在时反复安装。

## 增加、删除和列出清单

在远程命令中 node 的参数末尾追加 `--add`、`--del` 或 `--list`（Windows 放在外层双引号内）。增加和删除会自动获取仓库、修改清单、commit 并 push，无需手动操作 Git。电脑须已配置 Git 提交身份和该仓库的 GitHub 写入权限。

通过 `skill-manage` 操作时，若要求没有明确仅本机还是远程，必须先询问确认；“本地的 skill”也可能指要发布到远程的源码。

Windows PowerShell（Linux / macOS 去掉外层 `cmd /d /c "…"`，将 `curl.exe` 换成 `curl`）：

```powershell
# 为生效 agents 增加第三方 skill
cmd /d /c "curl.exe -fsSL https://raw.githubusercontent.com/Charbddlie/everything-harness/main/sync.mjs | node --input-type=module - --add owner/repo skill-name"

# 删除生效 agents 中的安装和远程清单记录
cmd /d /c "curl.exe -fsSL https://raw.githubusercontent.com/Charbddlie/everything-harness/main/sync.mjs | node --input-type=module - --del skill-name"

# 查看清单
cmd /d /c "curl.exe -fsSL https://raw.githubusercontent.com/Charbddlie/everything-harness/main/sync.mjs | node --input-type=module - --list"
```

`--add owner/repo skill-one skill-two` 可一次增加多个 skill，新条目默认 `auto_sync=true`，已有条目保留原开关。`--del skill-one skill-two` 同样支持多个名称，删除生效 agents 中的安装后移除清单记录。删除不影响 `skills/` 中的源代码。

`--list` 显示远程、本机和生效 agents，以及每个 skill 的来源、远程 `auto_sync`、本机 `auto_sync` 和生效 `auto_sync`。本机没有覆盖时显示“跟随远程”；不因开关为 false 隐藏条目。

脚本在临时目录获取最新 `main`，先尝试 HTTPS，失败后尝试 SSH，沿用已有 GitHub 认证。本机安装和 dryrun 成功后才写入清单；删除后会重新检查 CLI 状态，确认目标已移除。随后只提交 `skills.json` 并推送，成功后清理临时副本。

失败后按提示修复并重新运行同一条命令，脚本自动重新获取清单、补齐操作和提交推送。已完成的本机操作保留；commit 或 push 失败时保留操作副本并显示路径。远程发生并发改动时正常拒绝推送，不强推，不修改用户现有工作区。

删除按生效 agents 执行，共享目录是否保留由 CLI 根据本机 agent 检测结果决定。如果 CLI 因其他 agent 仍在使用而保留目标目录，且目标仍可访问它，删除检查会报错，不创建清单 commit。

普通同步不会自动清理清单外的 skill；手动移除但仍开启自动同步的项目会在下次同步时补回。`--add`、`--del`、`--auto_sync`、`--add_agents`、`--del_agents`、`--list`、`--update`、`--dryrun` 互斥。

## 全局 agents

可设置的名称为 `codex`、`github-copilot`、`claude-code`，一次可传多个。所有 skill 使用同一份目标列表，不设置单个 skill 的 agents。

```powershell
# 修改远程全局 agents：自动 commit / push
cmd /d /c "curl.exe -fsSL https://raw.githubusercontent.com/Charbddlie/everything-harness/main/sync.mjs | node --input-type=module - --add_agents codex github-copilot claude-code"

# 从远程默认目标移除 Claude Code
cmd /d /c "curl.exe -fsSL https://raw.githubusercontent.com/Charbddlie/everything-harness/main/sync.mjs | node --input-type=module - --del_agents claude-code"

# 本机只使用 Codex（基于默认的三个目标）
cmd /d /c "curl.exe -fsSL https://raw.githubusercontent.com/Charbddlie/everything-harness/main/sync.mjs | node --input-type=module - --local --del_agents github-copilot claude-code"

# 将 Claude Code 加回本机目标
cmd /d /c "curl.exe -fsSL https://raw.githubusercontent.com/Charbddlie/everything-harness/main/sync.mjs | node --input-type=module - --local --add_agents claude-code"
```

这两个选项只修改配置，下次同步生效，不立即安装或卸载。带 `--local` 时，从当前生效列表增删后，将完整列表保存到本机 `~/.everything-harness/skills.json` 顶层 `agents`，覆盖远程列表；不带时只改远程列表，本机覆盖保持不变。移除本机 `agents` 字段即可恢复跟随远程。重复添加或删除同一个目标不会重复记录。

`agents: []` 表示没有目标，普通同步、更新和 dryrun 都会跳过。此时 skill 的 add/del 会提示先设置 agent，不修改安装或 skill 清单。

## 自动同步与本机选择

远程 `skills.json` 的 `auto_sync` 是默认值。每次同步会读取 `~/.everything-harness/skills.json`：同名条目的 `auto_sync` 覆盖远程默认，没有本机条目就跟随远程。首次运行只创建 `{"skills": []}`，agents 和开关都跟随远程，以后不会覆盖已有选择。来源始终使用最新远程清单；从本机文件移除某个 skill 条目即可恢复其开关跟随远程。

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

每个 skill 一条记录，无来源类型或版本管理层：

```json
{
  "agents": ["claude-code", "codex", "github-copilot"],
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
skills.json
sync.mjs
tests/
AGENTS.md
```

自有 skill 包含脚本时，须在 skill 根目录提供 `dryrun.mjs`；纯说明 skill 无需添加。Dryrun 只检查环境和必要配置，不执行实际业务操作，错误由各个 skill 自行说明。

`copilot-api` 替代原本的 `claude-init`，远程 `auto_sync=true`，默认安装技能说明及启动脚本模板。调用时安装本地网关、引导登录，并按用户选择配置 Claude Code / Codex；安装 skill 本身只检查 Node.js 与 npm，不启动网关或改写客户端配置。Windows 模板使用兼容 GBK 的 ASCII / CRLF，macOS / Linux 模板使用 LF。

`paper-add`、`paper-read` 和 `zotero-init` 从本机技能迁入。前两者保留 Python 标准库脚本，使用 Windows conda base（`~\miniconda3\python.exe`）；各自的 `dryrun.mjs` 检查 Zotero 路径与凭据，`paper-read` 还检查 MinerU 密钥。`zotero-init` 是初始化说明，不需要检查脚本。`key.env` 不分发，推荐用环境变量提供 `MINERU_API_KEY`；Zotero 凭据支持环境变量或现有 Claude MCP 配置。初始化说明当前针对 Claude Code，跨 agent 安装不自动注册 MCP。

这三个 skill 的远程 `auto_sync` 默认为 `false`；已安装的本机副本仍可用，关闭自动同步不会禁用或卸载它们。`pdf-analyze` 已退出使用清单，历史源码仍保留。

例如检查 `paper-read`：

```sh
node skills/paper-read/dryrun.mjs
```

解析命令和参数见该 skill 的 `SKILL.md`。根目录 `AGENTS.md` 仅用于本仓库开发，不对外分发。Skill 源代码变更通过正常 Git 提交和推送发布，然后运行 `--update`。

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

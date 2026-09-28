# Everything Harness

个人 skill 托管、使用清单与同步工具。自有内容放在 `skills/`，自有和第三方来源统一记录在 `skills.json`；本机安装、更新和删除交给系统的 `npx skills`。

## 安装与检查

需要 **Node.js ≥22.20.0、npm/npx、Git 和 curl**。远程安装不需要克隆仓库或发布 npm 包；以下地址在文件推送到公开可访问的 GitHub `main` 后可用。

Windows PowerShell：

```powershell
curl.exe -fsSL https://raw.githubusercontent.com/Charbddlie/everything-harness/main/sync.mjs | node --input-type=module -
```

Linux / macOS：

```sh
curl -fsSL https://raw.githubusercontent.com/Charbddlie/everything-harness/main/sync.mjs | node --input-type=module -
```

在命令末尾追加 `--update` 可覆盖更新，追加 `--agents codex` 可筛选目标。两个参数可以组合，例如：

```powershell
curl.exe -fsSL https://raw.githubusercontent.com/Charbddlie/everything-harness/main/sync.mjs | node --input-type=module - --update --agents codex
```

所有命令使用远程 `main` 的清单。`--agents` 支持 `claude-code`、`codex`、`github-copilot`，只选择清单中适用于这些 agents 的 skill。

- 普通运行全局安装缺失的 skill / agent 组合，已安装的跳过。
- `--update` 仅重装清单内指定目标的 skill，不运行无范围限制的全局更新。
- 安装或更新后，运行本次清单内所有 skill 的 `dryrun.mjs`，包括跳过安装的 skill。环境错误逐项显示，全部检查后以非零状态退出；已安装内容保留。
- `--dryrun` 只检查已安装的 skill，不安装、不更新；修复环境后可反复运行。
- 无 dryrun 的纯说明 skill 会跳过检查。自有 skill 包含脚本却缺少 dryrun 会报错；第三方若提供 `dryrun.mjs`，同样执行。
- 来源冲突会在安装前报错；旧安装器留下的无来源记录允许通过显式安装接管。

安装方式采用 `skills` 的默认行为，脚本不直接编辑 harness 配置、链接或 skills 锁文件。Codex 和 Copilot 共用 `~/.agents/skills`，所以内容可能同时对两者可见。脚本根据 CLI 返回的路径识别共享安装，避免应用配置目录尚不存在时反复安装。

## 增加、删除和列出清单

在远程命令末尾追加 `--add`、`--del` 或 `--list`，均可搭配 `--agents`。增加和删除会自动获取仓库、修改清单、commit 并 push，无需手动操作 Git。电脑须已配置 Git 提交身份和该仓库的 GitHub 写入权限。

Windows PowerShell（Linux / macOS 将 `curl.exe` 换成 `curl`）：

```powershell
# 为 Codex 增加第三方 skill
curl.exe -fsSL https://raw.githubusercontent.com/Charbddlie/everything-harness/main/sync.mjs | node --input-type=module - --add owner/repo skill-name --agents codex

# 删除该 skill 的 Claude Code 安装和清单关联
curl.exe -fsSL https://raw.githubusercontent.com/Charbddlie/everything-harness/main/sync.mjs | node --input-type=module - --del skill-name --agents claude-code

# 查看 Codex 的清单
curl.exe -fsSL https://raw.githubusercontent.com/Charbddlie/everything-harness/main/sync.mjs | node --input-type=module - --list --agents codex
```

`--add owner/repo skill-one skill-two` 可一次增加多个 skill；省略 `--agents` 时选择全部三个。已有条目合并 agents。`--del skill-one skill-two` 同样支持多个名称；省略 `--agents` 时移除这些 skill 的全部关联，最后一个关联删除后才移除整条记录。删除不影响 `skills/` 中的源代码。`--list` 显示 skill、来源和 agents。

脚本在临时目录获取最新 `main`，先尝试 HTTPS，失败后尝试 SSH，沿用已有 GitHub 认证。本机安装和 dryrun 成功后才写入清单；删除后会重新检查 CLI 状态，确认目标已移除。随后只提交 `skills.json` 并推送，成功后清理临时副本。

失败后按提示修复并重新运行同一条命令，脚本自动重新获取清单、补齐操作和提交推送。已完成的本机操作保留；commit 或 push 失败时保留操作副本并显示路径。远程发生并发改动时正常拒绝推送，不强推，不修改用户现有工作区。

Codex 与 Copilot 不能独立卸载同一份共享内容：若清单仍给另一个保留关联，需同时选择 `--agents codex github-copilot`。如果 CLI 因其他 agent 仍在使用而保留目标目录，删除检查会报错，不创建清单 commit。

普通同步不会自动清理清单外的 skill；手动移除但仍在清单中的项目会在下次同步时补回。`--add`、`--del`、`--list`、`--update`、`--dryrun` 互斥。

## 内容与开发约定

每个 skill 一条记录，无来源类型或版本管理层：

```json
{
  "skills": [
    {
      "name": "pdf-analyze",
      "source": "Charbddlie/everything-harness",
      "agents": ["claude-code", "codex", "github-copilot"]
    }
  ]
}
```

来源使用 GitHub `owner/repo`；名称全局唯一，使用小写字母、数字和单个连字符，最多 64 字符。自有目录名与 `SKILL.md` 中的 `name` 保持一致。

```text
skills/pdf-analyze/
  SKILL.md
  dryrun.mjs
  scripts/mineru_parse.mjs
skills/skill-manage/
  SKILL.md
skills.json
sync.mjs
tests/
AGENTS.md
```

自有 skill 包含脚本时，须在 skill 根目录提供 `dryrun.mjs`；纯说明 skill 无需添加。Dryrun 只检查环境和必要配置，不执行实际业务操作，错误由各个 skill 自行说明。

`pdf-analyze` 使用 JavaScript，检查入口为：

```sh
node skills/pdf-analyze/dryrun.mjs
```

解析命令和参数见该 skill 的 `SKILL.md`。根目录 `AGENTS.md` 仅用于本仓库开发，不对外分发。Skill 源代码变更通过正常 Git 提交和推送发布，然后运行 `--update`。

## 代理与验证

子进程继承环境代理；例如 Windows PowerShell：

```powershell
$env:HTTP_PROXY = 'http://127.0.0.1:7890'
$env:HTTPS_PROXY = 'http://127.0.0.1:7890'
$env:ALL_PROXY = 'http://127.0.0.1:7890'
```

Linux / macOS：

```sh
export http_proxy=http://127.0.0.1:7890
export https_proxy=http://127.0.0.1:7890
export all_proxy=http://127.0.0.1:7890
```

代理不写死在代码中。curl、npm、Git 和 skills 自身的请求遵循各自的代理支持。

离线测试无需安装项目依赖，包括临时 Git 仓库中的 commit / push 流程：

```sh
node --test
```

真实 CLI 测试默认跳过。显式开启后会使用临时用户目录、仓库 `.tmp/` 下的 npm 缓存验证真实安装、dryrun、更新和删除，不修改个人 harness 配置：

```powershell
$env:SKILLS_INTEGRATION = '1'
node --test
Remove-Item Env:SKILLS_INTEGRATION
```

```sh
SKILLS_INTEGRATION=1 node --test
```

发布前检查 `git diff --check`、`git status --short` 和暂存内容，确认没有本机环境、缓存或数据库文件。

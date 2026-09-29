---
name: skill-manage
description: 管理 eh（everything-harness）的 skill 和 AGENTS.md 片段，使用远程 sync.mjs 设置全局 agents、调整远程或本机同步开关、查看状态和检查环境。
---

# Skill 管理

`eh` 是 `everything-harness` 的简称，用户指令中的 `eh` 均指本项目。

内容发布流程为：修改本地仓库 → commit / push 到远程 → 运行 sync → 单向覆盖本机安装内容。对选中同步的 skill 和片段，无条件以远程正文覆盖本机版本，不合并、不回传安装内容的修改；本机 JSON 仅保存同步开关和目标选择。用户要求先审阅或暂缓发布时，保留仓库改动，等待确认后发布。

执行增删或配置修改前，必须明确操作范围：仅本机（`--local`），还是远程清单（不带 `--local`，会 commit / push）。用户要求不明确时，先询问并等待确认，不能自行默认其中一种。“本地的 skill”可能指待上传的本机源码，不等于要求仅在本机安装或删除。

需要 Node.js ≥22.20.0、npm/npx、Git 和 curl。所有 skill 和片段共用一份 agents 设置，支持 `codex`、`github-copilot`，默认包含两者。

```powershell
cmd /d /c "curl.exe -fsSL https://raw.githubusercontent.com/Charbddlie/everything-harness/main/sync.mjs | node --input-type=module -"
```

Linux / macOS：

```sh
curl -fsSL https://raw.githubusercontent.com/Charbddlie/everything-harness/main/sync.mjs | node --input-type=module -
```

每次 sync 先提示并清理 `deleted=true` 的旧 Skill，再通过 `skills add` 覆盖安装开启 `auto_sync` 的 Skill；片段同时按删除标记清理或按开关覆盖。删除标记优先于本机开关。目录与锁文件由 `skills` 管理；源码在仓库维护，凭据和本机配置放在安装目录之外。

远程与本机均使用 `harness.json`，包含 `agents`、`skills`、`agents-md`。本机 `~/.everything-harness/harness.json` 的开关和顶层 agents 优先，缺省跟随远程；删除状态始终取远程。新文件缺失时迁入旧 `skills.json`、`agents-md.json` 的设置，旧文件保留作备份；新文件存在后只使用新文件。所有操作都用上面的远程命令，在 node 参数末尾追加选项（Windows 放在外层双引号内）：

- `--add owner/repo skill-name`：先安装并检查环境，成功后加入远程清单。
- `--del skill-name`：先删除本机安装，成功后删除 eh 仓库中的自有 skill 目录，仅在远程 `harness.json` 保留 entry 并设置 `deleted=true`、`auto_sync=false`。
- `--auto_sync false skill-name`：关闭远程自动同步；换成 `true` 即开启。只改开关，不安装或删除。
- `--local --add skill-name`：只在本机安装，环境检查成功后保存本机 `auto_sync=true`。
- `--local --del skill-name`：只在本机删除，成功后保存本机 `auto_sync=false`，下次同步不会装回。
- `--local --auto_sync false skill-name`：只改本机开关，保留当前安装；也支持 `true`。
- `--add_agents codex` / `--del_agents github-copilot`：增删远程全局目标，可一次传多个名称。
- `--local --add_agents codex` / `--local --del_agents github-copilot`：只改本机全局目标。
- `--list`：查看远程、本机和生效 agents，以及各条目的开关和删除状态。
- `--dryrun`：预告待删除项，检查开启的 skill 环境及片段正文、目标标记；保留安装内容。

不带 `--local` 的 skill 增删、agents 增删和开关修改会自动 commit / push，需要 Git 提交身份和该仓库的 GitHub 写入权限。带 `--local` 只保存本机设置，不操作 Git。失败后按提示修复，再运行同一条命令。

skill 增加、删除均使用生效的全局 agents，开关按整个 skill 生效。本机 add 只接收已在远程清单中的名称。
远程删除自有 skill 时，将整个 `skills/<name>/` 的删除与清单改动一并提交；第三方来源仓库保持不变。`--local --del` 保留仓库源码和远程清单。

agents 增删只保存配置，下次同步生效，已有安装保留。本机首次修改从当前生效列表增删，保存后整份列表覆盖远程；移除本机 `harness.json` 顶层 `agents` 字段即可恢复跟随远程。空列表会暂停同步和 dryrun，skill add/del 会提示先添加 agent。Codex 和 Copilot 共用 `~/.agents/skills`，内容可能对两者都可见。

## AGENTS.md 片段

正文放在 `agents-md/<name>.md`，记录放在 `harness.json` 的 `agents-md` 数组，字段为 `name`、`auto_sync` 和可选 `deleted`。片段无 `source`，与 skills 共用顶层 agents。

本机旧 `fragments` 字段自动迁入 `agents-md`，保留开关；同步或本机设置操作保存新字段，列表和预检保持只读。两个字段同时存在时，先合并到 `agents-md` 再重试。命令行选项保持 `--fragments`。

- 同一同步入口覆盖更新开启的片段，使用生效的全局 agents。Codex 目标为 `$CODEX_HOME/AGENTS.md`（默认 `~/.codex/AGENTS.md`）；Copilot 目标为 `$COPILOT_HOME/copilot-instructions.md`（默认 `~/.copilot/copilot-instructions.md`）。
- `--fragments --auto_sync false simple-dev` 修改远程开关并 commit / push；加 `--local` 只改本机开关。改为 `true` 即开启，下次同步生效。
- `--fragments --del NAME` 清理本机标记块后，删除仓库中的 `agents-md/<name>.md`，将远程 entry 标记删除并一并 commit / push；加 `--local` 只清理本机并保存 `auto_sync=false`。
- 同步原位替换 `<!-- eh:<name>:start -->` 与 `<!-- eh:<name>:end -->` 之间的正文，删除项移除整个块，保留块外内容。关闭同步保留已有块。
- `win-dir` 片段默认关闭同步，开启后提供 Windows 目录约定。`dev-directory` 旧片段及同名 Skill 已标记删除，sync 自动清理旧内容；`formula-display`、`simple-dev` 片段默认开启。

## 删除与改名

Skill 和片段都只在 `harness.json` 保留删除记录：删除自有 skill 时移除整个 `skills/<name>/`，删除片段时移除 `agents-md/<name>.md`，给旧 entry 设置 `deleted=true`、`auto_sync=false`；改名时再创建新名称的 entry，并移动正文、更新 Skill 的 frontmatter。Sync 提示并删除旧项，按新项开关安装新项。删除记录长期保留，安装和开关命令无法重新启用旧名称。已标记删除的条目可再次执行远程删除，以清理残留源码；删除内容可从 Git 历史恢复。手动维护正文与清单时，在本地仓库修改，发布后再同步。

例如，增加一个 skill：

```powershell
cmd /d /c "curl.exe -fsSL https://raw.githubusercontent.com/Charbddlie/everything-harness/main/sync.mjs | node --input-type=module - --add owner/repo skill-name"
```

只在本机删除一个 skill：

```powershell
cmd /d /c "curl.exe -fsSL https://raw.githubusercontent.com/Charbddlie/everything-harness/main/sync.mjs | node --input-type=module - --local --del skill-name"
```

从默认两个目标中，只为本机保留 Codex：

```powershell
cmd /d /c "curl.exe -fsSL https://raw.githubusercontent.com/Charbddlie/everything-harness/main/sync.mjs | node --input-type=module - --local --del_agents github-copilot"
```

修改用户自有 skill 时，先克隆源码仓库：`git clone git@github.com:Charbddlie/everything-harness.git`；已有本地仓库则复用。
在 `skills/<skill-name>/` 中修改内容；涉及脚本时同步维护 `dryrun.mjs`。
将本机 skill 发布到远程时，只迁入说明、脚本和必要资源，不提交 `key.env`、密钥、缓存或本机配置。先推送源码，再用 `--add Charbddlie/everything-harness skill-name` 安装并加入远程清单。
完成后提交并推送，再运行远程入口同步安装。
